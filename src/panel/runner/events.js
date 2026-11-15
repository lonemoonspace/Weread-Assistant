const path = require("path");

// 补齐到 count 个分钟记录（进度事件跳过了某些分钟，或最后一分钟没来得及上报）。补记的分钟在上一条记录
// （没有时为开始阅读的时间）与现在之间均匀分布，最后一条为现在：跨午夜时仍能大致归到各自的日期
function fillMinuteMarks(run, count) {
  const missing = count - run.minuteMarks.length;
  if (missing <= 0) {
    return;
  }
  const now = Date.now();
  const last = Date.parse(run.minuteMarks.at(-1) || run.readingStartedAt || "");
  const from = Number.isNaN(last) || last > now ? now : last;
  const step = (now - from) / missing;
  for (let i = 1; i <= missing; i += 1) {
    run.minuteMarks.push(new Date(from + step * i).toISOString());
  }
}

function toCount(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : 0;
}

// 按子进程上报的事件更新运行状态。返回 null 表示忽略这个事件；
// 返回 { result } 时 result 为本次运行的结果（{ status, error, errorKind }），由调用方记录。
// errorKind 为失败类别：login-timeout、error（阅读流程报错）、timeout（超时被结束）、crash（子进程异常退出）、config（配置无效）、account（账号已删除）
function applyWorkerEvent(run, message) {
  const data = message.data && typeof message.data === "object" ? message.data : {};
  switch (message.event) {
    case "started":
      return {};
    case "session":
      run.sessionId = String(data.sessionId || "");
      return {};
    case "login-required":
      run.status = "waiting-login";
      run.loginUrl = String(data.url || "");
      run.loginQrAt = new Date().toISOString();
      return {};
    case "login-ok":
      run.status = "starting";
      run.loginUrl = "";
      run.loginQrAt = "";
      return {};
    case "book-opened":
      run.status = "reading";
      run.book = String(data.title || "");
      run.readingStartedAt = new Date().toISOString();
      return {};
    case "reading-minute":
      run.minutes = Math.min(toCount(data.minute), run.maxMinutes);
      fillMinuteMarks(run, run.minutes);
      run.plannedMinutes = toCount(data.total) || run.plannedMinutes;
      run.screenshot = path.basename(String(data.screenshot || ""));
      return {};
    case "done":
      // 以较大者为准：最后一分钟的进度可能没来得及上报
      run.minutes = Math.min(Math.max(run.minutes, toCount(data.minutes)), run.maxMinutes);
      fillMinuteMarks(run, run.minutes);
      return { result: { status: "success", error: "", errorKind: "" } };
    case "login-timeout":
      return { result: { status: "failed", error: "等待扫码超时", errorKind: "login-timeout" } };
    case "error":
      return { result: { status: "failed", error: run.redact(data.message || "未知错误"), errorKind: "error" } };
    default:
      return null;
  }
}

// 子进程退出后的最终结果：以上报的结果为准，没有上报时按退出原因判定
function exitOutcome(run, exitText) {
  if (run.result) {
    return run.result;
  }
  if (run.timedOut) {
    return { status: "failed", error: "运行超时，已强制结束", errorKind: "timeout" };
  }
  if (run.shutdown) {
    return { status: "interrupted", error: "面板停止时运行被中断", errorKind: "" };
  }
  if (run.stopRequested) {
    return { status: "stopped", error: "", errorKind: "" };
  }
  return { status: "failed", error: `阅读子进程异常退出（${exitText}）`, errorKind: "crash" };
}

module.exports = {
  applyWorkerEvent,
  exitOutcome,
  fillMinuteMarks,
};
