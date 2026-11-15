const { after, beforeEach, describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { newRunId, writeRunMeta } = require("../../src/panel/runs");
const {
  accountDays,
  accountStreak,
  clearStatsCache,
  currentStreak,
  heatLevel,
  longestStreak,
  rebuildDays,
  statsReport,
} = require("../../src/panel/stats");

const tempDirs = [];
after(() => tempDirs.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));
beforeEach(() => clearStatsCache());

function dataDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wa-stats-"));
  tempDirs.push(dir);
  return dir;
}

function marks(start, count) {
  const t = Date.parse(start);
  return Array.from({ length: count }, (_, i) => new Date(t + (i + 1) * 60000).toISOString());
}

// 写一条运行记录，返回运行目录
function writeRun(dir, accountId, { queuedAt, minutes = 0, status = "success", extra = {} }) {
  const id = newRunId(new Date(queuedAt));
  const runDir = path.join(dir, "runs", accountId, id);
  fs.mkdirSync(runDir, { recursive: true });
  const meta = { id, accountId, mode: "read", trigger: "schedule", status, queuedAt, minutes, minuteMarks: marks(queuedAt, minutes), ...extra };
  fs.writeFileSync(path.join(runDir, "meta.json"), JSON.stringify(meta));
  return runDir;
}

// 上海时间某天 10:00 开始读 minutes 分钟
const readOn = (dir, date, minutes, { status, ...extra } = {}) =>
  writeRun(dir, "me", { queuedAt: new Date(Date.parse(`${date}T10:00:00+08:00`)).toISOString(), minutes, status, extra });

const asObject = (map) => Object.fromEntries([...map].sort());
const TZ = "Asia/Shanghai";

describe("连续打卡", () => {
  it("今天还没打卡时不算中断，从昨天往前数；中间断一天就重新计", () => {
    const checked = new Set(["2026-11-10", "2026-11-12", "2026-11-13", "2026-11-14"]);
    assert.equal(currentStreak((date) => checked.has(date), "2026-11-15"), 3);
    checked.add("2026-11-15");
    assert.equal(currentStreak((date) => checked.has(date), "2026-11-15"), 4);
    assert.equal(currentStreak((date) => checked.has(date), "2026-11-17"), 0, "昨天也没打卡时为 0");
  });

  it("最长记录可以跨月、跨年", () => {
    assert.deepEqual(longestStreak(["2026-01-02", "2025-12-30", "2025-12-31", "2026-01-01", "2026-03-01"]), { days: 4, endDate: "2026-01-02" });
    assert.deepEqual(longestStreak([]), { days: 0, endDate: null });
  });

  it("账号的连续天数按 5 分钟打卡线计算", () => {
    const dir = dataDir();
    readOn(dir, "2026-11-12", 10);
    readOn(dir, "2026-11-13", 4);
    readOn(dir, "2026-11-14", 6);
    const now = new Date("2026-11-15T03:00:00Z");
    assert.equal(accountStreak(dir, "me", { timezone: TZ, now }), 1, "13 日只读了 4 分钟，不算打卡");
  });
});

describe("统计页数据", () => {
  it("本周、本月、今年的累计跨月与跨年计算正确，近 30 天日均", () => {
    const dir = dataDir();
    readOn(dir, "2025-12-31", 20);
    readOn(dir, "2026-01-01", 30);
    readOn(dir, "2026-01-05", 10);
    readOn(dir, "2026-01-06", 3);
    const report = statsReport(dir, [{ id: "me" }], { timezone: TZ, days: 30, now: new Date("2026-01-06T12:00:00Z") });
    // 2026-01-06 是周二，本周从 01-05 开始
    assert.deepEqual(report.summary.week, { from: "2026-01-05", to: "2026-01-06", minutes: 13, checkedDays: 1 });
    assert.deepEqual(report.summary.month, { from: "2026-01-01", to: "2026-01-06", minutes: 43, checkedDays: 2 });
    assert.equal(report.summary.year.minutes, 43, "去年的不计入今年");
    assert.equal(report.summary.last30.minutes, 63);
    assert.equal(report.summary.averageMinutes30, 2.1);
    assert.equal(report.summary.currentStreak, 1, "今天未达打卡线，从昨天往前数");
    assert.deepEqual(report.summary.longestStreak, { days: 2, endDate: "2026-01-01" });
    assert.equal(report.trend.length, 30);
    assert.deepEqual(report.trend.at(-1), { date: "2026-01-06", minutes: 3, checkedIn: false });
    assert.equal(report.heatmap.length, 365);
    assert.deepEqual(
      [0, 4, 5, 29, 30, 60, 120, 600].map(heatLevel),
      [0, 0, 1, 1, 2, 3, 4, 4]
    );
    assert.throws(() => statsReport(dir, [{ id: "me" }], { timezone: TZ, days: 7 }), /days 只能是/);
  });

  it("多个账号时分钟数相加，任一账号打卡即算打卡", () => {
    const dir = dataDir();
    readOn(dir, "2026-11-14", 3);
    writeRun(dir, "other", { queuedAt: "2026-11-14T02:00:00Z", minutes: 6 });
    const now = new Date("2026-11-14T12:00:00Z");
    const report = statsReport(dir, [{ id: "me" }, { id: "other" }], { timezone: TZ, now });
    assert.deepEqual(report.trend.at(-1), { date: "2026-11-14", minutes: 9, checkedIn: true });
    const single = statsReport(dir, [{ id: "me", goal: { enabled: true, minutes: 30 } }], { timezone: TZ, now });
    assert.equal(single.trend.at(-1).checkedIn, false);
    assert.equal(single.goalMinutes, 30);
  });

  it("运行情况：各结果与触发方式的次数、重试救回、补跑与需要扫码的次数；范围外与进行中的不计", () => {
    const dir = dataDir();
    readOn(dir, "2026-11-10", 5, { trigger: "schedule", status: "failed", errorKind: "error" });
    readOn(dir, "2026-11-10", 5, { trigger: "retry", status: "success" });
    readOn(dir, "2026-11-11", 5, { trigger: "catchup", status: "success" });
    readOn(dir, "2026-11-12", 0, { trigger: "manual", status: "failed", errorKind: "login-timeout", loginPrompted: true });
    readOn(dir, "2026-11-13", 2, { trigger: "manual", status: "stopped" });
    readOn(dir, "2026-11-14", 1, { trigger: "schedule", status: "reading" });
    readOn(dir, "2026-09-01", 30, { trigger: "manual", status: "success" });
    const { runs } = statsReport(dir, [{ id: "me" }], { timezone: TZ, now: new Date("2026-11-14T12:00:00Z") });
    assert.deepEqual(runs, {
      total: 5,
      byStatus: { success: 2, failed: 2, stopped: 1, interrupted: 0 },
      byTrigger: { manual: 2, schedule: 1, retry: 1, catchup: 1, resume: 0 },
      rescued: 1,
      catchups: 1,
      loginPrompted: 1,
    });
  });

  it("挑战：剩余每天平均还需读多少分钟、还能漏几天", () => {
    const dir = dataDir();
    readOn(dir, "2026-11-01", 60);
    readOn(dir, "2026-11-03", 60);
    const account = { id: "me", challenge: { type: "month", startDate: "2026-11-01" } };
    const { challenge } = statsReport(dir, [account], { timezone: TZ, now: new Date("2026-11-05T12:00:00Z") });
    // 第 5 天，已漏 2 天（2 日、4 日），月卡允许漏 1 天；累计 120 分钟，还差 1680 分钟，剩 26 天
    assert.equal(challenge.missedDays, 2);
    assert.equal(challenge.missesLeft, 0);
    assert.equal(challenge.remainingDays, 26);
    assert.equal(challenge.minutesPerDayNeeded, Math.ceil(1680 / 26));
  });
});

describe("按天聚合的缓存", () => {
  it("增量更新与从运行记录全量重算的结果一致：新增、进行中的运行有进度、本进程改写已结束的运行、删除运行", () => {
    const dir = dataDir();
    readOn(dir, "2026-11-01", 10);
    const ongoing = readOn(dir, "2026-11-02", 3, { status: "reading" });
    const check = () => assert.deepEqual(asObject(accountDays(dir, "me", TZ).totals), asObject(rebuildDays(dir, "me", TZ)));
    check();
    readOn(dir, "2026-11-03", 7);
    check();
    // 进行中的运行有进度：直接改写文件（例如其他进程），也会重新读取
    const meta = JSON.parse(fs.readFileSync(path.join(ongoing, "meta.json"), "utf8"));
    meta.minutes = 8;
    meta.minuteMarks = marks(meta.queuedAt, 8);
    fs.writeFileSync(path.join(ongoing, "meta.json"), JSON.stringify(meta));
    check();
    assert.equal(accountDays(dir, "me", TZ).totals.get("2026-11-02"), 8);
    // 已结束的运行经 writeRunMeta 改写时重新读取
    meta.status = "success";
    meta.minuteMarks = marks(meta.queuedAt, 12);
    writeRunMeta(ongoing, meta);
    check();
    assert.equal(accountDays(dir, "me", TZ).totals.get("2026-11-02"), 12);
    fs.rmSync(ongoing, { recursive: true });
    check();
    assert.equal(accountDays(dir, "me", TZ).totals.get("2026-11-02"), undefined);
  });

  it("时区变化时重建：跨零点的运行重新归属", () => {
    const dir = dataDir();
    writeRun(dir, "me", { queuedAt: "2026-11-14T15:50:00Z", minutes: 20 });
    assert.deepEqual(asObject(accountDays(dir, "me", TZ).totals), { "2026-11-14": 9, "2026-11-15": 11 });
    assert.deepEqual(asObject(accountDays(dir, "me", "UTC").totals), { "2026-11-14": 20 });
    assert.deepEqual(asObject(accountDays(dir, "me", TZ).totals), { "2026-11-14": 9, "2026-11-15": 11 });
  });
});
