const fs = require("fs");
const path = require("path");
const { ACCOUNT_ID_PATTERN } = require("./accounts");
const { CHALLENGES, isChallengeType, isValidDate } = require("./challenge");
const { PanelError, badRequest } = require("./errors");
const { RUN_ID_PATTERN, readRunMeta } = require("./runs");

// 运行历史、按天统计、打卡日历与挑战进度、按保留策略清理。
// 统计口径为本工具的运行记录（每分钟阅读进度），不是微信读书官方数据。

const NOTE = "按本工具运行记录统计，非微信读书官方数据";
// 当日阅读分钟数达到该值算作有效打卡
const CHECK_IN_MINUTES = 5;
const DAY_MS = 24 * 60 * 60 * 1000;
// 运行 ID 是排队时间。按日期范围挑选运行时前后多取几天，覆盖时区差与跨天的长时间运行
const RANGE_MARGIN_MS = 3 * DAY_MS;
const SCREENSHOT_PATTERN = /^screenshot(-\d{1,5})?\.png$/;
const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;
const MAX_PAGE_SIZE = 100;

// ---------- 日期 ----------

const formatters = new Map();

// 某个时刻在指定时区的日期，YYYY-MM-DD
function dateInZone(date, timezone) {
  let formatter = formatters.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" });
    formatters.set(timezone, formatter);
  }
  const parts = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function dateParts(date) {
  return date.split("-").map(Number);
}

// 纯日历运算，与时区无关
function addDays(date, days) {
  const [y, m, d] = dateParts(date);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

function daysBetween(from, to) {
  const [y1, m1, d1] = dateParts(from);
  const [y2, m2, d2] = dateParts(to);
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / DAY_MS);
}

function runIdTime(runId) {
  const m = runId.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(\d{3})?Z/);
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], +(m[7] || 0)) : 0;
}

// ---------- 读取运行记录 ----------

function runsRoot(panelDataDir) {
  return path.join(path.resolve(panelDataDir), "runs");
}

function listDirs(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch (e) {
    if (e.code === "ENOENT") {
      return [];
    }
    throw e;
  }
}

// 账号的运行 ID，按时间升序
function accountRunIds(panelDataDir, accountId) {
  return listDirs(path.join(runsRoot(panelDataDir), accountId))
    .filter((id) => RUN_ID_PATTERN.test(id))
    .sort();
}

// meta.json 按修改时间缓存，统计较长时间范围时不必每次都解析全部文件
const metaCache = new Map();

function readMeta(dir) {
  const file = path.join(dir, "meta.json");
  let stat;
  try {
    stat = fs.statSync(file);
  } catch (_) {
    metaCache.delete(dir);
    return null;
  }
  const cached = metaCache.get(dir);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    return cached.meta;
  }
  try {
    const meta = readRunMeta(dir);
    metaCache.set(dir, { mtimeMs: stat.mtimeMs, size: stat.size, meta });
    return meta;
  } catch (e) {
    console.warn("无法读取运行记录，跳过:", dir, e.message);
    return null;
  }
}

function listScreenshots(dir) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch (_) {
    return [];
  }
  const minuteOf = (name) => {
    const m = name.match(/-(\d+)\.png$/);
    return m ? Number(m[1]) : Infinity;
  };
  return names.filter((name) => SCREENSHOT_PATTERN.test(name)).sort((a, b) => minuteOf(a) - minuteOf(b));
}

// 每一分钟阅读完成的时间。第 7 步之前的记录没有逐分钟时间，按开始阅读后每分钟一条估算
function minuteMarksOf(meta) {
  if (Array.isArray(meta.minuteMarks)) {
    return meta.minuteMarks.filter((mark) => !Number.isNaN(Date.parse(mark)));
  }
  const minutes = Number.isSafeInteger(meta.minutes) && meta.minutes > 0 ? meta.minutes : 0;
  const start = Date.parse(meta.readingStartedAt || meta.startedAt || "");
  if (!minutes || Number.isNaN(start)) {
    return [];
  }
  return Array.from({ length: minutes }, (_, i) => new Date(start + (i + 1) * 60000).toISOString());
}

function runSummary(meta, dir) {
  const { minuteMarks, ...summary } = meta;
  return {
    ...summary,
    hasLog: fs.existsSync(path.join(dir, "output.log")),
    screenshots: listScreenshots(dir),
  };
}

function runDirOf(panelDataDir, accountId, runId) {
  if (!ACCOUNT_ID_PATTERN.test(accountId) || !RUN_ID_PATTERN.test(runId)) {
    return null;
  }
  return path.join(runsRoot(panelDataDir), accountId, runId);
}

// ---------- 运行历史 ----------

// 最新的在前；before 为上一页最后一个运行 ID
function listRuns(panelDataDir, accountId, { limit = 20, before = "" } = {}) {
  const size = Number(limit);
  if (!Number.isInteger(size) || size < 1 || size > MAX_PAGE_SIZE) {
    throw badRequest(`limit 必须是 1–${MAX_PAGE_SIZE} 的整数：${limit}`);
  }
  if (before && !RUN_ID_PATTERN.test(before)) {
    throw badRequest(`before 不是有效的运行 ID：${before}`);
  }
  let ids = accountRunIds(panelDataDir, accountId).reverse();
  if (before) {
    ids = ids.filter((id) => id < before);
  }
  const runs = [];
  let next = 0;
  for (; next < ids.length && runs.length < size; next += 1) {
    const dir = path.join(runsRoot(panelDataDir), accountId, ids[next]);
    const meta = readMeta(dir);
    if (meta) {
      runs.push(runSummary(meta, dir));
    }
  }
  // 剩下的都是读不出来的记录时没有下一页；通常只需读取下一条（已缓存，下一页直接使用）
  const more = ids.slice(next).some((id) => readMeta(path.join(runsRoot(panelDataDir), accountId, id)));
  return { runs, nextBefore: more ? ids[next - 1] : null };
}

// 单次运行：运行记录、截图列表，以及按天拆分的阅读分钟数
function getRun(panelDataDir, accountId, runId, timezone) {
  const dir = runDirOf(panelDataDir, accountId, runId);
  const meta = dir && readMeta(dir);
  if (!meta) {
    throw new PanelError(404, "run_not_found", "运行记录不存在");
  }
  const minutesByDate = {};
  for (const mark of minuteMarksOf(meta)) {
    const date = dateInZone(new Date(mark), timezone);
    minutesByDate[date] = (minutesByDate[date] || 0) + 1;
  }
  return { ...runSummary(meta, dir), minutesByDate };
}

function screenshotPath(panelDataDir, accountId, runId, name) {
  const dir = runDirOf(panelDataDir, accountId, runId);
  if (!dir || !SCREENSHOT_PATTERN.test(name) || !fs.existsSync(path.join(dir, name))) {
    throw new PanelError(404, "screenshot_not_found", "截图不存在");
  }
  return { dir, name };
}

function lastRun(panelDataDir, accountId) {
  const ids = accountRunIds(panelDataDir, accountId);
  for (let i = ids.length - 1; i >= 0; i -= 1) {
    const meta = readMeta(path.join(runsRoot(panelDataDir), accountId, ids[i]));
    if (meta) {
      const { id, mode, trigger, status, queuedAt, endedAt, minutes, error } = meta;
      return { id, mode, trigger, status, queuedAt, endedAt, minutes, error };
    }
  }
  return null;
}

// ---------- 按天统计 ----------

// from、to 为时区内的日期（含两端），返回 { 日期: 阅读分钟数 }。失败、停止的运行已读的部分也计入
function dailyMinutes(panelDataDir, accountId, { timezone, from, to }) {
  const [fy, fm, fd] = dateParts(from);
  const [ty, tm, td] = dateParts(to);
  const lower = Date.UTC(fy, fm - 1, fd) - RANGE_MARGIN_MS;
  const upper = Date.UTC(ty, tm - 1, td) + DAY_MS + RANGE_MARGIN_MS;
  const totals = {};
  for (const id of accountRunIds(panelDataDir, accountId)) {
    const queuedAt = runIdTime(id);
    if (queuedAt < lower || queuedAt > upper) {
      continue;
    }
    const meta = readMeta(path.join(runsRoot(panelDataDir), accountId, id));
    if (!meta) {
      continue;
    }
    for (const mark of minuteMarksOf(meta)) {
      const date = dateInZone(new Date(mark), timezone);
      if (date >= from && date <= to) {
        totals[date] = (totals[date] || 0) + 1;
      }
    }
  }
  return totals;
}

function todayStats(panelDataDir, accountId, { timezone, now = new Date() }) {
  const date = dateInZone(now, timezone);
  const minutes = dailyMinutes(panelDataDir, accountId, { timezone, from: date, to: date })[date] || 0;
  return { date, minutes, checkedIn: minutes >= CHECK_IN_MINUTES };
}

// 本轮挑战进度：第几天、已打卡天数、累计分钟、已漏打卡天数（不含今天）
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

  const upTo = today < end ? today : end;
  const totals = upTo >= start ? dailyMinutes(panelDataDir, account.id, { timezone, from: start, to: upTo }) : {};
  const checkedDates = Object.keys(totals).filter((date) => totals[date] >= CHECK_IN_MINUTES);
  const totalMinutes = Object.values(totals).reduce((sum, minutes) => sum + minutes, 0);
  // 已经过完的天：进行中时到昨天为止，结束后为整个周期
  const lastPastDay = status === "ended" ? end : addDays(today, -1);
  const pastDays = lastPastDay >= start ? daysBetween(start, lastPastDay) + 1 : 0;
  const checkedPastDays = checkedDates.filter((date) => date <= lastPastDay).length;

  return {
    type: challenge.type,
    label: spec.label,
    startDate: start,
    endDate: end,
    status,
    dayNumber: Math.min(Math.max(dayNumber, 0), spec.days),
    totalDays: spec.days,
    checkedDays: checkedDates.length,
    requiredDays: spec.requiredDays,
    totalMinutes,
    requiredMinutes: spec.requiredMinutes,
    missedDays: pastDays - checkedPastDays,
    allowedMissedDays: spec.days - spec.requiredDays,
    achieved: checkedDates.length >= spec.requiredDays && totalMinutes >= spec.requiredMinutes,
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

// ---------- 清理 ----------

// 截图只保留每个账号最近 screenshotRetentionRuns 次有截图的运行；日志保留 logRetentionDays 天；
// meta.json 永久保留。进行中的运行不清理
function cleanupRuns(panelDataDir, settings, { activeRunIds = new Set(), now = Date.now() } = {}) {
  const removed = { screenshots: 0, logs: 0 };
  const logCutoff = now - settings.logRetentionDays * DAY_MS;
  for (const accountId of listDirs(runsRoot(panelDataDir))) {
    if (!ACCOUNT_ID_PATTERN.test(accountId)) {
      continue;
    }
    let keptRuns = 0;
    for (const id of accountRunIds(panelDataDir, accountId).reverse()) {
      const dir = path.join(runsRoot(panelDataDir), accountId, id);
      const active = activeRunIds.has(id);
      const shots = listScreenshots(dir);
      if (shots.length > 0) {
        if (active || keptRuns < settings.screenshotRetentionRuns) {
          keptRuns += 1;
        } else {
          for (const name of shots) {
            fs.rmSync(path.join(dir, name), { force: true });
          }
          removed.screenshots += shots.length;
        }
      }
      const log = path.join(dir, "output.log");
      if (active || !fs.existsSync(log)) {
        continue;
      }
      const meta = readMeta(dir);
      const endedAt = Date.parse((meta && (meta.endedAt || meta.queuedAt)) || "") || runIdTime(id);
      if (endedAt < logCutoff) {
        fs.rmSync(log, { force: true });
        removed.logs += 1;
      }
    }
  }
  if (removed.screenshots || removed.logs) {
    console.info(`按保留策略清理运行数据：删除截图 ${removed.screenshots} 张、日志 ${removed.logs} 份`);
  }
  return removed;
}

module.exports = {
  CHECK_IN_MINUTES,
  NOTE,
  calendar,
  challengeProgress,
  cleanupRuns,
  dailyMinutes,
  dateInZone,
  getRun,
  lastRun,
  listRuns,
  screenshotPath,
  todayStats,
};
