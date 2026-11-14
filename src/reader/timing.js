// 两次按下方向键之间的间隔（毫秒）。
// 重构前每轮循环被 5 秒隐式等待拖到约 15 秒（实测），默认的 slow 与之接近，避免阅读节奏突变。
const PACE_INTERVALS_MS = {
  slow: [13000, 19000],
  normal: [8000, 12000],
  fast: [4000, 8000],
};

// 等待页面元素与页面加载的基准时间，乘以“页面等待倍率”（pageWaitMultiplier）。
// 成功时元素一出现就继续，只有失败时才会等满；optionalWaitMs 用于本来就可能不存在的元素（如已是上下滚动时的切换按钮），不放大
const ELEMENT_WAIT_MS = 10000;
const PAGE_WAIT_MS = 20000;
const OPTIONAL_WAIT_MS = 5000;

function resolveTiming(config) {
  const multiplier = Number.isInteger(config.pageWaitMultiplier) && config.pageWaitMultiplier > 0 ? config.pageWaitMultiplier : 1;
  return {
    durationMs: config.duration * 60000,
    loginTimeoutMs: config.loginTimeout * 60000,
    pressIntervalMs: PACE_INTERVALS_MS[config.speed] || PACE_INTERVALS_MS.slow,
    minuteMs: 60000,
    loginPollMs: 1000,
    elementWaitMs: ELEMENT_WAIT_MS * multiplier,
    pageWaitMs: PAGE_WAIT_MS * multiplier,
    optionalWaitMs: OPTIONAL_WAIT_MS,
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
