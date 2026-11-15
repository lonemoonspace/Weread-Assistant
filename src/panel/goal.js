const { CHALLENGES, isChallengeType } = require("./challenge");
const { badRequest } = require("./errors");
const { TIME_PATTERN } = require("./schedules");

// 账号的每日目标：{ enabled, minutes, checkAt }。每天到 checkAt（面板时区），当天累计阅读分钟数低于 minutes 时补跑差额，
// 补跑不跨过零点、每天最多 MAX_CATCHUPS_PER_DAY 次，见 planner.js。null 表示没有设置
const MAX_GOAL_MINUTES = 1440;
const MAX_CATCHUPS_PER_DAY = 3;
// 补跑最晚读到当天的这个时刻（距零点的分钟数）：零点之后读的分钟算到第二天，对当天打卡没有帮助
const DAY_END_MINUTE = 23 * 60 + 57;

function normalizeGoal(raw) {
  if (raw === null) {
    return null;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw badRequest("goal 必须是对象或 null");
  }
  const unknown = Object.keys(raw).filter((key) => !["enabled", "minutes", "checkAt"].includes(key));
  if (unknown.length > 0) {
    throw badRequest(`goal 包含不支持的字段：${unknown.join(", ")}`);
  }
  if (raw.enabled !== undefined && typeof raw.enabled !== "boolean") {
    throw badRequest("goal.enabled 必须是 true 或 false");
  }
  if (!Number.isInteger(raw.minutes) || raw.minutes < 1 || raw.minutes > MAX_GOAL_MINUTES) {
    throw badRequest(`每日目标分钟数必须是 1–${MAX_GOAL_MINUTES} 的整数：${raw.minutes}`);
  }
  if (typeof raw.checkAt !== "string" || !TIME_PATTERN.test(raw.checkAt)) {
    throw badRequest(`检查时间格式应为 HH:MM（00:00–23:59）：${raw.checkAt}`);
  }
  return { enabled: raw.enabled !== false, minutes: raw.minutes, checkAt: raw.checkAt };
}

// panel.json 中的目标（可能被手工改坏）：无效时当作没有设置，不影响其他功能
function storedGoal(raw) {
  try {
    return raw === undefined ? null : normalizeGoal(raw);
  } catch (_) {
    return null;
  }
}

const minuteOfDay = (time) => {
  const [hour, minute] = time.split(":").map(Number);
  return hour * 60 + minute;
};

// 在 checkAt 开始补跑时最多能读的分钟数（读到 23:57 为止）
function catchupWindowMinutes(checkAt) {
  return Math.max(0, DAY_END_MINUTE - minuteOfDay(checkAt));
}

// 按挑战规则建议的每日分钟数：累计要求平均到每一天，向上取整到 5 分钟。没有挑战时为 null
function suggestedGoalMinutes(challenge) {
  if (!challenge || !isChallengeType(challenge.type)) {
    return null;
  }
  const spec = CHALLENGES[challenge.type];
  return Math.ceil(spec.requiredMinutes / spec.days / 5) * 5;
}

// 接口中返回的目标：附带按挑战的建议值，以及 checkAt 太晚、来不及补满目标时的提示
function publicGoal(goal, challenge) {
  const suggested = suggestedGoalMinutes(challenge);
  if (!goal) {
    return { goal: null, suggestedMinutes: suggested, warning: "" };
  }
  const window = catchupWindowMinutes(goal.checkAt);
  const warning =
    window < goal.minutes ? `${goal.checkAt} 检查时最多还能补读 ${window} 分钟（补跑读到 23:57 为止），当天差得多时补不满目标` : "";
  return { goal, suggestedMinutes: suggested, warning };
}

module.exports = {
  DAY_END_MINUTE,
  MAX_CATCHUPS_PER_DAY,
  catchupWindowMinutes,
  minuteOfDay,
  normalizeGoal,
  publicGoal,
  storedGoal,
  suggestedGoalMinutes,
};
