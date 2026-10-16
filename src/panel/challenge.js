const { badRequest } = require("./errors");

// 微信读书阅读挑战的规则：开始日起 days 天内打卡 requiredDays 天、累计阅读 requiredMinutes 分钟
const CHALLENGES = {
  month: { label: "月卡", days: 30, requiredDays: 29, requiredMinutes: 30 * 60 },
  year: { label: "年卡", days: 365, requiredDays: 360, requiredMinutes: 300 * 60 },
};

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

// YYYY-MM-DD 且是日历上存在的日期
function isValidDate(date) {
  if (typeof date !== "string" || !DATE_PATTERN.test(date)) {
    return false;
  }
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toISOString().slice(0, 10) === date;
}

// 账号的挑战设置：null 表示不设置；{ type: "month" | "year", startDate: "YYYY-MM-DD" }
function normalizeChallenge(raw) {
  if (raw === null) {
    return null;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw badRequest("challenge 必须是对象或 null");
  }
  const unknown = Object.keys(raw).filter((key) => key !== "type" && key !== "startDate");
  if (unknown.length > 0) {
    throw badRequest(`challenge 包含不支持的字段：${unknown.join(", ")}`);
  }
  if (!CHALLENGES[raw.type]) {
    throw badRequest(`挑战类型只能是 ${Object.keys(CHALLENGES).join("、")}：${raw.type}`);
  }
  if (!isValidDate(raw.startDate)) {
    throw badRequest(`挑战开始日期格式应为 YYYY-MM-DD：${raw.startDate}`);
  }
  return { type: raw.type, startDate: raw.startDate };
}

module.exports = {
  CHALLENGES,
  isValidDate,
  normalizeChallenge,
};
