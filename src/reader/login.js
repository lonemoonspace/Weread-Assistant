const fs = require("fs");
const path = require("path");
const { until } = require("selenium-webdriver");
const { ensurePrivateDir, writeFileAtomic } = require("../shared/files");
const {
  findElementsWithin,
  findVisible,
  isSessionLost,
  safeClickElement,
  sleep,
  throwIfStopped,
  toBy,
  waitForAnyXpath,
  waitForVisible,
  xpathsExist,
} = require("./dom");
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

// 损坏的 cookies 文件保留的备份数，更早的删除
const MAX_CORRUPT_COOKIES = 3;

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
  // 文件名中的时间戳位数相同，按名称排序即按时间
  const prefix = `${path.basename(filePath)}.corrupt-`;
  const copies = fs.readdirSync(path.dirname(filePath)).filter((name) => name.startsWith(prefix)).sort().reverse();
  for (const name of copies.slice(MAX_CORRUPT_COOKIES)) {
    fs.rmSync(path.join(path.dirname(filePath), name), { force: true });
  }
  return null;
}

// 登录完成后删除登录弹窗的截图：整页截图可能含昵称、头像，二维码截图已经没有用处
function removeLoginImages(paths) {
  for (const filePath of [paths.loginQrCode, paths.loginQrImage]) {
    fs.rmSync(filePath, { force: true });
  }
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

// 只认可见的元素：弹窗没有打开时，页面中隐藏的同名元素不代表二维码已出现
async function findQRCodeElement(driver) {
  console.info("正在查找二维码登录元素...");
  // 优先查找二维码图片
  if (await waitForVisible(driver, XPATH.qrImage, 3000)) {
    console.info("找到二维码图片元素");
    return true;
  }
  // 备选方案：查找登录弹窗中的扫码提示文字
  if (await waitForVisible(driver, XPATH.qrHint, 3000)) {
    console.info("找到登录弹窗中的扫码提示文字");
    return true;
  }
  console.info("未找到二维码相关元素，可能已经登录");
  return false;
}

// 从页面二维码图片中解码登录链接并推送，命令行运行时在终端显示；返回登录链接，解析失败时返回 null。
// 登录链接在有效期内可用于完成这次登录，不写入日志：由面板运行时经 login-required 事件交给面板显示
async function extractAndDisplayQRCode(driver, ctx) {
  let qrSaved = false;
  try {
    const qrImg = await findVisible(driver, XPATH.qrImage);
    if (!qrImg) {
      // 二维码图片还没加载出来：删掉之前保存的二维码截图，面板改为显示这次的整页截图
      fs.rmSync(ctx.paths.loginQrImage, { force: true });
      throw new Error("登录弹窗中没有可见的二维码图片");
    }
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
    if (isSessionLost(e)) {
      throw e;
    }
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
  // 整页截图只用于排查与兜底显示：截图失败（页面重绘、磁盘写入失败等）时照常解析二维码并上报 login-required，
  // 否则面板拿不到二维码
  try {
    const image = await driver.takeScreenshot();
    // 二维码在有效期内可用于完成登录，与 cookies 一样只允许属主读写
    writeFileAtomic(ctx.paths.loginQrCode, Buffer.from(image, "base64"), { mode: 0o600 });
    console.info("QR code saved, datetime: ", new Date());
  } catch (e) {
    if (isSessionLost(e)) {
      throw e;
    }
    console.warn("保存登录页截图失败:", e.message);
  }
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
  if (!(await safeClickElement(driver, loginLinks[0], "登录入口"))) {
    return false;
  }
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
        if (isSessionLost(e)) {
          throw e;
        }
        console.debug(`未找到元素: ${by.toString()}`);
        continue;
      }
      console.info(`找到刷新元素，尝试点击: ${by.toString()}`);
      refreshClicked = await safeClickElement(driver, refreshElement, "刷新按钮");
      if (refreshClicked) {
        try {
          await driver.wait(until.stalenessOf(refreshElement), 3000);
        } catch (waitError) {
          if (isSessionLost(waitError)) {
            throw waitError;
          }
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
    if (isSessionLost(error)) {
      throw error;
    }
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
  // 最近一次打开或刷新二维码的时间：过期提示的定位器失效时，按时间兜底重新打开登录弹窗
  let qrShownAt = Date.now();

  // 重新加载页面并再次打开登录弹窗；失败时继续等待到扫码超时（下一轮再试），不提前结束运行
  const reopenLoginDialog = async () => {
    try {
      await driver.navigate().refresh();
      await sleep(3000, ctx.signal);
      await openLoginDialogOrFail(driver, ctx);
    } catch (e) {
      throwIfStopped(ctx.signal);
      if (isSessionLost(e)) {
        throw e;
      }
      console.error("重新打开登录弹窗失败，继续等待扫码:", e.message);
      await sleep(timing.loginPollMs, ctx.signal);
    }
    qrShownAt = Date.now();
  };

  const deadline = Date.now() + timing.loginTimeoutMs;
  console.info("Waiting for login...");
  while (Date.now() < deadline) {
    throwIfStopped(ctx.signal);
    let state;
    try {
      state = await xpathsExist(driver, [XPATH.shelfLink, XPATH.qrExpiredOverlay, XPATH.qrExpiredText]);
    } catch (e) {
      if (isSessionLost(e)) {
        throw e;
      }
      // 扫码成功后页面会跳转，跳转过程中执行脚本可能失败，稍后再查
      console.debug("检查登录状态失败，稍后重试:", e.message);
      await sleep(timing.loginPollMs, ctx.signal);
      continue;
    }
    const [loggedIn, overlayShown, expiredTextShown] = state;

    if (loggedIn) {
      console.info("Login completed.");
      removeLoginImages(paths);
      return true;
    }

    // 二维码过期则刷新；刷新失败时重新加载页面并再次打开登录弹窗
    if (overlayShown || expiredTextShown) {
      console.info("Refreshing QR code...");
      if (await refreshQRCode(driver, ctx)) {
        qrShownAt = Date.now();
      } else {
        console.error("二维码刷新失败，重新加载页面后再次打开登录弹窗");
        await reopenLoginDialog();
      }
      console.info("Waiting for login...");
      continue;
    }

    // 二维码约 1 分钟过期；长时间没有识别到过期提示（页面改版、定位器失配）时按时间兜底，避免一直显示失效的二维码
    if (entry === 0 && Date.now() - qrShownAt > timing.qrMaxAgeMs) {
      console.warn(`${formatDuration(timing.qrMaxAgeMs)}内未识别到二维码过期提示，重新加载页面后再次打开登录弹窗`);
      await reopenLoginDialog();
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
