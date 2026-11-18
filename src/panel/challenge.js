const { addDays, daysBetween } = require("./dates");
const { badRequest } = require("./errors");

// 微信读书阅读挑战的规则：开始日起 days 天内打卡 requiredDays 天、累计阅读 requiredMinutes 分钟
const CHALLENGES = {
  month: { label: "月卡", days: 30, requiredDays: 29, requiredMinutes: 30 * 60 },
  year: { label: "年卡", days: 365, requiredDays: 360, requiredMinutes: 300 * 60 },
};

// 只认规则表自身的类型：constructor、toString 等继承属性不是挑战类型
function isChallengeType(type) {
  return typeof type === "string" && Object.hasOwn(CHALLENGES, type);
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

// YYYY-MM-DD 且是日历上存在的日期
function isValidDate(date) {
  if (typeof date !== "string" || !DATE_PATTERN.test(date)) {
    return false;
  }
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toISOString().slice(0, 10) === date;
}

const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const isCount = (value) => Number.isInteger(value) && value >= 0;

// 校准：截至 asOf 这一天（含）微信读书 App 中本轮挑战显示的累计分钟数与打卡天数。
// 进度 = 校准值 + 面板在 asOf 之后的记录
// today（YYYY-MM-DD，可选）：给出时校准日期不能晚于今天（用户保存时校验；备份导入与已保存的值不按当天校验）
function normalizeCalibration(raw, type, startDate, today = null) {
  if (!isObject(raw)) {
    throw badRequest("challenge.calibration 必须是对象或 null");
  }
  const unknown = Object.keys(raw).filter((key) => !["asOf", "minutes", "checkedDays"].includes(key));
  if (unknown.length > 0) {
    throw badRequest(`challenge.calibration 包含不支持的字段：${unknown.join(", ")}`);
  }
  const spec = CHALLENGES[type];
  const endDate = addDays(startDate, spec.days - 1);
  if (!isValidDate(raw.asOf)) {
    throw badRequest(`校准日期格式应为 YYYY-MM-DD：${raw.asOf}`);
  }
  if (raw.asOf < startDate || raw.asOf > endDate) {
    throw badRequest(`校准日期应在本轮挑战之内（${startDate} 至 ${endDate}）：${raw.asOf}`);
  }
  if (today && raw.asOf > today) {
    throw badRequest(`校准日期不能晚于今天（${today}）：${raw.asOf}`);
  }
  const days = daysBetween(startDate, raw.asOf) + 1;
  if (!isCount(raw.checkedDays) || raw.checkedDays > days) {
    throw badRequest(`已打卡天数应为 0–${days} 的整数（开始日期到校准日期共 ${days} 天）：${raw.checkedDays}`);
  }
  if (!isCount(raw.minutes) || raw.minutes > days * 1440) {
    throw badRequest(`已读分钟数应为 0–${days * 1440} 的整数：${raw.minutes}`);
  }
  return { asOf: raw.asOf, minutes: raw.minutes, checkedDays: raw.checkedDays };
}

// 账号的挑战设置：null 表示不设置；{ type: "month" | "year", startDate: "YYYY-MM-DD", calibration? }，
// calibration 见 normalizeCalibration，null 或不填表示不校准；options.today 见 normalizeCalibration
function normalizeChallenge(raw, { today = null } = {}) {
  if (raw === null) {
    return null;
  }
  if (!isObject(raw)) {
    throw badRequest("challenge 必须是对象或 null");
  }
  const unknown = Object.keys(raw).filter((key) => !["type", "startDate", "calibration"].includes(key));
  if (unknown.length > 0) {
    throw badRequest(`challenge 包含不支持的字段：${unknown.join(", ")}`);
  }
  if (!isChallengeType(raw.type)) {
    throw badRequest(`挑战类型只能是 ${Object.keys(CHALLENGES).join("、")}：${raw.type}`);
  }
  if (!isValidDate(raw.startDate)) {
    throw badRequest(`挑战开始日期格式应为 YYYY-MM-DD：${raw.startDate}`);
  }
  const challenge = { type: raw.type, startDate: raw.startDate };
  if (raw.calibration !== undefined && raw.calibration !== null) {
    challenge.calibration = normalizeCalibration(raw.calibration, raw.type, raw.startDate, today);
  }
  return challenge;
}

// panel.json 中保存的校准（可能被手工改坏）：无效时当作没有校准
function storedCalibration(challenge) {
  if (!challenge || challenge.calibration === undefined || challenge.calibration === null) {
    return null;
  }
  try {
    return normalizeCalibration(challenge.calibration, challenge.type, challenge.startDate);
  } catch (_) {
    return null;
  }
}

// panel.json 加载时清洗：校准无效时去掉校准，挑战本身保留
function storedChallenge(challenge) {
  if (!isObject(challenge)) {
    return null;
  }
  if (challenge.calibration === undefined || challenge.calibration === null) {
    return challenge;
  }
  const calibration = storedCalibration(challenge);
  if (calibration) {
    return { ...challenge, calibration };
  }
  const { calibration: _dropped, ...rest } = challenge;
  return rest;
}

module.exports = {
  CHALLENGES,
  isChallengeType,
  isValidDate,
  normalizeChallenge,
  storedCalibration,
  storedChallenge,
};
