const fs = require("fs");
const { By, until, Key } = require("selenium-webdriver");

async function pressDownArrow(driver) {
  await driver.actions().sendKeys(Key.ARROW_DOWN).perform();
  // keep the key pressed for random time between 50ms to 500ms
  let randomTime = Math.floor(Math.random() * 450) + 50;
  await new Promise((resolve) => setTimeout(resolve, randomTime));
  // release the down arrow key
  await driver.actions().sendKeys(Key.NULL).perform();
}

// Function to check if element is in viewport
async function isElementInViewport(driver, element) {
  // Get viewport dimensions using JavaScript
  const viewport = await driver.executeScript(`
    return {
      height: window.innerHeight,
      width: window.innerWidth
    };
  `);

  // Get element position and size
  const rect = await driver.executeScript(
    `
    const rect = arguments[0].getBoundingClientRect();
    return {
      top: rect.top,
      left: rect.left,
      bottom: rect.bottom,
      right: rect.right
    };
  `,
    element
  );

  // Check if element is within viewport
  return (
    rect.top >= 0 &&
    rect.left >= 0 &&
    rect.bottom <= viewport.height &&
    rect.right <= viewport.width &&
    (await element.isDisplayed())
  );
}

// 按选书方式打开书籍，并切换到上下滚动阅读模式
async function openBook(driver, ctx) {
  const { config } = ctx;

  let selection = Number(config.selection);
  if (selection === -1) {
    console.info("WEREAD_SELECTION=-1，直接打开 DEFAULT_BOOK_URL:", config.bookUrl);
    await driver.get(config.bookUrl);
  } else {
    if (selection === 0) {
      // random selection between 1 and 4
      selection = Math.floor(Math.random() * 4) + 1;
    }
    let books = await driver.findElements(
      By.xpath("//div[@class='wr_index_mini_shelf_card']"),
      10000
    );
    if (books.length > 0 && books.length < selection) {
      await books[0].click();
      console.info("Clicked on the first book.");
    } else if (books.length >= selection) {
      await books[selection - 1].click();
      console.info("Clicked on the ", selection, "th book.");
    } else {
      console.warn("No book link found. Using the default link.");
      await driver.get(config.bookUrl);
    }
  }

  // get button with title equal to "目录"
  await driver.wait(
    until.elementLocated(By.xpath('//button[@title="目录"]')),
    10000
  );

  // 切换到"上下滚动阅读"模式
  // OLD: 通过 title="切换到上下滚动阅读" 定位
  // NEW: 通过 class "readerControls_item" + "isHorizontalReader" 定位
  let switchButton = await driver.findElements(
    By.xpath(
      "//button[@title='切换到上下滚动阅读'] | //button[contains(@class, 'readerControls_item') and contains(@class, 'isHorizontalReader')]"
    )
  );
  if (switchButton.length > 0) {
    await switchButton[0].click();
    console.info("Switched to vertical scroll mode.");
  } else {
    console.warn('未找到用于切换为上下滚动阅读的按钮（兼容新老版本定位）');
  }

  // Wait for button with title "目录"
  await driver.wait(
    until.elementLocated(By.xpath('//button[@title="目录"]')),
    10000
  );
  console.info("Successfully switched to vertical scroll mode.");
}

// 按配置时长持续阅读：翻页、跳章、读完回到目录，并每分钟截图
async function readLoop(driver, ctx) {
  const { config, paths } = ctx;

  console.info("Reading started...");

  console.info("Reading duration: ", config.duration, " minutes");
  console.info(
    "阅读期间截图: ",
    config.screenshot ? "开启" : "关闭"
  );
  let startTime = new Date();
  console.info("Start time: ", startTime);
  let endTime = new Date(startTime.getTime() + config.duration * 60000);
  console.info("End time: ", endTime);
  let screenshotTime = startTime;
  // log last read time per minute
  while (new Date() < endTime) {
    let currentTime = new Date();
    // wait for random time between 300ms to 1s
    let randomTime = Math.floor(Math.random() * 700) + 300;
    if (config.speed === "fast") {
      randomTime = Math.floor(Math.random() * 100) + 100;
    } else if (config.speed === "normal") {
      randomTime = Math.floor(Math.random() * 400) + 200;
    }
    await new Promise((resolve) => setTimeout(resolve, randomTime));
    if (currentTime.getMinutes() !== screenshotTime.getMinutes()) {
      // take screenshot every minute, and get round index
      let screenshotIndex = Math.round((currentTime - startTime) / 60000);
      const screenshotPath = paths.screenshot(`screenshot-${screenshotIndex}.png`);
      if (config.screenshot) {
        await driver.takeScreenshot().then((image) => {
          fs.writeFileSync(screenshotPath, image, "base64");
        });
      }
      screenshotTime = currentTime;
      console.info("Reading minute: ", screenshotIndex);

      // if the screenshot png size is less than 100 KB, then refresh the page
      // continue if file not found
      if (!config.screenshot) {
        continue;
      }
      if (!fs.existsSync(screenshotPath)) {
        continue;
      }
      let stats = fs.statSync(screenshotPath);
      let fileSizeInBytes = stats.size;
      let fileSizeInKB = fileSizeInBytes / 1024;
      console.debug("Screenshot size: ", fileSizeInKB, " KB");
      if (fileSizeInKB < 100) {
        await driver.navigate().refresh();
        console.info("Page refreshed.");
      }
    }

    // check if need to jump to the top
    // check if the doc title contains "已读完"
    let title = await driver.getTitle();
    let needToJump = title.includes("已读完");
    const needToJumpReasons = [];
    if (needToJump) {
      needToJumpReasons.push('标题包含 "已读完"');
    }
    // check if got a "span" contains text "开通后即可阅读"
    let unlockPrompts = await driver.findElements(
      By.xpath("//span[contains(text(), '开通后即可阅读')]")
    );
    if (unlockPrompts.length > 0) {
      console.warn("需要打开书籍");
      needToJump = true;
      needToJumpReasons.push("需要打开书籍");
    }

    // find element div with class "readerFooter_ending_title" and content contains "全 书 完"
    let readComplete = await driver.findElements(
      By.xpath("//div[contains(text(), '全 书 完')]")
    );
    if (readComplete.length > 0) {
      console.warn("书籍已读完");
      needToJump = true;
      needToJumpReasons.push("书籍已读完");
    }

    if (needToJump) {
      console.warn(
        "needToJump = true, reasons: " +
          (needToJumpReasons.length
            ? needToJumpReasons.join(" | ")
            : "unknown")
      );
      // jump to the top
      // click the buttion "目录"
      let catalogs = await driver.findElements(
        By.xpath('//button[@title="目录"]')
      );
      if (catalogs.length > 0) {
        await catalogs[0].click();
        console.info("Clicked on catalog button.");
      } else {
        console.error("Catalog button not found.");
      }

      // click the first "li" with class "readerCatalog_list_item"
      let chapters = await driver.findElements(
        By.xpath("//li[@class='readerCatalog_list_item']")
      );
      if (chapters.length > 0) {
        // scroll to the top
        await driver.executeScript(
          "arguments[0].scrollIntoView();",
          chapters[0]
        );
        await chapters[1].click();
        console.info("Clicked on first chapter.");
      } else {
        console.error("Chapters not found.");
      }
    }

    // find button with title "下一章" or "下一页"
    let nextChapter = await driver.findElements(
      By.xpath("//button[@title='下一章'] | //button[@title='下一页']")
    );
    if (nextChapter.length !== 0) {
      // check if the button is shown on the screen
      let isVisible = await isElementInViewport(driver, nextChapter[0]);
      if (isVisible) {
        await nextChapter[0].click();
        console.info("Clicked on next chapter button.");
        continue;
      }
    }

    // find div with content contains "点击重试", 未确认
    let retry = await driver.findElements(
      By.xpath("//div[contains(text(), '点击重试')]")
    );
    if (retry.length > 0) {
      console.warn("Retry button found.");
      await retry[0].click();
      console.info("Clicked on retry button.");
      continue;
    }

    // press down arrow key if position is greater than 99
    await pressDownArrow(driver);
    console.debug("Pressed down arrow key.");
  }
  console.info("Reading completed.");
}

module.exports = {
  openBook,
  readLoop,
};
