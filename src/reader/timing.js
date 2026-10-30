// 两次按下方向键之间的间隔（毫秒）。
// 重构前每轮循环被 5 秒隐式等待拖到约 15 秒（实测），默认的 slow 与之接近，避免阅读节奏突变。
const PACE_INTERVALS_MS = {
  slow: [13000, 19000],
  normal: [8000, 12000],
  fast: [4000, 8000],
};

function resolveTiming(config) {
  return {
    durationMs: config.duration * 60000,
    loginTimeoutMs: config.loginTimeout * 60000,
    pressIntervalMs: PACE_INTERVALS_MS[config.speed] || PACE_INTERVALS_MS.slow,
    minuteMs: 60000,
    loginPollMs: 1000,
    elementWaitMs: 5000,
    pageWaitMs: 10000,
    // 登录链接推送的最小间隔：二维码约 1 分钟过期一次，避免每次刷新都推送
    loginLinkPushIntervalMs: 3 * 60000,
    // 二维码约 1 分钟过期；超过这个时长仍未识别到过期提示时重新打开登录弹窗
    qrMaxAgeMs: 3 * 60000,
  };
}

function formatDuration(ms) {
  return ms >= 60000 ? `${Math.round(ms / 60000)} 分钟` : `${Math.round(ms / 1000)} 秒`;
}

module.exports = {
  PACE_INTERVALS_MS,
  formatDuration,
  resolveTiming,
};
