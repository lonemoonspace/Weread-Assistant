const fs = require("fs");
const { createNotifier } = require("../notify");
const { collectDiagnostics, createDriver } = require("./browser");
const { login, saveCookies } = require("./login");
const { getDataPaths } = require("./paths");
const { openBook, readLoop } = require("./reading");
const { formatDuration, resolveTiming } = require("./timing");

const MAX_ERROR_LENGTH_IN_NOTIFICATION = 100;

async function saveScreenshot(driver, filePath) {
  fs.writeFileSync(filePath, await driver.takeScreenshot(), "base64");
}

// 需要为该事件发邮件时截图作为附件
async function screenshotFor(eventName, driver, ctx) {
  if (!ctx.notifier.willEmail(eventName)) {
    return [];
  }
  const filePath = ctx.paths.screenshot();
  await saveScreenshot(driver, filePath);
  return [filePath];
}

/**
 * 执行一次运行：连接浏览器、登录，阅读模式下再选书并按时长阅读。
 *
 * options.mode: "read"（默认）或 "login"（只登录并保存 cookies）
 * options.homeUrl / options.timing: 覆盖首页地址与时间参数，供测试使用
 *
 * 返回 { status: "success" | "login-timeout" | "error", minutes, error }
 */
async function runOnce(config, options = {}) {
  const mode = options.mode || "read";
  const timing = { ...resolveTiming(config), ...options.timing };
  const paths = getDataPaths(config);
  const notifier = createNotifier(config, { loginLinkIntervalMs: timing.loginLinkPushIntervalMs });
  const ctx = { config, paths, notifier, timing, homeUrl: options.homeUrl };

  console.info("Starting the script, datetime: ", new Date(), "mode:", mode);
  await notifier.event(
    "start",
    mode === "login" ? "开始登录" : `开始自动阅读，计划 ${formatDuration(timing.durationMs)}`
  );

  let driver;
  try {
    driver = await createDriver(config);

    if (!(await login(driver, ctx))) {
      await notifier.event("failure", `等待扫码超时（${formatDuration(timing.loginTimeoutMs)}），本次未阅读`);
      return { status: "login-timeout", minutes: 0, error: "" };
    }
    console.info("Successfully logged in.");
    await saveCookies(driver, paths.cookies);

    if (mode === "login") {
      await notifier.event("loginSuccess", "登录成功，已保存登录状态");
      return { status: "success", minutes: 0, error: "" };
    }

    const book = await openBook(driver, ctx);
    await notifier.event(
      "loginSuccess",
      `登录成功，开始阅读${book.title ? `《${book.title}》` : ""}`,
      { attachments: await screenshotFor("loginSuccess", driver, ctx) }
    );

    const minutes = await readLoop(driver, ctx);

    // save cookies after reading
    await saveCookies(driver, paths.cookies);
    await notifier.event("done", `阅读完成，共 ${minutes} 分钟`, {
      attachments: await screenshotFor("done", driver, ctx),
    });
    return { status: "success", minutes, error: "" };
  } catch (e) {
    const errorMessage = String(e?.message || e || "Unknown error");
    console.error("运行出错:", e);
    // 出错时检查 Selenium 健康状态
    await collectDiagnostics(config, errorMessage);
    const shortMessage =
      errorMessage.length > MAX_ERROR_LENGTH_IN_NOTIFICATION
        ? `${errorMessage.substring(0, MAX_ERROR_LENGTH_IN_NOTIFICATION)}...`
        : errorMessage;
    await notifier.event("failure", `运行出错：${shortMessage}`);

    // wait for 3 seconds before closing the browser
    await new Promise((resolve) => setTimeout(resolve, 3000));
    return { status: "error", minutes: 0, error: errorMessage };
  } finally {
    console.info("Quitting the browser...");
    if (driver) {
      try {
        await driver.quit();
        console.info("Browser closed.");
      } catch (e) {
        console.warn("关闭浏览器失败:", e.message);
      }
    }
  }
}

module.exports = {
  runOnce,
};
