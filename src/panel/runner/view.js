const { CONFIG_SCHEMA } = require("../../config/schema");
const { SECRET_MASK } = require("../config");

// 写入运行日志、推送日志与错误信息之前替换为掩码：配置中的密钥值，以及微信读书扫码登录链接中的 uid
// （有效期内可用于完成这次登录）。阅读流程本身不打印这些内容，这里是兜底
const SECRET_KEYS = CONFIG_SCHEMA.filter((field) => field.secret).map((field) => field.key);
const MIN_SECRET_LENGTH = 4;
const LOGIN_URL_UID = /(weread\.qq\.com\/web\/confirm\?[^\s"'<>]*?\buid=)[^&\s"'<>]+/g;

function createRedactor(config = {}) {
  const secrets = SECRET_KEYS.map((key) => config[key])
    .filter((value) => typeof value === "string" && value.length >= MIN_SECRET_LENGTH)
    .sort((a, b) => b.length - a.length);
  return (text) => {
    let result = String(text).replace(LOGIN_URL_UID, `$1${SECRET_MASK}`);
    for (const secret of secrets) {
      result = result.split(secret).join(SECRET_MASK);
    }
    return result;
  };
}

const MODE_LABELS = { read: "阅读", login: "仅登录" };
const TRIGGER_LABELS = { manual: "手动", schedule: "定时", split: "分段", retry: "重试", catchup: "补跑", resume: "恢复" };

function publicRun(run, { withLog = false } = {}) {
  const view = {
    id: run.id,
    accountId: run.accountId,
    accountName: run.accountName,
    mode: run.mode,
    trigger: run.trigger,
    scheduleId: run.scheduleId,
    status: run.status,
    stopRequested: run.stopRequested,
    queuedAt: run.queuedAt,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    book: run.book,
    readingStartedAt: run.readingStartedAt,
    minutes: run.minutes,
    plannedMinutes: run.plannedMinutes,
    screenshot: run.screenshot,
    loginUrl: run.loginUrl,
    // 最近一次出现二维码的时间：二维码解析不出登录链接时，页面据此加载二维码截图
    loginQrAt: run.loginQrAt,
    // 这次运行是否出现过扫码登录（统计页“需要扫码的次数”）
    loginPrompted: Boolean(run.loginPrompted),
    error: run.error,
    // 失败类别，见 events.js；成功、停止与中断时为空
    errorKind: run.errorKind,
    // 第几次尝试（从 1 开始）与最初那次运行：重试与恢复时有值
    attempt: run.attempt,
    originRunId: run.originRunId,
    // 随机延后或补触发造成的延迟（分钟）
    delayedMinutes: run.delayedMinutes,
  };
  if (withLog) {
    view.log = [...run.logTail];
  }
  return view;
}

// 写入 meta.json 的运行记录：不含登录链接（一次性且很快过期）。
// minuteMarks 为每一分钟阅读完成的时间，按天统计时用它把跨天的运行拆到各自的日期
function runMeta(run) {
  const { loginUrl, loginQrAt, stopRequested, ...meta } = publicRun(run);
  return { ...meta, minuteMarks: run.minuteMarks, exitCode: run.exitCode, exitSignal: run.exitSignal };
}

module.exports = {
  MODE_LABELS,
  TRIGGER_LABELS,
  createRedactor,
  publicRun,
  runMeta,
};
