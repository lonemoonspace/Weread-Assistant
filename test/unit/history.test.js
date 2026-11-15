const { after, describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { calendar, challengeProgress, cleanupRuns, dailyMinutes, dateInZone, getRun, listRuns } = require("../../src/panel/history");
const { newRunId } = require("../../src/panel/runs");

const tempDirs = [];
after(() => tempDirs.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

function dataDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wa-history-"));
  tempDirs.push(dir);
  return dir;
}

// 写一条运行记录：minutes 为每分钟完成时间（ISO 字符串），queuedAt 决定运行 ID
function writeRun(dir, accountId, { queuedAt, minuteMarks, status = "success", extra = {}, files = [] }) {
  const id = newRunId(new Date(queuedAt));
  const runDir = path.join(dir, "runs", accountId, id);
  fs.mkdirSync(runDir, { recursive: true });
  const meta = { id, accountId, status, queuedAt, minutes: minuteMarks ? minuteMarks.length : 0, minuteMarks, ...extra };
  fs.writeFileSync(path.join(runDir, "meta.json"), JSON.stringify(meta));
  for (const name of files) {
    fs.writeFileSync(path.join(runDir, name), "x");
  }
  return id;
}

// 从 start 起每分钟一条
function marks(start, count) {
  const t = Date.parse(start);
  return Array.from({ length: count }, (_, i) => new Date(t + (i + 1) * 60000).toISOString());
}

describe("dateInZone", () => {
  it("按时区取日期", () => {
    const date = new Date("2026-11-14T17:30:00Z");
    assert.equal(dateInZone(date, "UTC"), "2026-11-14");
    assert.equal(dateInZone(date, "Asia/Shanghai"), "2026-11-15");
    assert.equal(dateInZone(date, "America/Los_Angeles"), "2026-11-14");
  });
});

describe("dailyMinutes", () => {
  it("跨午夜的运行按每分钟完成时间拆到各自的日期", () => {
    const dir = dataDir();
    // 上海时间 23:50 开始读 20 分钟：10 分钟在 14 日，10 分钟在 15 日
    writeRun(dir, "me", { queuedAt: "2026-11-14T15:50:00Z", minuteMarks: marks("2026-11-14T15:50:00Z", 20) });
    const totals = dailyMinutes(dir, "me", { timezone: "Asia/Shanghai", from: "2026-11-14", to: "2026-11-15" });
    assert.deepEqual(totals, { "2026-11-14": 9, "2026-11-15": 11 });
    // 同一组记录在 UTC 下都在 14 日
    assert.deepEqual(dailyMinutes(dir, "me", { timezone: "UTC", from: "2026-11-14", to: "2026-11-14" }), { "2026-11-14": 20 });
  });

  it("失败与停止的运行已读的部分也计入，范围外的不计", () => {
    const dir = dataDir();
    writeRun(dir, "me", { queuedAt: "2026-11-10T01:00:00Z", minuteMarks: marks("2026-11-10T01:00:00Z", 5), status: "failed" });
    writeRun(dir, "me", { queuedAt: "2026-11-10T02:00:00Z", minuteMarks: marks("2026-11-10T02:00:00Z", 3), status: "stopped" });
    writeRun(dir, "me", { queuedAt: "2026-10-01T02:00:00Z", minuteMarks: marks("2026-10-01T02:00:00Z", 30) });
    assert.deepEqual(dailyMinutes(dir, "me", { timezone: "UTC", from: "2026-11-01", to: "2026-11-30" }), { "2026-11-10": 8 });
  });

  it("没有逐分钟记录的旧记录按开始阅读后每分钟一条估算", () => {
    const dir = dataDir();
    writeRun(dir, "me", {
      queuedAt: "2026-11-10T01:00:00Z",
      minuteMarks: undefined,
      extra: { minutes: 4, readingStartedAt: "2026-11-10T01:01:00Z" },
    });
    assert.deepEqual(dailyMinutes(dir, "me", { timezone: "UTC", from: "2026-11-10", to: "2026-11-10" }), { "2026-11-10": 4 });
  });

  it("损坏的记录跳过，没有记录的账号为空", () => {
    const dir = dataDir();
    const id = writeRun(dir, "me", { queuedAt: "2026-11-10T01:00:00Z", minuteMarks: marks("2026-11-10T01:00:00Z", 5) });
    fs.writeFileSync(path.join(dir, "runs", "me", id, "meta.json"), "{broken");
    const warn = console.warn;
    console.warn = () => {};
    try {
      assert.deepEqual(dailyMinutes(dir, "me", { timezone: "UTC", from: "2026-11-10", to: "2026-11-10" }), {});
    } finally {
      console.warn = warn;
    }
    assert.deepEqual(dailyMinutes(dir, "nobody", { timezone: "UTC", from: "2026-11-10", to: "2026-11-10" }), {});
  });
});

describe("challengeProgress", () => {
  it("月卡：打卡天数、累计分钟与漏打卡天数（不含今天）", () => {
    const dir = dataDir();
    // 11 月 1 日开始；1、2、4 日各读 60 分钟，3 日只读 3 分钟（不足 5 分钟不算打卡）
    for (const [day, minutes] of [["01", 60], ["02", 60], ["03", 3], ["04", 60]]) {
      const start = `2026-11-${day}T10:00:00Z`;
      writeRun(dir, "me", { queuedAt: start, minuteMarks: marks(start, minutes) });
    }
    const account = { id: "me", challenge: { type: "month", startDate: "2026-11-01" } };
    const progress = challengeProgress(dir, account, { timezone: "UTC", now: new Date("2026-11-05T12:00:00Z") });
    assert.equal(progress.status, "active");
    assert.equal(progress.dayNumber, 5);
    assert.equal(progress.checkedDays, 3);
    assert.equal(progress.totalMinutes, 183);
    assert.equal(progress.missedDays, 1);
    assert.equal(progress.allowedMissedDays, 1);
    assert.equal(progress.achieved, false);
  });

  it("没有挑战或设置无效时为 null，开始之前为 not-started", () => {
    const dir = dataDir();
    const now = new Date("2026-11-05T12:00:00Z");
    assert.equal(challengeProgress(dir, { id: "me", challenge: null }, { timezone: "UTC", now }), null);
    assert.equal(challengeProgress(dir, { id: "me", challenge: { type: "week", startDate: "2026-11-01" } }, { timezone: "UTC", now }), null);
    const future = challengeProgress(dir, { id: "me", challenge: { type: "month", startDate: "2026-11-10" } }, { timezone: "UTC", now });
    assert.equal(future.status, "not-started");
    assert.equal(future.dayNumber, 0);
    assert.equal(future.missedDays, 0);
  });
});

describe("calendar", () => {
  it("返回整月每天的分钟数与打卡情况", () => {
    const dir = dataDir();
    writeRun(dir, "me", { queuedAt: "2026-11-02T10:00:00Z", minuteMarks: marks("2026-11-02T10:00:00Z", 12) });
    const result = calendar(dir, { id: "me", challenge: null }, { timezone: "UTC", month: "2026-11", now: new Date("2026-11-14T12:00:00Z") });
    assert.equal(result.days.length, 30);
    assert.deepEqual(result.days[1], { date: "2026-11-02", minutes: 12, checkedIn: true, future: false });
    assert.equal(result.days[20].future, true);
    assert.equal(result.monthMinutes, 12);
    assert.equal(result.monthCheckedDays, 1);
    assert.throws(() => calendar(dir, { id: "me" }, { timezone: "UTC", month: "2026-13" }), /YYYY-MM/);
  });
});

describe("listRuns 与 getRun", () => {
  it("最新的在前，分页时 nextBefore 指向本页最后一条", () => {
    const dir = dataDir();
    const ids = ["2026-11-01", "2026-11-02", "2026-11-03"].map((day) =>
      writeRun(dir, "me", { queuedAt: `${day}T10:00:00Z`, minuteMarks: marks(`${day}T10:00:00Z`, 1) })
    );
    const first = listRuns(dir, "me", { limit: 2 });
    assert.deepEqual(first.runs.map((run) => run.id), [ids[2], ids[1]]);
    assert.equal(first.nextBefore, ids[1]);
    const second = listRuns(dir, "me", { limit: 2, before: first.nextBefore });
    assert.deepEqual(second.runs.map((run) => run.id), [ids[0]]);
    assert.equal(second.nextBefore, null);
    assert.throws(() => listRuns(dir, "me", { limit: 0 }), /limit/);
    assert.throws(() => listRuns(dir, "me", { before: "../x" }), /before/);
  });

  it("运行详情不返回分钟记录，按天拆分分钟数", () => {
    const dir = dataDir();
    const id = writeRun(dir, "me", {
      queuedAt: "2026-11-14T15:55:00Z",
      minuteMarks: marks("2026-11-14T15:55:00Z", 10),
      files: ["output.log", "screenshot-1.png", "screenshot-10.png", "screenshot-2.png", "other.png"],
    });
    const run = getRun(dir, "me", id, "Asia/Shanghai");
    assert.equal(run.minuteMarks, undefined);
    assert.deepEqual(run.minutesByDate, { "2026-11-14": 4, "2026-11-15": 6 });
    assert.deepEqual(run.screenshots, ["screenshot-1.png", "screenshot-2.png", "screenshot-10.png"]);
    assert.equal(run.hasLog, true);
    assert.throws(() => getRun(dir, "me", "20261114T000000Z-0000", "UTC"), /运行记录不存在/);
  });
});

describe("cleanupRuns", () => {
  it("截图只留最近几次运行，日志按天数清理，进行中的运行不动", () => {
    const dir = dataDir();
    const now = Date.parse("2026-11-14T12:00:00Z");
    const old = writeRun(dir, "me", {
      queuedAt: "2026-09-01T10:00:00Z",
      minuteMarks: [],
      extra: { endedAt: "2026-09-01T10:30:00Z" },
      files: ["output.log", "screenshot-1.png"],
    });
    const middle = writeRun(dir, "me", { queuedAt: "2026-11-12T10:00:00Z", minuteMarks: [], files: ["output.log", "screenshot-1.png"] });
    const latest = writeRun(dir, "me", { queuedAt: "2026-11-13T10:00:00Z", minuteMarks: [], files: ["screenshot-1.png"] });
    const info = console.info;
    console.info = () => {};
    let removed;
    try {
      removed = cleanupRuns(dir, { logRetentionDays: 30, screenshotRetentionRuns: 1 }, { now, activeRunIds: new Set([middle]) });
    } finally {
      console.info = info;
    }
    const exists = (id, name) => fs.existsSync(path.join(dir, "runs", "me", id, name));
    assert.deepEqual(removed, { screenshots: 1, logs: 1 });
    assert.equal(exists(old, "output.log"), false);
    assert.equal(exists(old, "screenshot-1.png"), false);
    assert.equal(exists(old, "meta.json"), true);
    assert.equal(exists(middle, "screenshot-1.png"), true, "进行中的运行保留截图");
    assert.equal(exists(latest, "screenshot-1.png"), true);
  });

  it("删除账号目录中旧的邮件附件截图与一天前的临时文件，其他文件保留", () => {
    const dir = dataDir();
    const accountDir = path.join(dir, "accounts", "me");
    fs.mkdirSync(path.join(accountDir, "profile"), { recursive: true });
    const now = Date.now();
    for (const name of ["email-done.png", "cookies.json", "cookies.json.1.tmp", "fresh.tmp", "login.png"]) {
      fs.writeFileSync(path.join(accountDir, name), "x");
    }
    const old = new Date(now - 2 * 86400000);
    fs.utimesSync(path.join(accountDir, "cookies.json.1.tmp"), old, old);
    const info = console.info;
    console.info = () => {};
    try {
      cleanupRuns(dir, { logRetentionDays: 30, screenshotRetentionRuns: 1 }, { now });
    } finally {
      console.info = info;
    }
    assert.deepEqual(fs.readdirSync(accountDir).sort(), ["cookies.json", "fresh.tmp", "login.png", "profile"]);
  });
});
