// 失败重试的规则，运行队列（下发剩余重试次数）与计划器（安排重试）共用

// 自动触发的运行：定时、分段阅读、补跑（每日目标）、恢复（重启后补读）与重试本身。手动启动的运行失败时人就在面板前，不自动重试
const AUTO_TRIGGERS = ["schedule", "split", "catchup", "resume", "retry"];
// 会重试的失败类别：阅读流程报错、超时被结束、子进程异常退出。扫码超时（需要人扫码）与配置无效不重试
const RETRYABLE_ERROR_KINDS = ["error", "timeout", "crash"];
// 第 1、2 次重试的等待时间，第 3 次起都用最后一个
const RETRY_DELAYS_MS = [5 * 60000, 15 * 60000, 30 * 60000];

// attempt 为这次是第几次尝试（从 1 开始），retryCount 为面板设置的重试次数
function retriesLeftFor(trigger, attempt, retryCount) {
  if (!AUTO_TRIGGERS.includes(trigger)) {
    return 0;
  }
  return Math.max(0, retryCount - (attempt - 1));
}

// 第 retryNumber 次重试（从 1 开始）前的等待时间
function retryDelayMs(retryNumber, delays = RETRY_DELAYS_MS) {
  return delays[Math.min(retryNumber, delays.length) - 1];
}

module.exports = {
  AUTO_TRIGGERS,
  RETRYABLE_ERROR_KINDS,
  RETRY_DELAYS_MS,
  retriesLeftFor,
  retryDelayMs,
};
