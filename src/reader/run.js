const { FLUSH_TIMEOUT_MS, createNotifier } = require("../notify");
const fs = require("fs");
const { collectDiagnostics, createDriver } = require("./browser");
const { throwIfStopped } = require("./dom");
const { login, removeLoginImages, saveCookies } = require("./login");
const { getDataPaths } = require("./paths");
const { openBook, readLoop } = require("./reading");
const { formatDuration, resolveTiming } = require("./timing");

const MAX_ERROR_LENGTH_IN_NOTIFICATION = 100;
// 关闭浏览器的最长等待，短于面板停止时强制结束子进程的时限（src/panel/runner/process.js 的 KILL_TIMEOUT_MS）
const QUIT_TIMEOUT_MS = 10000;
// 收到停止请求时等待后台通知的最长时间：关闭浏览器（最多 QUIT_TIMEOUT_MS）加上这段时间仍短于 KILL_TIMEOUT_MS
const STOPPED_FLUSH_TIMEOUT_MS = 3000;
// 出错时保存现场截图的时限：浏览器已经卡死时不一直等
const ERROR_SCREENSHOT_TIMEOUT_MS = 5000;

// 最多等 ms 毫秒，超时返回 null
function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// 阅读流程出错时保存当前页面的截图（运行目录下的 error.png，0600），并记录页面地址与标题，供排查。
// 尽力而为：浏览器已断开或超时只记录日志。返回截图内容（作为失败邮件的附件），没有时为 null
async function saveErrorScreenshot(driver, paths) {
  try {
    const page = await withTimeout(
      Promise.all([driver.getCurrentUrl(), driver.getTitle()]).catch(() => null),
      ERROR_SCREENSHOT_TIMEOUT_MS
    );
    if (page) {
      console.info(`出错时的页面：${page[0]}（标题：${page[1] || "无"}）`);
    }
    const image = await withTimeout(driver.takeScreenshot(), ERROR_SCREENSHOT_TIMEOUT_MS);
    if (!image) {
      console.warn(`${ERROR_SCREENSHOT_TIMEOUT_MS / 1000} 秒内没能截取出错时的页面，跳过`);
      return null;
    }
    const content = Buffer.from(image, "base64");
    fs.writeFileSync(paths.screenshot("error.png"), content, { mode: 0o600 });
    console.info("已保存出错时的页面截图 error.png");
    return content;
  } catch (e) {
    console.warn("保存出错时的页面截图失败:", e.message);
    return null;
  }
}

// 发送事件通知；需要为该事件发邮件时截图作为附件（只在内存中，不写入运行目录）。
// 截图是尽力而为：截图失败时照常发送不带附件的通知，不影响运行结果。通知在后台发送，不等待结果
async function notifyWithScreenshot(eventName, body, driver, ctx) {
  const attachments = [];
  if (ctx.notifier.willEmail(eventName)) {
    try {
      const image = await driver.takeScreenshot();
      attachments.push({ filename: `${eventName}.png`, content: Buffer.from(image, "base64") });
    } catch (e) {
      console.warn("截取通知附件失败，本次通知不带截图:", e.message);
    }
  }
  ctx.notifier.event(eventName, body, { attachments });
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
 * options.browserStatus: 面板已检查过的内置浏览器状态，有值时子进程不再执行 --version
 * options.retry: { attempt, retriesLeft }，第几次尝试与出错后还会自动重试的次数：还会重试时不发送失败通知，
 *   最后一次失败的通知中写明重试过几次
 * options.goalDeficit: 每日目标补跑时当天还差的分钟数，写进扫码超时的通知
 * options.homeUrl / options.timing: 覆盖首页地址与时间参数，供测试使用
 *
 * 返回 { status: "success" | "login-timeout" | "error" | "stopped", minutes, error }
 */
async function runOnce(config, options = {}) {
  const mode = options.mode || "read";
  const { signal } = options;
  const report = options.report || (() => {});
  const retry = { attempt: 1, retriesLeft: 0, ...options.retry };
  const retriedNote = retry.attempt > 1 ? `（已重试 ${retry.attempt - 1} 次）` : "";
  const goalNote = options.goalDeficit > 0 ? `；今天还差 ${options.goalDeficit} 分钟，在面板中扫码登录（「仅登录」即可）后会自动补读` : "";
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
  // 上报 done 后为阅读分钟数：之后的收尾动作（发送通知等）出错只记录日志，不再补发 error、改变运行结果
  let doneMinutes = null;
  let quitting = null;
  const quitDriver = () => {
    if (!quitting) {
      console.info("Quitting the browser...");
      // WebDriver 命令本身没有超时：浏览器卡死时不一直等，超时后照常结束（面板随后结束子进程组中剩下的浏览器进程）
      let timer;
      const timeout = new Promise((resolve) => {
        timer = setTimeout(() => {
          console.warn(`关闭浏览器超过 ${QUIT_TIMEOUT_MS / 1000} 秒仍未完成，不再等待`);
          resolve();
        }, QUIT_TIMEOUT_MS);
      });
      const quit = driver.quit().then(
        () => console.info("Browser closed."),
        (e) => console.warn("关闭浏览器失败:", e.message)
      );
      quitting = Promise.race([quit, timeout]).finally(() => clearTimeout(timer));
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
    // 通知都在后台发送，不推迟浏览器启动与阅读；运行结束前统一等待（见 finally）
    notifier.event(
      "start",
      mode === "login" ? "开始登录" : `开始自动阅读，计划 ${formatDuration(timing.durationMs)}`
    );

    driver = await createDriver(config, { browserStatus: options.browserStatus });
    // 浏览器连接过程中收到停止请求时，连接完成后再关闭
    throwIfStopped(signal);
    report("session", { sessionId: (await driver.getSession()).getId() });

    if (!(await login(driver, ctx))) {
      report("login-timeout");
      notifier.event("failure", `等待扫码超时（${formatDuration(timing.loginTimeoutMs)}），本次未阅读${goalNote}`);
      return { status: "login-timeout", minutes: 0, error: "" };
    }
    console.info("Successfully logged in.");
    report("login-ok");
    await saveCookies(driver, paths.cookies);

    if (mode === "login") {
      report("done", { minutes: 0 });
      doneMinutes = 0;
      notifier.event("loginSuccess", "登录成功，已保存登录状态");
      return { status: "success", minutes: 0, error: "" };
    }

    const book = await openBook(driver, ctx);
    report("book-opened", { title: book.title });
    await notifyWithScreenshot("loginSuccess", `登录成功，开始阅读${book.title ? `《${book.title}》` : ""}`, driver, ctx);

    const minutes = await readLoop(driver, ctx);

    // 阅读已经完成，保存 cookies 失败只影响下次是否需要扫码
    try {
      await saveCookies(driver, paths.cookies);
    } catch (e) {
      console.warn("阅读后保存 cookies 失败:", e.message);
    }
    report("done", { minutes });
    doneMinutes = minutes;
    await notifyWithScreenshot("done", `阅读完成，共 ${minutes} 分钟`, driver, ctx);
    return { status: "success", minutes, error: "" };
  } catch (e) {
    if (doneMinutes !== null) {
      console.warn("阅读完成后的收尾出错:", e?.message || e);
      return { status: "success", minutes: doneMinutes, error: "" };
    }
    if (signal && signal.aborted) {
      console.warn("运行已停止");
      return { status: "stopped", minutes: 0, error: "" };
    }
    const errorMessage = String(e?.message || e || "Unknown error");
    console.error("运行出错:", e);
    // 先截图再上报：上报结果后面板会在一段时间后结束子进程
    const errorImage = driver ? await saveErrorScreenshot(driver, paths) : null;
    report("error", { message: errorMessage });
    // 出错时检查 Selenium 健康状态
    await collectDiagnostics(config, errorMessage, { browserStatus: options.browserStatus });
    const shortMessage =
      errorMessage.length > MAX_ERROR_LENGTH_IN_NOTIFICATION
        ? `${errorMessage.substring(0, MAX_ERROR_LENGTH_IN_NOTIFICATION)}...`
        : errorMessage;
    if (retry.retriesLeft > 0) {
      console.info(`还会自动重试（剩余 ${retry.retriesLeft} 次），这次不发送失败通知`);
    } else {
      const attachments = errorImage && notifier.willEmail("failure") ? [{ filename: "error.png", content: errorImage }] : [];
      notifier.event("failure", `运行出错：${shortMessage}${retriedNote}`, { attachments });
    }
    return { status: "error", minutes: 0, error: errorMessage };
  } finally {
    if (signal) {
      signal.removeEventListener("abort", onAbort);
    }
    if (driver) {
      await quitDriver();
    }
    // 等待仍在后台发送的通知（失败通知等），最多 10 秒；停止时只等一小会儿
    await notifier.flush(signal && signal.aborted ? STOPPED_FLUSH_TIMEOUT_MS : FLUSH_TIMEOUT_MS);
    try {
      removeLoginImages(paths);
    } catch (e) {
      console.warn("删除登录截图失败:", e.message);
    }
  }
}

module.exports = {
  runOnce,
};
