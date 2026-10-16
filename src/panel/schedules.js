const crypto = require("crypto");
const { Cron } = require("croner");
const { badRequest } = require("./errors");

// 账号的调度规则，时间按面板设置中的时区解释：
//   { id, type: "daily", times: ["06:00", "18:30"], enabled }      每天固定时间
//   { id, type: "interval", hours: 6, minute: 0, enabled }         每 N 小时（N 为 24 的约数，从 0 点起算）
//   { id, type: "cron", expression: "30 6 * * 1-5", enabled }      5 段 cron 表达式（分 时 日 月 周）
const SCHEDULE_TYPES = ["daily", "interval", "cron"];
const INTERVAL_HOURS = [1, 2, 3, 4, 6, 8, 12];
const MAX_SCHEDULES = 10;
const MAX_DAILY_TIMES = 24;
const PREVIEW_COUNT = 5;
const SCHEDULE_ID_PATTERN = /^[a-z0-9]{1,16}$/;
const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

const FIELDS_BY_TYPE = {
  daily: ["times"],
  interval: ["hours", "minute"],
  cron: ["expression"],
};

const pad2 = (n) => String(n).padStart(2, "0");

function newScheduleId() {
  return crypto.randomBytes(3).toString("hex");
}

function isIntegerIn(value, min, max) {
  return Number.isInteger(value) && value >= min && value <= max;
}

// 校验单条规则并返回规范化的副本；prefix 用于错误信息，例如“第 2 条规则”
function normalizeSchedule(raw, prefix) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw badRequest(`${prefix}必须是对象`);
  }
  if (!SCHEDULE_TYPES.includes(raw.type)) {
    throw badRequest(`${prefix}的类型只能是 ${SCHEDULE_TYPES.join("、")}：${raw.type}`);
  }
  const allowed = new Set(["id", "type", "enabled", ...FIELDS_BY_TYPE[raw.type]]);
  const unknown = Object.keys(raw).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw badRequest(`${prefix}包含不支持的字段：${unknown.join(", ")}`);
  }
  if (raw.enabled !== undefined && typeof raw.enabled !== "boolean") {
    throw badRequest(`${prefix}的 enabled 必须是 true 或 false`);
  }
  if (raw.id !== undefined && !(typeof raw.id === "string" && SCHEDULE_ID_PATTERN.test(raw.id))) {
    throw badRequest(`${prefix}的 ID 只能包含小写字母与数字，1–16 位：${raw.id}`);
  }
  const rule = { id: raw.id || "", type: raw.type };

  if (raw.type === "daily") {
    if (!Array.isArray(raw.times) || raw.times.length === 0 || raw.times.length > MAX_DAILY_TIMES) {
      throw badRequest(`${prefix}需要 1–${MAX_DAILY_TIMES} 个时间`);
    }
    for (const time of raw.times) {
      if (typeof time !== "string" || !TIME_PATTERN.test(time)) {
        throw badRequest(`${prefix}的时间格式应为 HH:MM（00:00–23:59）：${time}`);
      }
    }
    rule.times = [...new Set(raw.times)].sort();
  } else if (raw.type === "interval") {
    if (!INTERVAL_HOURS.includes(raw.hours)) {
      throw badRequest(`${prefix}的间隔小时数只能是 ${INTERVAL_HOURS.join("、")}：${raw.hours}`);
    }
    const minute = raw.minute === undefined ? 0 : raw.minute;
    if (!isIntegerIn(minute, 0, 59)) {
      throw badRequest(`${prefix}的分钟必须是 0–59 的整数：${raw.minute}`);
    }
    rule.hours = raw.hours;
    rule.minute = minute;
  } else {
    const expression = typeof raw.expression === "string" ? raw.expression.trim().replace(/\s+/g, " ") : "";
    if (expression.split(" ").length !== 5 || expression.startsWith("@")) {
      throw badRequest(`${prefix}的 cron 表达式必须是 5 段（分 时 日 月 周）：${raw.expression}`);
    }
    let job;
    try {
      job = new Cron(expression);
    } catch (e) {
      throw badRequest(`${prefix}的 cron 表达式无效：${e.message}`);
    }
    if (!job.nextRun()) {
      throw badRequest(`${prefix}的 cron 表达式不会触发：${expression}`);
    }
    rule.expression = expression;
  }

  rule.enabled = raw.enabled !== false;
  return rule;
}

// 校验整组规则；没有 ID 或 ID 重复的规则分配新 ID
function normalizeSchedules(list) {
  if (!Array.isArray(list)) {
    throw badRequest("schedules 必须是数组");
  }
  if (list.length > MAX_SCHEDULES) {
    throw badRequest(`每个账号最多 ${MAX_SCHEDULES} 条调度规则`);
  }
  const rules = list.map((raw, index) => normalizeSchedule(raw, `第 ${index + 1} 条规则`));
  const used = new Set();
  for (const rule of rules) {
    if (!rule.id || used.has(rule.id)) {
      do {
        rule.id = newScheduleId();
      } while (used.has(rule.id));
    }
    used.add(rule.id);
  }
  return rules;
}

// 规则对应的 cron 表达式（每天固定时间每个时间一条）
function schedulePatterns(rule) {
  if (rule.type === "daily") {
    return rule.times.map((time) => {
      const [hour, minute] = time.split(":").map(Number);
      return `${minute} ${hour} * * *`;
    });
  }
  if (rule.type === "interval") {
    return [`${rule.minute} ${rule.hours === 1 ? "*" : `*/${rule.hours}`} * * *`];
  }
  return [rule.expression];
}

function describeSchedule(rule) {
  if (rule.type === "daily") {
    return `每天 ${rule.times.join("、")}`;
  }
  if (rule.type === "interval") {
    return `每 ${rule.hours} 小时（从 00:${pad2(rule.minute)} 起）`;
  }
  return `cron ${rule.expression}`;
}

// 规则接下来的触发时间（ISO 字符串，升序）；规则无效时返回空数组
function nextRuns(rule, { timezone, from = new Date(), count = PREVIEW_COUNT } = {}) {
  const times = new Set();
  try {
    for (const pattern of schedulePatterns(rule)) {
      for (const date of new Cron(pattern, { timezone }).nextRuns(count, from)) {
        times.add(date.toISOString());
      }
    }
  } catch (_) {
    return [];
  }
  return [...times].sort().slice(0, count);
}

// 账号下一次定时运行的时间；账号停用或没有启用的规则时为 null
function nextRunAt(account, timezone, from = new Date()) {
  if (!account.enabled) {
    return null;
  }
  const candidates = (account.schedules || [])
    .filter((rule) => rule.enabled)
    .map((rule) => nextRuns(rule, { timezone, from, count: 1 })[0])
    .filter(Boolean)
    .sort();
  return candidates[0] || null;
}

// 接口中返回的规则：附带说明与接下来的触发时间
function publicSchedule(rule, timezone, from = new Date()) {
  return {
    ...rule,
    description: describeSchedule(rule),
    nextRuns: rule.enabled ? nextRuns(rule, { timezone, from }) : [],
  };
}

module.exports = {
  INTERVAL_HOURS,
  MAX_SCHEDULES,
  describeSchedule,
  nextRunAt,
  nextRuns,
  normalizeSchedules,
  publicSchedule,
  schedulePatterns,
};
