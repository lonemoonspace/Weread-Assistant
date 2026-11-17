const { badRequest } = require("./errors");
const { TIME_PATTERN } = require("./schedules");

/**
 * 分段阅读：在手写的调度规则之外可选的另一种调度方式。账号的 split 为
 * { enabled, minutes, from, to, minSegment, maxSegment }：每天在 from–to（面板时区）之间读 minutes 分钟，
 * 由计划器在每天第一次检查时排成几段，每段 minSegment–maxSegment 分钟，开始时间与长度随机，相邻两段至少间隔 SEGMENT_GAP_MINUTES。
 * null 表示不使用。执行见 planner.js
 */

const MAX_SPLIT_MINUTES = 1440;
const MIN_SEGMENT_MINUTES = 5;
const MAX_SEGMENT_MINUTES = 240;
// 相邻两段之间至少间隔的分钟数（上一段的结束到下一段的开始），留出启动浏览器、登录与重试的时间
const SEGMENT_GAP_MINUTES = 30;
const FIELDS = ["enabled", "minutes", "from", "to", "minSegment", "maxSegment"];

const minuteOf = (time) => {
  const [hour, minute] = time.split(":").map(Number);
  return hour * 60 + minute;
};

const timeOf = (minute) => `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;

const isCount = (value, min, max) => Number.isInteger(value) && value >= min && value <= max;

// 窗口 window 分钟内最多能排下的阅读分钟数（每段不超过 maxSegment，段间留出间隔）
function capacityOf(window, maxSegment) {
  let best = 0;
  for (let count = 1; (count - 1) * SEGMENT_GAP_MINUTES < window; count += 1) {
    best = Math.max(best, Math.min(count * maxSegment, window - (count - 1) * SEGMENT_GAP_MINUTES));
  }
  return best;
}

function normalizeSplit(raw) {
  if (raw === null) {
    return null;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw badRequest("split 必须是对象或 null");
  }
  const unknown = Object.keys(raw).filter((key) => !FIELDS.includes(key));
  if (unknown.length > 0) {
    throw badRequest(`split 包含不支持的字段：${unknown.join(", ")}`);
  }
  if (raw.enabled !== undefined && typeof raw.enabled !== "boolean") {
    throw badRequest("split.enabled 必须是 true 或 false");
  }
  if (!isCount(raw.minutes, 1, MAX_SPLIT_MINUTES)) {
    throw badRequest(`每天阅读的分钟数必须是 1–${MAX_SPLIT_MINUTES} 的整数：${raw.minutes}`);
  }
  for (const key of ["from", "to"]) {
    if (typeof raw[key] !== "string" || !TIME_PATTERN.test(raw[key])) {
      throw badRequest(`时段的${key === "from" ? "开始" : "结束"}时间格式应为 HH:MM（00:00–23:59）：${raw[key]}`);
    }
  }
  if (minuteOf(raw.from) >= minuteOf(raw.to)) {
    throw badRequest(`时段的结束时间应晚于开始时间（不跨过零点）：${raw.from}–${raw.to}`);
  }
  if (!isCount(raw.minSegment, MIN_SEGMENT_MINUTES, MAX_SEGMENT_MINUTES) || !isCount(raw.maxSegment, MIN_SEGMENT_MINUTES, MAX_SEGMENT_MINUTES)) {
    throw badRequest(`每段的分钟数必须是 ${MIN_SEGMENT_MINUTES}–${MAX_SEGMENT_MINUTES} 的整数：${raw.minSegment}–${raw.maxSegment}`);
  }
  if (raw.minSegment > raw.maxSegment) {
    throw badRequest(`每段最短不能超过最长：${raw.minSegment}–${raw.maxSegment}`);
  }
  const window = minuteOf(raw.to) - minuteOf(raw.from);
  const capacity = capacityOf(window, raw.maxSegment);
  if (capacity < raw.minutes) {
    throw badRequest(
      `${raw.from}–${raw.to} 之间每段最长 ${raw.maxSegment} 分钟、段间隔 ${SEGMENT_GAP_MINUTES} 分钟，最多能读 ${capacity} 分钟，排不下 ${raw.minutes} 分钟：请放宽时段或加长每段`
    );
  }
  return {
    enabled: raw.enabled !== false,
    minutes: raw.minutes,
    from: raw.from,
    to: raw.to,
    minSegment: raw.minSegment,
    maxSegment: raw.maxSegment,
  };
}

// panel.json 中的分段设置（可能被手工改坏）：无效时当作没有设置
function storedSplit(raw) {
  try {
    return raw === undefined ? null : normalizeSplit(raw);
  } catch (_) {
    return null;
  }
}

const randomInt = (random, min, max) => min + Math.floor(random() * (max - min + 1));

/**
 * 排出一天的分段：在 [start, end)（距零点的分钟数）之间读 total 分钟。
 * 窗口不够时（例如当天中途开启）少读一些，排满为止。返回 [{ time: "HH:MM", minutes }]，按时间先后
 */
function planSegments({ total, start, end, minSegment, maxSegment, random = Math.random }) {
  const window = end - start;
  if (total <= 0 || window <= 0) {
    return [];
  }
  total = Math.min(total, capacityOf(window, maxSegment));
  if (total <= 0) {
    return [];
  }
  const fewest = Math.ceil(total / maxSegment);
  const most = Math.max(fewest, Math.min(Math.floor(total / minSegment), Math.floor((window - total) / SEGMENT_GAP_MINUTES) + 1));
  const count = randomInt(random, fewest, most);
  // 每段先给最短长度（总数不够时平分），余下的分钟随机加到还没到最长的段上
  const base = Math.min(minSegment, Math.floor(total / count));
  const lengths = Array.from({ length: count }, () => base);
  let left = total - base * count;
  while (left > 0) {
    const open = lengths.map((length, index) => (length < maxSegment ? index : -1)).filter((index) => index >= 0);
    lengths[open[Math.floor(random() * open.length)]] += 1;
    left -= 1;
  }
  // 空闲时间随机分到各段之前：取 count 个 [0, slack] 之间的随机数排序，作为每段之前累计的空闲
  const slack = window - total - (count - 1) * SEGMENT_GAP_MINUTES;
  const idle = Array.from({ length: count }, () => randomInt(random, 0, slack)).sort((a, b) => a - b);
  const segments = [];
  let used = 0;
  for (let index = 0; index < count; index += 1) {
    segments.push({ time: timeOf(start + idle[index] + used + index * SEGMENT_GAP_MINUTES), minutes: lengths[index] });
    used += lengths[index];
  }
  return segments;
}

module.exports = {
  MAX_SEGMENT_MINUTES,
  MIN_SEGMENT_MINUTES,
  SEGMENT_GAP_MINUTES,
  minuteOf,
  normalizeSplit,
  planSegments,
  storedSplit,
};
