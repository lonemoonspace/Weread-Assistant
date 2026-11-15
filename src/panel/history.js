const fs = require("fs");
const path = require("path");
const { ACCOUNT_ID_PATTERN } = require("./accounts");
const { isValidDate } = require("./challenge");
const { DAY_MS, dateInZone } = require("./dates");
const { PanelError, badRequest } = require("./errors");
const { RUN_ID_PATTERN, readRunMeta } = require("./runs");

// 运行历史的读取与按保留策略清理。按天统计、打卡日历与挑战进度见 stats.js
// 阅读截图 screenshot-<分钟>.png，以及出错时的页面截图 error.png（排在最后）
const SCREENSHOT_PATTERN = /^(screenshot(-\d{1,5})?|error)\.png$/;
const MAX_PAGE_SIZE = 100;

// ---------- 读取运行记录 ----------

function runIdTime(runId) {
  const m = runId.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(\d{3})?Z/);
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], +(m[7] || 0)) : 0;
}

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
  // 按分钟排序，没有分钟的 screenshot.png 其次，error.png 最后
  const rankOf = (name) => {
    if (name === "error.png") {
      return Number.MAX_SAFE_INTEGER;
    }
    const m = name.match(/-(\d+)\.png$/);
    return m ? Number(m[1]) : Number.MAX_SAFE_INTEGER - 1;
  };
  return names.filter((name) => SCREENSHOT_PATTERN.test(name)).sort((a, b) => rankOf(a) - rankOf(b));
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

// 最新的在前；before 为上一页最后一个运行 ID；date（YYYY-MM-DD）时只列出面板时区中当天及以前排队的运行
function listRuns(panelDataDir, accountId, { limit = 20, before = "", date = "", timezone = "UTC" } = {}) {
  const size = Number(limit);
  if (!Number.isInteger(size) || size < 1 || size > MAX_PAGE_SIZE) {
    throw badRequest(`limit 必须是 1–${MAX_PAGE_SIZE} 的整数：${limit}`);
  }
  if (before && !RUN_ID_PATTERN.test(before)) {
    throw badRequest(`before 不是有效的运行 ID：${before}`);
  }
  if (date && !isValidDate(date)) {
    throw badRequest(`date 格式应为 YYYY-MM-DD：${date}`);
  }
  let ids = accountRunIds(panelDataDir, accountId).reverse();
  if (before) {
    ids = ids.filter((id) => id < before);
  }
  if (date) {
    ids = ids.filter((id) => dateInZone(new Date(runIdTime(id)), timezone) <= date);
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
  // 剩下的都是读不出来的记录时没有下一页。通常只需读取下一条（已缓存，下一页直接使用）；
  // 剩下的记录都读不出来时会逐条读完，读不出来的不缓存，每次请求都会重新读取
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

// ---------- 清理 ----------

// 账号数据目录中的遗留文件：旧版本发邮件时留下的附件截图 email-*.png，以及一天前的写入临时文件 *.tmp
// （写入中途进程被结束时留下）。返回删除的文件数
const LEFTOVER_TMP_AGE_MS = DAY_MS;

function cleanupAccountLeftovers(panelDataDir, now = Date.now()) {
  let removed = 0;
  const root = path.join(path.resolve(panelDataDir), "accounts");
  for (const accountId of listDirs(root)) {
    if (!ACCOUNT_ID_PATTERN.test(accountId)) {
      continue;
    }
    const dir = path.join(root, accountId);
    let names;
    try {
      names = fs.readdirSync(dir);
    } catch (_) {
      continue;
    }
    for (const name of names) {
      const file = path.join(dir, name);
      try {
        const stat = fs.statSync(file);
        const stale = /^email-.*\.png$/.test(name) || (name.endsWith(".tmp") && now - stat.mtimeMs > LEFTOVER_TMP_AGE_MS);
        if (stat.isFile() && stale) {
          fs.rmSync(file, { force: true });
          removed += 1;
        }
      } catch (_) {
        // 期间被删除的文件跳过
      }
    }
  }
  if (removed > 0) {
    console.info(`清理账号目录中的遗留文件 ${removed} 个（旧的邮件附件截图与临时文件）`);
  }
  return removed;
}

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
  cleanupAccountLeftovers(panelDataDir, now);
  if (removed.screenshots || removed.logs) {
    console.info(`按保留策略清理运行数据：删除截图 ${removed.screenshots} 张、日志 ${removed.logs} 份`);
  }
  return removed;
}

module.exports = {
  accountRunIds,
  cleanupRuns,
  getRun,
  lastRun,
  listRuns,
  minuteMarksOf,
  readMeta,
  runIdTime,
  runsRoot,
  screenshotPath,
};
