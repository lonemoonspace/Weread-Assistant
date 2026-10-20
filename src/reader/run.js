const fs = require("fs");
const { createNotifier } = require("../notify");
const { collectDiagnostics, createDriver } = require("./browser");
const { throwIfStopped } = require("./dom");
const { login, saveCookies } = require("./login");
const { getDataPaths } = require("./paths");
const { openBook, readLoop } = require("./reading");
const { formatDuration, resolveTiming } = require("./timing");

const MAX_ERROR_LENGTH_IN_NOTIFICATION = 100;

async function saveScreenshot(driver, filePath) {
  fs.writeFileSync(filePath, await driver.takeScreenshot(), "base64");
}

// 发送事件通知；需要为该事件发邮件时截图作为附件，发送后删除（不混入运行目录中的阅读截图）
async function notifyWithScreenshot(eventName, body, driver, ctx) {
  const attachments = [];
  if (ctx.notifier.willEmail(eventName)) {
    const filePath = ctx.paths.screenshot(`email-${eventName}.png`);
    await saveScreenshot(driver, filePath);
    attachments.push(filePath);
  }
  try {
    await ctx.notifier.event(eventName, body, { attachments });
  } finally {
    for (const filePath of attachments) {
      fs.rmSync(filePath, { force: true });
    }
  }
}

/**
 * 执行一次运行：连接浏览器、登录，阅读模式下再选书并按时长阅读。
 *
 * options.mode: "read"（默认）或 "login"（只登录并保存 cookies）
 * options.signal: AbortSignal，触发后关闭浏览器并尽快结束，返回 stopped，不发送失败通知
 * options.report(event, data): 上报运行事件（见 docs/design.md“子进程事件”），由阅读子进程转发给面板
 * options.terminalQr: 是否在终端显示登录链接与二维码，默认 true
 * options.screenshotDir: 阅读截图的保存目录，默认为账号数据目录
 * options.panelLink: 面板中该账号实时页面的地址，附在扫码推送中（面板配置了 PANEL_PUBLIC_URL 时）
 * options.homeUrl / options.timing: 覆盖首页地址与时间参数，供测试使用
 *
 * 返回 { status: "success" | "login-timeout" | "error" | "stopped", minutes, error }
 */
async function runOnce(config, options = {}) {
  const mode = options.mode || "read";
  const { signal } = options;
  const report = options.report || (() => {});
  const timing = { ...resolveTiming(config), ...options.timing };
  const paths = getDataPaths(config, { screenshotDir: options.screenshotDir });
  const notifier = createNotifier(config, {
    loginLinkIntervalMs: timing.loginLinkPushIntervalMs,
    panelLink: options.panelLink || "",
  });
  const ctx = {
    config,
    paths,
    notifier,
    timing,
    report,
    signal,
    terminalQr: options.terminalQr !== false,
    homeUrl: options.homeUrl,
  };

  let driver;
  let quitting = null;
  const quitDriver = () => {
    if (!quitting) {
      console.info("Quitting the browser...");
      quitting = driver.quit().then(
        () => console.info("Browser closed."),
        (e) => console.warn("关闭浏览器失败:", e.message)
      );
    }
    return quitting;
  };
  // 停止时立即关闭浏览器：正在执行的 WebDriver 命令随之失败，流程从 catch 分支结束
  const onAbort = () => {
    console.warn("收到停止请求，正在关闭浏览器...");
    if (driver) {
      quitDriver();
    }
  };
  if (signal) {
    signal.addEventListener("abort", onAbort, { once: true });
  }

  try {
    throwIfStopped(signal);
    console.info("Starting the script, datetime: ", new Date(), "mode:", mode);
    await notifier.event(
      "start",
      mode === "login" ? "开始登录" : `开始自动阅读，计划 ${formatDuration(timing.durationMs)}`
    );

    driver = await createDriver(config);
    // 浏览器连接过程中收到停止请求时，连接完成后再关闭
    throwIfStopped(signal);
    report("session", { sessionId: (await driver.getSession()).getId() });

    if (!(await login(driver, ctx))) {
      report("login-timeout");
      await notifier.event("failure", `等待扫码超时（${formatDuration(timing.loginTimeoutMs)}），本次未阅读`);
      return { status: "login-timeout", minutes: 0, error: "" };
    }
    console.info("Successfully logged in.");
    report("login-ok");
    await saveCookies(driver, paths.cookies);

    if (mode === "login") {
      report("done", { minutes: 0 });
      await notifier.event("loginSuccess", "登录成功，已保存登录状态");
      return { status: "success", minutes: 0, error: "" };
    }

    const book = await openBook(driver, ctx);
    report("book-opened", { title: book.title });
    await notifyWithScreenshot("loginSuccess", `登录成功，开始阅读${book.title ? `《${book.title}》` : ""}`, driver, ctx);

    const minutes = await readLoop(driver, ctx);

    // save cookies after reading
    await saveCookies(driver, paths.cookies);
    report("done", { minutes });
    await notifyWithScreenshot("done", `阅读完成，共 ${minutes} 分钟`, driver, ctx);
    return { status: "success", minutes, error: "" };
  } catch (e) {
    if (signal && signal.aborted) {
      console.warn("运行已停止");
      return { status: "stopped", minutes: 0, error: "" };
    }
    const errorMessage = String(e?.message || e || "Unknown error");
    console.error("运行出错:", e);
    report("error", { message: errorMessage });
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
    if (signal) {
      signal.removeEventListener("abort", onAbort);
    }
    if (driver) {
      await quitDriver();
    }
  }
}

module.exports = {
  runOnce,
};
