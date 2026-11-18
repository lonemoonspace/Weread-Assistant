const path = require("path");
const { CHALLENGES, isChallengeType, isValidDate, storedCalibration } = require("./challenge");
const { addDays, dateInZone, dateParts, daysBetween, weekdayIndex } = require("./dates");
const { badRequest } = require("./errors");
const { accountRunIds, minuteMarksOf, readMeta, runIdTime, runsRoot } = require("./history");
const { FINAL_STATUSES, onRunMetaWritten } = require("./runs");

// 按天统计、连续打卡、打卡日历、挑战进度与统计页的数据。
// 统计口径为本工具的运行记录（每分钟阅读进度），不是微信读书官方数据。

const NOTE = "按本工具运行记录统计，非微信读书官方数据";
// 当日阅读分钟数达到该值算作有效打卡
const CHECK_IN_MINUTES = 5;
const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;
const QUARTER_HOUR_MS = 15 * 60 * 1000;
// 统计页可选的趋势范围（天）
const RANGE_DAYS = [30, 90, 365];
// 热力图显示的天数
const HEATMAP_DAYS = 365;
// 热力图的颜色档位：0 为没有阅读，1–4 按分钟数由浅到深
const HEAT_LEVELS = [CHECK_IN_MINUTES, 30, 60, 120];

// ---------- 按天聚合的缓存 ----------
//
// 每个账号一份“日期 → 分钟数”的表，第一次用到时从运行记录建立，之后只重新读取有变化的运行：
// 新出现的、还没结束的、本进程刚写入过的（writeRunMeta 通知）。结束了的运行不再读取。
// 时区变化时作废重建。缓存只在内存里，运行记录仍然是唯一的数据来源
const caches = new Map();

// 本进程写入运行记录时，把那条运行标为需要重新读取
onRunMetaWritten((dir) => {
  const cache = caches.get(path.dirname(path.resolve(dir)));
  if (cache) {
    cache.dirty.add(path.basename(dir));
  }
});

// 现行时区的偏移都是 15 分钟的整数倍，同一个 15 分钟区间内的时刻日期相同：按区间缓存，
// 不必对每个分钟记录都调用一次 Intl（一年的记录有数万条）。偏移不是 15 分钟整数倍的历史时区
// （例如 1970 年代以前的一些地方时）在区间内跨过午夜时可能把这一刻算到相邻的一天
function dateLookup(timezone) {
  const dates = new Map();
  return (ms) => {
    const bucket = Math.floor(ms / QUARTER_HOUR_MS);
    let date = dates.get(bucket);
    if (date === undefined) {
      date = dateInZone(new Date(bucket * QUARTER_HOUR_MS), timezone);
      dates.set(bucket, date);
    }
    return date;
  };
}

// 一次运行对统计的贡献：按天拆分的分钟数，以及运行情况的计数用到的字段
function runContribution(meta, id, dateOf) {
  const days = {};
  for (const mark of minuteMarksOf(meta)) {
    const date = dateOf(Date.parse(mark));
    days[date] = (days[date] || 0) + 1;
  }
  const queued = Date.parse(meta.queuedAt || "") || runIdTime(id);
  return {
    meta,
    final: FINAL_STATUSES.includes(meta.status),
    days,
    run: {
      date: dateOf(queued),
      mode: meta.mode,
      status: meta.status,
      trigger: meta.trigger,
      errorKind: meta.errorKind || "",
      loginPrompted: meta.loginPrompted === true,
    },
  };
}

function applyDays(totals, days, sign) {
  for (const [date, minutes] of Object.entries(days)) {
    const value = (totals.get(date) || 0) + sign * minutes;
    if (value > 0) {
      totals.set(date, value);
    } else {
      totals.delete(date);
    }
  }
}

// 账号的按天分钟数（Map：日期 → 分钟数）与各次运行的摘要，必要时增量更新后返回
function accountDays(panelDataDir, accountId, timezone) {
  const key = path.join(runsRoot(panelDataDir), accountId);
  let cache = caches.get(key);
  if (!cache || cache.timezone !== timezone) {
    cache = { timezone, dateOf: dateLookup(timezone), runs: new Map(), totals: new Map(), dirty: new Set() };
    caches.set(key, cache);
  }
  const ids = accountRunIds(panelDataDir, accountId);
  const present = new Set(ids);
  for (const [id, entry] of cache.runs) {
    if (!present.has(id)) {
      applyDays(cache.totals, entry.days, -1);
      cache.runs.delete(id);
    }
  }
  for (const id of ids) {
    const entry = cache.runs.get(id);
    if (entry && entry.final && !cache.dirty.has(id)) {
      continue;
    }
    // 新出现的、还没结束的与本进程刚写入过的运行重新读取
    cache.dirty.delete(id);
    const meta = readMeta(path.join(key, id));
    if (entry) {
      applyDays(cache.totals, entry.days, -1);
      cache.runs.delete(id);
    }
    if (meta) {
      const next = runContribution(meta, id, cache.dateOf);
      applyDays(cache.totals, next.days, 1);
      cache.runs.set(id, next);
    }
  }
  return cache;
}

// 不经过缓存、从运行记录重新计算的按天分钟数（测试中用来核对缓存）
function rebuildDays(panelDataDir, accountId, timezone) {
  const dateOf = dateLookup(timezone);
  const totals = new Map();
  for (const id of accountRunIds(panelDataDir, accountId)) {
    const meta = readMeta(path.join(runsRoot(panelDataDir), accountId, id));
    if (meta) {
      applyDays(totals, runContribution(meta, id, dateOf).days, 1);
    }
  }
  return totals;
}

// 账号的缓存是否已经建立（同一时区）
function hasAccountDays(panelDataDir, accountId, timezone) {
  const cache = caches.get(path.join(runsRoot(panelDataDir), accountId));
  return Boolean(cache) && cache.timezone === timezone;
}

// 在后台逐个账号建立缓存：总览不必等第一次全量读取（运行记录多时每个账号要一百多毫秒）。
// 每个账号之间让出事件循环，同一账号只排一次
const warming = new Set();
let warmScheduled = false;
function warmAccountDays(panelDataDir, accountId, timezone) {
  warming.add(JSON.stringify([panelDataDir, accountId, timezone]));
  if (warmScheduled) {
    return;
  }
  warmScheduled = true;
  const next = () => {
    const [item] = warming;
    if (!item) {
      warmScheduled = false;
      return;
    }
    warming.delete(item);
    const [dir, id, zone] = JSON.parse(item);
    try {
      accountDays(dir, id, zone);
    } catch (e) {
      console.warn(`统计账号 ${id} 的运行记录失败:`, e.message);
    }
    setImmediate(next);
  };
  setImmediate(next);
}

// 不建立缓存、只读取日期范围附近的运行记录得到按天分钟数（缓存建立之前总览用）
const RANGE_MARGIN_MS = 3 * 24 * 60 * 60 * 1000;
function scanDays(panelDataDir, accountId, { timezone, from, to }) {
  const [fy, fm, fd] = dateParts(from);
  const [ty, tm, td] = dateParts(to);
  const lower = Date.UTC(fy, fm - 1, fd) - RANGE_MARGIN_MS;
  const upper = Date.UTC(ty, tm - 1, td) + RANGE_MARGIN_MS + 24 * 60 * 60 * 1000;
  const dateOf = dateLookup(timezone);
  const totals = new Map();
  for (const id of accountRunIds(panelDataDir, accountId)) {
    const queuedAt = runIdTime(id);
    if (queuedAt < lower || queuedAt > upper) {
      continue;
    }
    const meta = readMeta(path.join(runsRoot(panelDataDir), accountId, id));
    if (meta) {
      const days = runContribution(meta, id, dateOf).days;
      applyDays(totals, Object.fromEntries(Object.entries(days).filter(([date]) => date >= from && date <= to)), 1);
    }
  }
  return totals;
}

// 删除账号后丢掉它的缓存
function dropAccountDays(panelDataDir, accountId) {
  caches.delete(path.join(runsRoot(panelDataDir), accountId));
}

function clearStatsCache() {
  caches.clear();
}

// ---------- 按天统计 ----------

// from、to 为时区内的日期（含两端），返回 { 日期: 阅读分钟数 }。失败、停止的运行已读的部分也计入
function dailyMinutes(panelDataDir, accountId, { timezone, from, to }) {
  const result = {};
  for (const [date, minutes] of accountDays(panelDataDir, accountId, timezone).totals) {
    if (date >= from && date <= to) {
      result[date] = minutes;
    }
  }
  return result;
}

// 今天的分钟数。缓存还没建立时只读取今天附近的运行记录，不触发全量读取（总览每个账号都要调用）
function todayStats(panelDataDir, accountId, { timezone, now = new Date() }) {
  const date = dateInZone(now, timezone);
  const totals = hasAccountDays(panelDataDir, accountId, timezone)
    ? accountDays(panelDataDir, accountId, timezone).totals
    : scanDays(panelDataDir, accountId, { timezone, from: date, to: date });
  const minutes = totals.get(date) || 0;
  return { date, minutes, checkedIn: minutes >= CHECK_IN_MINUTES };
}

// 连续打卡天数。isChecked(date) 判断某天是否打卡；今天还没打卡时不算中断，从昨天往前数
function currentStreak(isChecked, today) {
  let day = isChecked(today) ? today : addDays(today, -1);
  let count = 0;
  while (isChecked(day)) {
    count += 1;
    day = addDays(day, -1);
  }
  return count;
}

// 最长连续打卡天数与结束日期。dates 为打卡的日期（任意顺序）
function longestStreak(dates) {
  const sorted = [...dates].sort();
  let best = { days: 0, endDate: null };
  let run = 0;
  for (let i = 0; i < sorted.length; i += 1) {
    run = i > 0 && daysBetween(sorted[i - 1], sorted[i]) === 1 ? run + 1 : 1;
    if (run > best.days) {
      best = { days: run, endDate: sorted[i] };
    }
  }
  return best;
}

// 账号的当前连续打卡天数（总览的账号卡片用）。lazy 为 true 时缓存还没建立就返回 null，并在后台建立，
// 下次刷新时显示，不让总览等全量读取
function accountStreak(panelDataDir, accountId, { timezone, now = new Date(), lazy = false }) {
  if (lazy && !hasAccountDays(panelDataDir, accountId, timezone)) {
    warmAccountDays(panelDataDir, accountId, timezone);
    return null;
  }
  const { totals } = accountDays(panelDataDir, accountId, timezone);
  return currentStreak((date) => (totals.get(date) || 0) >= CHECK_IN_MINUTES, dateInZone(now, timezone));
}

// from 到 to（含两端）的累计分钟与打卡天数
function rangeTotals(minutesOf, checkedOf, from, to) {
  let minutes = 0;
  let checkedDays = 0;
  for (let date = from; date <= to; date = addDays(date, 1)) {
    minutes += minutesOf(date);
    checkedDays += checkedOf(date) ? 1 : 0;
  }
  return { from, to, minutes, checkedDays };
}

// ---------- 挑战与日历 ----------

// 本轮挑战进度：第几天、已打卡天数、累计分钟、已漏打卡天数（不含今天），
// 以及要达成目标剩余每天平均还需读多少分钟、还能漏几天。
// 设了校准时，校准日（含）之前按校准值（App 中显示的数字），之后按面板的运行记录
function challengeProgress(panelDataDir, account, { timezone, now = new Date() }) {
  const { challenge } = account;
  if (!challenge || !isChallengeType(challenge.type) || !isValidDate(challenge.startDate)) {
    return null;
  }
  const spec = CHALLENGES[challenge.type];
  const start = challenge.startDate;
  const end = addDays(start, spec.days - 1);
  const today = dateInZone(now, timezone);
  const dayNumber = daysBetween(start, today) + 1;
  const status = dayNumber < 1 ? "not-started" : dayNumber > spec.days ? "ended" : "active";

  const calibration = storedCalibration(challenge);
  // 面板记录从这一天算起：校准日的次日，没有校准时为开始日期
  const from = calibration ? addDays(calibration.asOf, 1) : start;
  const upTo = today < end ? today : end;
  const totals = upTo >= from ? dailyMinutes(panelDataDir, account.id, { timezone, from, to: upTo }) : {};
  const checkedDates = Object.keys(totals).filter((date) => totals[date] >= CHECK_IN_MINUTES);
  const panelMinutes = Object.values(totals).reduce((sum, minutes) => sum + minutes, 0);
  const totalMinutes = (calibration ? calibration.minutes : 0) + panelMinutes;
  const checkedDays = (calibration ? calibration.checkedDays : 0) + checkedDates.length;
  // 已经过完的天：进行中时到昨天为止，结束后为整个周期
  const lastPastDay = status === "ended" ? end : addDays(today, -1);
  const daysIn = (first, last) => (last >= first ? daysBetween(first, last) + 1 : 0);
  // 校准范围内已过完的天数减去校准的打卡天数（校准日当天还没过完时，它的打卡也算进去，最多少算一天）；之后按面板记录
  const calibratedMissed = calibration
    ? Math.max(0, daysIn(start, calibration.asOf < lastPastDay ? calibration.asOf : lastPastDay) - calibration.checkedDays)
    : 0;
  const checkedPastDays = checkedDates.filter((date) => date <= lastPastDay).length;
  const missedDays = calibratedMissed + daysIn(from, lastPastDay) - checkedPastDays;
  const allowedMissedDays = spec.days - spec.requiredDays;
  // 还剩的天数（进行中时含今天）
  const remainingDays = status === "ended" ? 0 : status === "not-started" ? spec.days : spec.days - dayNumber + 1;
  const minutesLeft = Math.max(0, spec.requiredMinutes - totalMinutes);

  return {
    type: challenge.type,
    label: spec.label,
    startDate: start,
    endDate: end,
    status,
    dayNumber: Math.min(Math.max(dayNumber, 0), spec.days),
    totalDays: spec.days,
    checkedDays,
    requiredDays: spec.requiredDays,
    totalMinutes,
    requiredMinutes: spec.requiredMinutes,
    missedDays,
    allowedMissedDays,
    remainingDays,
    missesLeft: Math.max(0, allowedMissedDays - missedDays),
    minutesPerDayNeeded: remainingDays > 0 ? Math.ceil(minutesLeft / remainingDays) : null,
    achieved: checkedDays >= spec.requiredDays && totalMinutes >= spec.requiredMinutes,
    calibration,
  };
}

// 打卡日历：一个月中每天的阅读分钟数与是否打卡，以及今天与本轮挑战进度
function calendar(panelDataDir, account, { timezone, month, now = new Date() }) {
  const today = dateInZone(now, timezone);
  const targetMonth = month || today.slice(0, 7);
  if (!MONTH_PATTERN.test(targetMonth)) {
    throw badRequest(`month 格式应为 YYYY-MM：${month}`);
  }
  const first = `${targetMonth}-01`;
  const [y, m] = dateParts(first);
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const last = addDays(first, daysInMonth - 1);
  const totals = dailyMinutes(panelDataDir, account.id, { timezone, from: first, to: last });
  const days = Array.from({ length: daysInMonth }, (_, i) => {
    const date = addDays(first, i);
    const minutes = totals[date] || 0;
    return { date, minutes, checkedIn: minutes >= CHECK_IN_MINUTES, future: date > today };
  });
  return {
    timezone,
    month: targetMonth,
    checkInMinutes: CHECK_IN_MINUTES,
    today: todayStats(panelDataDir, account.id, { timezone, now }),
    days,
    monthMinutes: days.reduce((sum, day) => sum + day.minutes, 0),
    monthCheckedDays: days.filter((day) => day.checkedIn).length,
    challenge: challengeProgress(panelDataDir, account, { timezone, now }),
    note: NOTE,
  };
}

// ---------- 统计页 ----------

function heatLevel(minutes) {
  let level = 0;
  while (level < HEAT_LEVELS.length && minutes >= HEAT_LEVELS[level]) {
    level += 1;
  }
  return level;
}

// 运行情况：from 起（含）各结果、各触发方式的次数，自动重试救回、补跑与需要扫码的次数
function runCounts(entries, from) {
  const counts = {
    total: 0,
    byStatus: { success: 0, failed: 0, stopped: 0, interrupted: 0 },
    byTrigger: { manual: 0, schedule: 0, split: 0, retry: 0, catchup: 0, resume: 0 },
    rescued: 0,
    catchups: 0,
    loginPrompted: 0,
  };
  for (const { run } of entries) {
    if (run.date < from || !FINAL_STATUSES.includes(run.status)) {
      continue;
    }
    counts.total += 1;
    counts.byStatus[run.status] += 1;
    if (Object.hasOwn(counts.byTrigger, run.trigger)) {
      counts.byTrigger[run.trigger] += 1;
    }
    // 只算失败重试救回的；重启后恢复的运行不是因为失败，不计入
    if (run.trigger === "retry" && run.status === "success") {
      counts.rescued += 1;
    }
    if (run.trigger === "catchup") {
      counts.catchups += 1;
    }
    if (run.loginPrompted) {
      counts.loginPrompted += 1;
    }
  }
  return counts;
}

// 统计页的数据。accounts 为要统计的账号（一个或全部）；多个账号时每天的分钟数相加，
// 某天有任何一个账号打卡即算打卡
function statsReport(panelDataDir, accounts, { timezone, days = 30, now = new Date() }) {
  const rangeDays = Number(days);
  if (!RANGE_DAYS.includes(rangeDays)) {
    throw badRequest(`days 只能是 ${RANGE_DAYS.join("、")}：${days}`);
  }
  const today = dateInZone(now, timezone);
  const tables = accounts.map((account) => accountDays(panelDataDir, account.id, timezone));
  const minutesOf = (date) => tables.reduce((sum, cache) => sum + (cache.totals.get(date) || 0), 0);
  const checkedOf = (date) => tables.some((cache) => (cache.totals.get(date) || 0) >= CHECK_IN_MINUTES);
  const checkedDates = new Set();
  for (const cache of tables) {
    for (const [date, minutes] of cache.totals) {
      if (minutes >= CHECK_IN_MINUTES && date <= today) {
        checkedDates.add(date);
      }
    }
  }
  const series = (count) =>
    Array.from({ length: count }, (_, i) => {
      const date = addDays(today, i - count + 1);
      const minutes = minutesOf(date);
      return { date, minutes, checkedIn: checkedOf(date) };
    });
  const last30 = rangeTotals(minutesOf, checkedOf, addDays(today, -29), today);
  const single = accounts.length === 1 ? accounts[0] : null;
  const goal = single && single.goal && single.goal.enabled ? single.goal.minutes : null;

  return {
    timezone,
    today,
    rangeDays,
    checkInMinutes: CHECK_IN_MINUTES,
    goalMinutes: goal,
    summary: {
      currentStreak: currentStreak((date) => checkedDates.has(date), today),
      longestStreak: longestStreak(checkedDates),
      week: rangeTotals(minutesOf, checkedOf, addDays(today, -weekdayIndex(today)), today),
      month: rangeTotals(minutesOf, checkedOf, `${today.slice(0, 7)}-01`, today),
      year: rangeTotals(minutesOf, checkedOf, `${today.slice(0, 4)}-01-01`, today),
      last30,
      averageMinutes30: Math.round((last30.minutes / 30) * 10) / 10,
    },
    trend: series(rangeDays),
    heatmap: series(HEATMAP_DAYS).map((day) => ({ ...day, level: heatLevel(day.minutes) })),
    heatLevels: HEAT_LEVELS,
    runs: runCounts(
      tables.flatMap((cache) => [...cache.runs.values()]),
      addDays(today, -rangeDays + 1)
    ),
    challenge: single ? challengeProgress(panelDataDir, single, { timezone, now }) : null,
    note: NOTE,
  };
}

module.exports = {
  CHECK_IN_MINUTES,
  HEAT_LEVELS,
  NOTE,
  RANGE_DAYS,
  accountDays,
  accountStreak,
  calendar,
  challengeProgress,
  clearStatsCache,
  currentStreak,
  dropAccountDays,
  dailyMinutes,
  dateInZone,
  heatLevel,
  longestStreak,
  rebuildDays,
  statsReport,
  todayStats,
  warmAccountDays,
};
