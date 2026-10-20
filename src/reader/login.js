const fs = require("fs");
const { By, until } = require("selenium-webdriver");
const { ensurePrivateDir, writeFileAtomic } = require("../shared/files");
const { findElementsWithin, sleep, throwIfStopped, toBy, waitForAnyXpath, xpathsExist } = require("./dom");
const { formatDuration } = require("./timing");
const {
  HOME_TITLE,
  QR_REFRESH_LOCATORS,
  QR_REFRESH_SCRIPT,
  WEREAD_HOME_URL,
  XPATH,
} = require("./selectors");

async function saveCookies(driver, filePath) {
  const cookies = await driver.manage().getCookies();
  // cookies 等同于登录状态，只允许属主读写
  writeFileAtomic(filePath, JSON.stringify(cookies, null, 2), { mode: 0o600 });
  console.info("Cookies saved successfully.");
}

// 读取 cookies 文件；内容损坏时改名备份并返回 null，本次转入扫码登录
function readCookiesFile(filePath) {
  try {
    const cookies = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (Array.isArray(cookies)) {
      return cookies;
    }
  } catch (_) {}

  const backupPath = `${filePath}.corrupt-${Date.now()}`;
  fs.renameSync(filePath, backupPath);
  console.warn("cookies 文件已损坏，已备份为", backupPath, "，本次需要重新扫码登录");
  return null;
}

// 返回是否加载了至少一个 cookie
async function loadCookies(driver, filePath) {
  if (!fs.existsSync(filePath)) {
    return false;
  }

  const cookies = readCookiesFile(filePath);
  if (!cookies) {
    return false;
  }

  let loaded = 0;
  for (const cookie of cookies) {
    try {
      await driver.manage().addCookie(cookie);
      loaded += 1;
    } catch (e) {
      console.warn(`跳过无法加载的 cookie ${cookie.name}:`, e.message);
    }
  }
  console.info("Cookies loaded successfully.");
  return loaded > 0;
}

async function findQRCodeElement(driver) {
  try {
    console.info("正在查找二维码登录元素...");
    // 优先查找二维码图片
    await driver.wait(until.elementLocated(By.xpath(XPATH.qrImage)), 3000);
    console.info("找到二维码图片元素");
    return true;
  } catch (e) {
    try {
      // 备选方案：查找包含"扫码"或"二维码"文本的元素
      await driver.wait(until.elementLocated(By.xpath(XPATH.qrHint)), 3000);
      console.info("找到包含'扫码'或'二维码'文本的元素");
      return true;
    } catch (e) {
      console.info("未找到二维码相关元素，可能已经登录");
      return false;
    }
  }
}

// 从页面二维码图片中解码登录链接并推送，命令行运行时在终端显示；返回登录链接，解析失败时返回 null。
// 登录链接在有效期内可用于完成这次登录，不写入日志：由面板运行时经 login-required 事件交给面板显示
async function extractAndDisplayQRCode(driver, ctx) {
  let qrSaved = false;
  try {
    const qrImg = await driver.findElement(By.xpath(XPATH.qrImage));
    const base64Png = await qrImg.takeScreenshot();
    writeFileAtomic(ctx.paths.loginQrImage, Buffer.from(base64Png, "base64"), { mode: 0o600 });
    qrSaved = true;

    const { PNG } = require("pngjs");
    const png = PNG.sync.read(Buffer.from(base64Png, "base64"));

    const jsQR = require("jsqr");
    const code = jsQR(new Uint8ClampedArray(png.data), png.width, png.height);

    if (code && code.data) {
      console.info("已解析登录链接，二维码约 1 分钟后失效，失效后会自动刷新");
      if (ctx.terminalQr) {
        // console.log 只输出到终端，不写入 output.log
        console.log(`登录链接: ${code.data}`);
        const qrcode = require("qrcode-terminal");
        qrcode.generate(code.data, { small: true });
      }
      await ctx.notifier.loginLink(code.data, ctx.paths.loginQrImage);
      return code.data;
    }
    console.warn("无法从二维码图片中解析登录链接");
  } catch (e) {
    console.warn("提取二维码登录链接失败:", e.message);
  }
  // 配置了面板地址时改为推送面板链接，在面板中扫二维码截图
  await ctx.notifier.loginLink("", qrSaved ? ctx.paths.loginQrImage : "");
  return null;
}

// 截取整页保存为登录二维码图片，并解析、推送登录链接
async function captureQRCode(driver, ctx) {
  // 避免截图时二维码还未弹出
  await sleep(1000);
  const image = await driver.takeScreenshot();
  // 二维码在有效期内可用于完成登录，与 cookies 一样只允许属主读写
  writeFileAtomic(ctx.paths.loginQrCode, Buffer.from(image, "base64"), { mode: 0o600 });
  console.info("QR code saved, datetime: ", new Date());
  const url = await extractAndDisplayQRCode(driver, ctx);
  // 解析不出链接时也上报，面板据此显示“等待扫码”
  ctx.report("login-required", { url: url || "" });
}

// 点击首页的“登录”打开二维码弹窗；返回是否找到二维码
async function openLoginDialog(driver, ctx) {
  const loginLinks = await findElementsWithin(driver, XPATH.loginLink, ctx.timing.elementWaitMs);
  if (loginLinks.length === 0) {
    console.warn("未找到登录入口");
    return false;
  }

  console.info("Login link found. Clicking...");
  // 避免点击不成功
  await sleep(1000);
  await loginLinks[0].click();
  // 等待弹窗加载
  await sleep(2000);

  if (!(await findQRCodeElement(driver))) {
    console.error("未能找到任何二维码相关元素");
    return false;
  }
  await captureQRCode(driver, ctx);
  return true;
}

// 打开登录弹窗；找不到二维码时刷新页面重试一次（站点慢、二维码图片后加载），仍没有就失败，
// 不再静默等到扫码超时。刷新后已登录（出现书架）时不算失败
async function openLoginDialogOrFail(driver, ctx) {
  for (let attempt = 1; ; attempt += 1) {
    if (await openLoginDialog(driver, ctx)) {
      return;
    }
    if ((await xpathsExist(driver, [XPATH.shelfLink]))[0]) {
      return;
    }
    if (attempt >= 2) {
      throw new Error("未能打开扫码登录弹窗（找不到登录入口或二维码）：页面结构可能已改版");
    }
    console.warn("未能打开扫码登录弹窗，刷新页面后重试");
    await driver.navigate().refresh();
    await waitForAnyXpath(driver, [XPATH.loginLink, XPATH.shelfLink], ctx.timing.pageWaitMs);
  }
}

// 安全点击元素函数，处理元素被拦截的情况
async function safeClickElement(driver, element, description = "元素") {
  try {
    // 首先检查元素是否可见和可点击
    const isDisplayed = await element.isDisplayed();
    if (!isDisplayed) {
      console.warn(`${description}不可见，尝试滚动到元素位置`);
      await driver.executeScript("arguments[0].scrollIntoView({block: 'center'});", element);
      await sleep(500);
    }

    await element.click();
    console.info(`成功点击${description}`);
    return true;
  } catch (error) {
    console.warn(`直接点击${description}失败: ${error.message}`);

    try {
      console.info(`尝试使用JavaScript点击${description}`);
      await driver.executeScript("arguments[0].click();", element);
      console.info(`使用JavaScript成功点击${description}`);
      return true;
    } catch (jsError) {
      console.warn(`使用JavaScript点击${description}失败: ${jsError.message}`);

      try {
        console.info(`尝试使用Actions类点击${description}`);
        const actions = driver.actions({ bridge: true });
        await actions.move({ origin: element }).click().perform();
        console.info(`使用Actions类成功点击${description}`);
        return true;
      } catch (actionError) {
        console.error(`所有点击方法都失败: ${actionError.message}`);
        return false;
      }
    }
  }
}

// 点击二维码上的刷新入口；返回是否拿到了新的二维码
async function refreshQRCode(driver, ctx) {
  try {
    console.info("开始刷新二维码...");

    let refreshClicked = false;
    for (const locator of QR_REFRESH_LOCATORS) {
      const by = toBy(locator);
      let refreshElement;
      try {
        refreshElement = await driver.wait(until.elementLocated(by), 2000);
      } catch (e) {
        console.debug(`未找到元素: ${by.toString()}`);
        continue;
      }
      console.info(`找到刷新元素，尝试点击: ${by.toString()}`);
      refreshClicked = await safeClickElement(driver, refreshElement, "刷新按钮");
      if (refreshClicked) {
        try {
          await driver.wait(until.stalenessOf(refreshElement), 3000);
        } catch (waitError) {
          console.debug(`刷新元素可能未及时从DOM移除: ${waitError.message}`);
        }
        break;
      }
    }

    if (!refreshClicked) {
      console.warn("常规定位失败，尝试执行脚本触发刷新");
      if (!(await driver.executeScript(QR_REFRESH_SCRIPT))) {
        console.error("无法找到或点击任何刷新按钮");
        return false;
      }
    }

    // 等待新二维码加载
    await sleep(2000);

    if (!(await findQRCodeElement(driver))) {
      console.error("刷新后未能找到任何二维码相关元素");
      return false;
    }
    await captureQRCode(driver, ctx);
    return true;
  } catch (error) {
    console.error("刷新二维码过程中发生错误:", error.message);
    return false;
  }
}

// 打开首页、加载 cookies，需要时展示二维码并等待扫码；
// 返回 true 表示已登录，false 表示在等待时长内没有完成扫码
async function login(driver, ctx) {
  const { paths, timing } = ctx;
  const homeUrl = ctx.homeUrl || WEREAD_HOME_URL;

  await driver.get(homeUrl);
  if (await loadCookies(driver, paths.cookies)) {
    await driver.navigate().refresh(); // Refresh to apply cookies
  }

  console.info("Going to the URL:", homeUrl);
  const title = await driver.getTitle();
  if (title !== HOME_TITLE) {
    throw new Error(`首页标题应为“${HOME_TITLE}”，实际为“${title}”`);
  }
  console.info("Successfully opened the url:", homeUrl);

  ensurePrivateDir(paths.dataDir);

  // 等首页渲染出“登录”入口或“我的书架”；都没有时刷新重试一次，仍没有就失败，不进入等待扫码
  console.info("Find login links...");
  const entryXpaths = [XPATH.loginLink, XPATH.shelfLink];
  let entry = await waitForAnyXpath(driver, entryXpaths, timing.pageWaitMs);
  if (entry === -1) {
    console.warn("首页未出现登录入口或书架，刷新页面后重试");
    await driver.navigate().refresh();
    entry = await waitForAnyXpath(driver, entryXpaths, timing.pageWaitMs);
  }
  if (entry === -1) {
    throw new Error("首页未出现“登录”入口或“我的书架”：请检查网络，或页面结构是否已改版");
  }
  if (entry === 0) {
    await openLoginDialogOrFail(driver, ctx);
  }

  const deadline = Date.now() + timing.loginTimeoutMs;
  console.info("Waiting for login...");
  while (Date.now() < deadline) {
    throwIfStopped(ctx.signal);
    let state;
    try {
      state = await xpathsExist(driver, [XPATH.shelfLink, XPATH.qrExpiredOverlay, XPATH.qrExpiredText]);
    } catch (e) {
      // 扫码成功后页面会跳转，跳转过程中执行脚本可能失败，稍后再查
      console.debug("检查登录状态失败，稍后重试:", e.message);
      await sleep(timing.loginPollMs, ctx.signal);
      continue;
    }
    const [loggedIn, overlayShown, expiredTextShown] = state;

    if (loggedIn) {
      console.info("Login completed.");
      return true;
    }

    // 二维码过期则刷新；刷新失败时重新加载页面并再次打开登录弹窗
    if (overlayShown || expiredTextShown) {
      console.info("Refreshing QR code...");
      if (!(await refreshQRCode(driver, ctx))) {
        console.error("二维码刷新失败，重新加载页面后再次打开登录弹窗");
        await driver.navigate().refresh();
        await sleep(3000);
        await openLoginDialogOrFail(driver, ctx);
      }
      console.info("Waiting for login...");
      continue;
    }

    await sleep(timing.loginPollMs, ctx.signal);
  }

  console.error(`等待扫码超时（${formatDuration(timing.loginTimeoutMs)}）`);
  return false;
}

module.exports = {
  login,
  saveCookies,
};
