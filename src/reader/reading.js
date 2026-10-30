const fs = require("fs");
const path = require("path");
const { By, until, Key, error: webdriverErrors } = require("selenium-webdriver");
const { clickOrThrow, findElementsWithin, isSessionLost, randomBetween, sleep, throwIfStopped } = require("./dom");
const { READ_FINISHED_TITLE_TEXT, XPATH, parseBookTitle } = require("./selectors");
const { formatDuration } = require("./timing");

// 截图小于该大小视为白屏并刷新页面；正文由 canvas 绘制，无法通过 DOM 文本判断
const BLANK_SCREENSHOT_BYTES = 100 * 1024;

// 读完或需要打开书籍时连续这么多轮都没能通过目录回到开头，就按出错结束：一直停在原处不翻动，不能当作正常阅读
const MAX_JUMP_FAILURES = 3;

// 章节切换、页面局部重绘时常见的瞬时错误：连续出现不超过该次数时跳过这一轮，继续阅读
const MAX_TRANSIENT_ERRORS = 3;
const TRANSIENT_ERROR_TYPES = [
  webdriverErrors.StaleElementReferenceError,
  webdriverErrors.JavascriptError,
  webdriverErrors.ElementClickInterceptedError,
  webdriverErrors.ElementNotInteractableError,
  webdriverErrors.NoSuchElementError,
];

function isTransientError(e) {
  return (
    TRANSIENT_ERROR_TYPES.some((type) => e instanceof type) ||
    /execution context was destroyed/i.test(String(e && e.message))
  );
}

// 一次往返读取阅读页状态
const PAGE_STATE_SCRIPT = `
  const xpaths = arguments[0];
  const find = (xpath) =>
    document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
  const inViewport = (el) => {
    if (!el || !el.getClientRects().length || getComputedStyle(el).visibility === "hidden") {
      return false;
    }
    const rect = el.getBoundingClientRect();
    return rect.top >= 0 && rect.left >= 0 && rect.bottom <= window.innerHeight && rect.right <= window.innerWidth;
  };
  return {
    title: document.title,
    unlockPrompt: !!find(xpaths.unlockPrompt),
    bookFinished: !!find(xpaths.bookFinished),
    nextVisible: inViewport(find(xpaths.nextButton)),
    retryShown: !!find(xpaths.retryButton),
  };
`;

async function pressDownArrow(driver) {
  await driver.actions().sendKeys(Key.ARROW_DOWN).perform();
  // keep the key pressed for random time between 50ms to 500ms
  await sleep(randomBetween(50, 500));
  // release the down arrow key
  await driver.actions().sendKeys(Key.NULL).perform();
}

// 页面处于左右翻页模式时切换到上下滚动阅读；已是上下滚动时找不到切换按钮，返回 false
async function switchToVerticalMode(driver, ctx) {
  const switchButton = await findElementsWithin(driver, XPATH.verticalModeButton, ctx.timing.elementWaitMs);
  if (switchButton.length === 0) {
    return false;
  }
  await clickOrThrow(driver, switchButton[0], "上下滚动阅读按钮");
  console.info("Switched to vertical scroll mode.");
  return true;
}

// 按选书方式打开书籍并切换到上下滚动阅读模式，返回书名（取不到时为空字符串）
async function openBook(driver, ctx) {
  const { config, timing } = ctx;

  let selection = Number(config.selection);
  if (selection === -1) {
    console.info("选书方式为直接打开默认阅读链接:", config.bookUrl);
    await driver.get(config.bookUrl);
  } else {
    if (selection === 0) {
      selection = randomBetween(1, 4);
    }
    // 刚登录时书架仍在加载，等到出现带链接的书籍卡片再点击
    const books = await findElementsWithin(driver, XPATH.shelfBookLink, timing.pageWaitMs);
    if (books.length > 0 && books.length < selection) {
      await clickOrThrow(driver, books[0], "书架第 1 本书");
    } else if (books.length >= selection) {
      await clickOrThrow(driver, books[selection - 1], `书架第 ${selection} 本书`);
    } else {
      console.warn("No book link found. Using the default link.");
      await driver.get(config.bookUrl);
    }
  }

  try {
    await driver.wait(until.elementLocated(By.xpath(XPATH.catalogButton)), timing.pageWaitMs);
  } catch (error) {
    if (error.name !== "TimeoutError") {
      throw error;
    }
    const where = await driver.getCurrentUrl().catch(() => "未知");
    throw new Error(`打开书籍后 ${formatDuration(timing.pageWaitMs)}内未出现阅读页的「目录」按钮，当前页面：${where}`);
  }

  if (!(await switchToVerticalMode(driver, ctx))) {
    console.warn("未找到用于切换为上下滚动阅读的按钮（兼容新老版本定位）");
  }

  await driver.wait(until.elementLocated(By.xpath(XPATH.catalogButton)), timing.pageWaitMs);
  console.info("Successfully switched to vertical scroll mode.");

  const title = parseBookTitle(await driver.getTitle());
  if (title) {
    console.info("正在阅读：", title);
  }
  return { title };
}

// 目录列表是否已经展开：已展开时再点目录按钮会把它关上
async function catalogOpen(driver) {
  const [first] = await driver.findElements(By.xpath(XPATH.catalogItem));
  return Boolean(first) && (await first.isDisplayed().catch(() => false));
}

// 打开目录回到书的开头附近；返回是否点到了目录中的章节
async function jumpToStart(driver, ctx) {
  if (!(await catalogOpen(driver))) {
    const catalogs = await driver.findElements(By.xpath(XPATH.catalogButton));
    if (catalogs.length === 0) {
      console.error("Catalog button not found.");
      return false;
    }
    await catalogs[0].click();
    console.info("Clicked on catalog button.");
  }

  // 当前章节带有选中样式，不在列表中。与旧版一样选第 2 项，目录只有一项时选这一项
  const chapters = await findElementsWithin(driver, XPATH.catalogItem, ctx.timing.elementWaitMs);
  if (chapters.length === 0) {
    console.error("Chapters not found.");
    return false;
  }
  await driver.executeScript("arguments[0].scrollIntoView();", chapters[0]);
  await (chapters[1] || chapters[0]).click();
  console.info("Clicked on first chapter.");
  return true;
}

// 每分钟截图一次并上报进度；截图过小时视为白屏并刷新页面
async function onReadingMinute(driver, ctx, minute) {
  const { config, paths, timing } = ctx;
  console.info("Reading minute: ", minute);
  const progress = { minute, total: Math.round(timing.durationMs / timing.minuteMs), screenshot: "" };
  if (!config.screenshot) {
    ctx.report("reading-minute", progress);
    return;
  }

  const screenshotPath = paths.screenshot(`screenshot-${minute}.png`);
  // 截图只用于在面板中查看进度与判断白屏：截图失败（页面重绘、磁盘已满等）时照常上报进度，不中断阅读
  let size;
  try {
    // 阅读截图属于阅读隐私，只允许属主读写
    fs.writeFileSync(screenshotPath, await driver.takeScreenshot(), { encoding: "base64", mode: 0o600 });
    size = fs.statSync(screenshotPath).size;
  } catch (e) {
    if (isSessionLost(e)) {
      throw e;
    }
    console.warn(`第 ${minute} 分钟截图失败:`, e.message);
    ctx.report("reading-minute", progress);
    return;
  }
  ctx.report("reading-minute", { ...progress, screenshot: path.basename(screenshotPath) });
  console.debug("Screenshot size: ", size / 1024, " KB");
  if (size < BLANK_SCREENSHOT_BYTES) {
    await driver.navigate().refresh();
    console.info("Page refreshed.");
    // 刷新后若回到左右翻页模式，按方向键无法翻动，需要重新切换
    await switchToVerticalMode(driver, ctx);
  }
}

// 阅读循环中的一轮：按页面状态跳回开头、点下一章 / 重试，否则按一次方向键。
// 需要跳回开头时返回是否成功（{ jumped }），其他情况返回 {}
async function readStep(driver, ctx) {
  const state = await driver.executeScript(PAGE_STATE_SCRIPT, XPATH);

  const jumpReasons = [];
  if (state.title.includes(READ_FINISHED_TITLE_TEXT)) {
    jumpReasons.push('标题包含 "已读完"');
  }
  if (state.unlockPrompt) {
    console.warn("需要打开书籍");
    jumpReasons.push("需要打开书籍");
  }
  if (state.bookFinished) {
    console.warn("书籍已读完");
    jumpReasons.push("书籍已读完");
  }
  if (jumpReasons.length > 0) {
    console.warn("needToJump = true, reasons: " + jumpReasons.join(" | "));
    return { jumped: await jumpToStart(driver, ctx), reasons: jumpReasons };
  }

  if (state.nextVisible) {
    const [nextButton] = await driver.findElements(By.xpath(XPATH.nextButton));
    if (nextButton) {
      await nextButton.click();
      console.info("Clicked on next chapter button.");
      return {};
    }
  }

  if (state.retryShown) {
    const [retryButton] = await driver.findElements(By.xpath(XPATH.retryButton));
    if (retryButton) {
      console.warn("Retry button found.");
      await retryButton.click();
      console.info("Clicked on retry button.");
      return {};
    }
  }

  await pressDownArrow(driver);
  console.debug("Pressed down arrow key.");
  return {};
}

// 按配置时长持续阅读：翻动、跳章、读完回到目录；返回实际阅读分钟数
async function readLoop(driver, ctx) {
  const { config, timing } = ctx;
  const [minInterval, maxInterval] = timing.pressIntervalMs;

  console.info("Reading started...");
  console.info("Reading duration: ", formatDuration(timing.durationMs));
  console.info("阅读期间截图: ", config.screenshot ? "开启" : "关闭");
  console.info(`翻动间隔: ${minInterval / 1000}–${maxInterval / 1000} 秒`);
  const startTime = Date.now();
  const endTime = startTime + timing.durationMs;
  console.info("Start time: ", new Date(startTime));
  console.info("End time: ", new Date(endTime));

  let lastMinute = 0;
  let transientErrors = 0;
  let jumpFailures = 0;
  while (Date.now() < endTime) {
    throwIfStopped(ctx.signal);
    await sleep(Math.min(randomBetween(minInterval, maxInterval), endTime - Date.now()), ctx.signal);

    try {
      const minute = Math.floor((Date.now() - startTime) / timing.minuteMs);
      if (minute > lastMinute) {
        lastMinute = minute;
        await onReadingMinute(driver, ctx, minute);
      }
      const step = await readStep(driver, ctx);
      transientErrors = 0;
      if (step.jumped === false) {
        jumpFailures += 1;
        if (jumpFailures >= MAX_JUMP_FAILURES) {
          throw new Error(`${step.reasons.join("、")}，连续 ${jumpFailures} 次无法通过目录回到开头：页面结构可能已改版`);
        }
      } else if (step.jumped) {
        jumpFailures = 0;
      }
    } catch (e) {
      throwIfStopped(ctx.signal);
      transientErrors += 1;
      if (!isTransientError(e) || transientErrors > MAX_TRANSIENT_ERRORS) {
        throw e;
      }
      console.warn(`阅读页面暂时无法操作（连续第 ${transientErrors} 次），跳过这一轮:`, e.message);
    }
  }

  console.info("Reading completed.");
  return Math.round((Date.now() - startTime) / 60000);
}

module.exports = {
  openBook,
  readLoop,
};
