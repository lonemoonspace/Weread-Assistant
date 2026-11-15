// 面板 smoke：运行历史、按天统计、统计页接口、挑战进度与保留策略

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const { cleanupRuns } = require(path.resolve(__dirname, "..", "..", "src", "panel", "history"));
const { challengeProgress, dateInZone } = require(path.resolve(__dirname, "..", "..", "src", "panel", "stats"));
const { minutesFrom, writeRun } = require("../fixtures/run-records");
const { tempDir, until, nextRun, ended } = require("./helpers");

module.exports = async function historyScenarios({ scenario, startAuthed }) {
  await scenario("运行历史：最新的在前、分页；详情含截图与按天分钟数；截图与日志可读取；账号带今日分钟数与最近一次运行", async () => {
    const panel = await startAuthed();
    await panel.call("POST", "api/accounts", { id: "ok-1" });
    const ids = [];
    for (let i = 0; i < 3; i += 1) {
      const finished = nextRun(panel, ended("ok-1"));
      await panel.call("POST", "api/accounts/ok-1/runs");
      ids.push((await finished).id);
    }
    const [first, second, third] = ids;

    const page1 = await panel.call("GET", "api/accounts/ok-1/runs?limit=2");
    assert.strictEqual(page1.status, 200);
    assert.deepStrictEqual(page1.json.runs.map((run) => run.id), [third, second]);
    assert.strictEqual(page1.json.nextBefore, second);
    const latest = page1.json.runs[0];
    assert.deepStrictEqual(
      [latest.status, latest.minutes, latest.trigger, latest.hasLog, latest.screenshots],
      ["success", 2, "manual", true, ["screenshot-1.png", "screenshot-2.png"]]
    );
    assert.ok(!("minuteMarks" in latest), "列表不返回逐分钟时间");
    const page2 = await panel.call("GET", `api/accounts/ok-1/runs?limit=2&before=${second}`);
    assert.deepStrictEqual([page2.json.runs.map((run) => run.id), page2.json.nextBefore], [[first], null]);
    // 更早的记录读不出来（meta.json 损坏）时，最后一页不再提供下一页
    const corruptId = writeRun(panel.options.dataDir, "ok-1", { queuedAt: "2020-01-01T00:00:00.000Z" });
    const corruptDir = path.join(panel.options.dataDir, "runs", "ok-1", corruptId);
    fs.writeFileSync(path.join(corruptDir, "meta.json"), "{");
    const whole = await panel.call("GET", "api/accounts/ok-1/runs?limit=3");
    assert.deepStrictEqual([whole.json.runs.map((run) => run.id), whole.json.nextBefore], [[third, second, first], null]);
    const lastPage = await panel.call("GET", `api/accounts/ok-1/runs?limit=2&before=${second}`);
    assert.deepStrictEqual([lastPage.json.runs.map((run) => run.id), lastPage.json.nextBefore], [[first], null]);
    assert.strictEqual((await panel.call("GET", "api/accounts/ok-1/runs?limit=2")).json.nextBefore, second);
    fs.rmSync(corruptDir, { recursive: true });
    for (const query of ["limit=0", "limit=101", "limit=x", "before=bad"]) {
      assert.strictEqual((await panel.call("GET", `api/accounts/ok-1/runs?${query}`)).status, 400, query);
    }
    assert.strictEqual((await panel.call("GET", "api/accounts/nobody/runs")).status, 404);

    const today = dateInZone(new Date(), "Asia/Shanghai");
    const detail = await panel.call("GET", `api/accounts/ok-1/runs/${third}`);
    assert.deepStrictEqual(detail.json.run.minutesByDate, { [today]: 2 });
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(panel.options.dataDir, "runs", "ok-1", third, "meta.json"), "utf8")).minuteMarks.length, 2);
    assert.strictEqual((await panel.call("GET", "api/accounts/ok-1/runs/20260101T000000Z-0000")).status, 404);

    const shot = await panel.call("GET", `api/accounts/ok-1/runs/${third}/screenshots/screenshot-2.png`);
    assert.strictEqual(shot.status, 200);
    assert.strictEqual(shot.headers.get("content-type"), "image/png");
    assert.strictEqual(shot.bytes.length, fs.statSync(path.join(panel.options.dataDir, "runs", "ok-1", third, "screenshot-2.png")).size);
    assert.deepStrictEqual([...shot.bytes.subarray(1, 4)], [0x50, 0x4e, 0x47], "PNG 文件头");
    for (const name of ["screenshot-9.png", "meta.json", "output.log", encodeURIComponent("../../panel.json"), "screenshot-1.jpg"]) {
      assert.strictEqual((await panel.call("GET", `api/accounts/ok-1/runs/${third}/screenshots/${name}`)).status, 404, name);
    }
    assert.ok(!fs.existsSync(path.join(panel.options.dataDir, "accounts", "ok-1", "screenshot-1.png")), "截图写入运行目录而不是账号目录");

    const account = (await panel.call("GET", "api/accounts")).json.accounts[0];
    assert.deepStrictEqual(account.today, { date: today, minutes: 6, checkedIn: true });
    assert.deepStrictEqual([account.lastRun.id, account.lastRun.status, account.lastRun.minutes], [third, "success", 2]);
    assert.strictEqual(account.challenge, null);

    // 阅读中途停止：已读的分钟数来自每分钟的进度，同样计入当天
    await panel.call("POST", "api/accounts", { id: "slow-1" });
    const progressed = nextRun(panel, (run) => run.accountId === "slow-1" && run.minutes >= 3);
    await panel.call("POST", "api/accounts/slow-1/runs");
    await progressed;
    const stopped = nextRun(panel, ended("slow-1"));
    panel.runner.stop("slow-1");
    const slow = await stopped;
    const slowMeta = JSON.parse(fs.readFileSync(path.join(panel.options.dataDir, "runs", "slow-1", slow.id, "meta.json"), "utf8"));
    assert.strictEqual(slowMeta.status, "stopped");
    assert.ok(slowMeta.minutes >= 3 && slowMeta.minuteMarks.length === slowMeta.minutes, "每分钟进度都有对应的时间");
    const slowAccount = (await panel.call("GET", "api/accounts/slow-1")).json.account;
    assert.deepStrictEqual([slowAccount.today.minutes, slowAccount.lastRun.status], [slowMeta.minutes, "stopped"]);
  });

  await scenario("按天统计：跨午夜的运行按面板时区拆到两天，改时区后重新归属；失败与停止的运行计入已读部分；旧记录按开始阅读时间估算", async () => {
    const panel = await startAuthed();
    await panel.call("POST", "api/accounts", { id: "me" });
    const dataDir = panel.options.dataDir;
    // 上海时间 3 月 31 日 23:51 至 4 月 1 日 00:10，共 20 分钟，运行失败
    const crossing = writeRun(dataDir, "me", {
      queuedAt: "2026-03-31T15:45:00.000Z",
      marks: minutesFrom("2026-03-31T15:50:00.000Z", 20),
      status: "failed",
    });
    // 第 7 步之前的记录：只有 minutes 与开始阅读时间
    writeRun(dataDir, "me", { queuedAt: "2026-04-02T00:58:00.000Z", minutes: 6, readingStartedAt: "2026-04-02T01:00:00.000Z" });
    // 已停止，只读了 3 分钟，不够打卡
    writeRun(dataDir, "me", { queuedAt: "2026-04-03T02:00:00.000Z", marks: minutesFrom("2026-04-03T02:00:00.000Z", 3), status: "stopped" });
    // 恰好 5 分钟：算作打卡
    writeRun(dataDir, "me", { queuedAt: "2026-04-04T02:00:00.000Z", marks: minutesFrom("2026-04-04T02:00:00.000Z", 5) });

    const month = async (value) => (await panel.call("GET", `api/accounts/me/calendar?month=${value}`)).json;
    const dayOf = (cal, date) => cal.days.find((day) => day.date === date);
    const march = await month("2026-03");
    assert.strictEqual(march.days.length, 31);
    assert.deepStrictEqual(dayOf(march, "2026-03-31"), { date: "2026-03-31", minutes: 9, checkedIn: true, future: false });
    const april = await month("2026-04");
    assert.strictEqual(april.days.length, 30);
    assert.deepStrictEqual(
      ["2026-04-01", "2026-04-02", "2026-04-03", "2026-04-04"].map((date) => [dayOf(april, date).minutes, dayOf(april, date).checkedIn]),
      [[11, true], [6, true], [3, false], [5, true]]
    );
    assert.deepStrictEqual([april.monthMinutes, april.monthCheckedDays, april.checkInMinutes], [25, 3, 5]);
    assert.strictEqual(april.note, "按本工具运行记录统计，非微信读书官方数据");
    assert.deepStrictEqual(
      (await panel.call("GET", `api/accounts/me/runs/${crossing}`)).json.run.minutesByDate,
      { "2026-03-31": 9, "2026-04-01": 11 }
    );

    await panel.call("PATCH", "api/settings", { settings: { timezone: "UTC" } });
    const utcMarch = await month("2026-03");
    const utcApril = await month("2026-04");
    assert.strictEqual(utcMarch.timezone, "UTC");
    assert.strictEqual(dayOf(utcMarch, "2026-03-31").minutes, 20, "UTC 下整段都在 3 月 31 日");
    assert.deepStrictEqual(
      ["2026-04-01", "2026-04-02", "2026-04-03"].map((date) => dayOf(utcApril, date).minutes),
      [0, 6, 3]
    );

    const current = await panel.call("GET", "api/accounts/me/calendar");
    assert.strictEqual(current.json.month, dateInZone(new Date(), "UTC").slice(0, 7), "默认本月");
    assert.strictEqual(current.json.today.date, dateInZone(new Date(), "UTC"));
    assert.ok(current.json.days.some((day) => day.future) || current.json.days[current.json.days.length - 1].date === current.json.today.date);
    for (const bad of ["2026-13", "2026-4", "abc"]) {
      assert.strictEqual((await panel.call("GET", `api/accounts/me/calendar?month=${bad}`)).status, 400, bad);
    }
    assert.strictEqual((await panel.call("GET", "api/accounts/nobody/calendar")).status, 404);
  });

  await scenario("挑战进度：第几天、已打卡天数、累计分钟、漏打卡天数与是否达成；挑战设置的校验", async () => {
    const dataDir = tempDir();
    const timezone = "Asia/Shanghai";
    // 4 月 1 日至 10 日每天上海时间 09:00 起阅读 30 分钟，5 日只读了 3 分钟
    for (let day = 1; day <= 10; day += 1) {
      const start = `2026-04-${String(day).padStart(2, "0")}T01:00:00.000Z`;
      writeRun(dataDir, "ch", { queuedAt: start, marks: minutesFrom(start, day === 5 ? 3 : 30) });
    }
    const account = { id: "ch", challenge: { type: "month", startDate: "2026-04-01" } };
    const at = (iso) => challengeProgress(dataDir, account, { timezone, now: new Date(iso) });

    assert.deepStrictEqual(at("2026-04-10T04:00:00.000Z"), {
      type: "month",
      label: "月卡",
      startDate: "2026-04-01",
      endDate: "2026-04-30",
      status: "active",
      dayNumber: 10,
      totalDays: 30,
      checkedDays: 9,
      requiredDays: 29,
      totalMinutes: 273,
      requiredMinutes: 1800,
      missedDays: 1,
      allowedMissedDays: 1,
      remainingDays: 21,
      missesLeft: 0,
      minutesPerDayNeeded: 73,
      achieved: false,
    });
    const before = at("2026-03-20T00:00:00.000Z");
    assert.deepStrictEqual([before.status, before.dayNumber, before.checkedDays, before.totalMinutes, before.missedDays], ["not-started", 0, 0, 0, 0]);
    const after = at("2026-05-15T00:00:00.000Z");
    assert.deepStrictEqual([after.status, after.dayNumber, after.checkedDays, after.missedDays], ["ended", 30, 9, 21]);
    // 上海时间 4 月 1 日 00:30 只算第 1 天，前一天（UTC 3 月 31 日）的数据不计入
    assert.strictEqual(at("2026-03-31T16:30:00.000Z").dayNumber, 1);

    // 29 天、每天 63 分钟：天数与时长都达标；每天 62 分钟时时长差 2 分钟
    for (const [id, minutes, achieved] of [["full", 63, true], ["short", 62, false]]) {
      for (let day = 1; day <= 29; day += 1) {
        const start = `2026-06-${String(day).padStart(2, "0")}T01:00:00.000Z`;
        writeRun(dataDir, id, { queuedAt: start, marks: minutesFrom(start, minutes) });
      }
      const result = challengeProgress(dataDir, { id, challenge: { type: "month", startDate: "2026-06-01" } }, { timezone, now: new Date("2026-07-05T00:00:00.000Z") });
      assert.deepStrictEqual([result.checkedDays, result.totalMinutes, result.missedDays, result.achieved], [29, 29 * minutes, 1, achieved], id);
    }
    const year = challengeProgress(dataDir, { id: "ch", challenge: { type: "year", startDate: "2026-04-01" } }, { timezone, now: new Date("2026-04-10T04:00:00.000Z") });
    assert.deepStrictEqual([year.label, year.totalDays, year.requiredDays, year.requiredMinutes, year.allowedMissedDays, year.endDate], ["年卡", 365, 360, 18000, 5, "2027-03-31"]);

    const panel = await startAuthed();
    await panel.call("POST", "api/accounts", { id: "me" });
    for (const challenge of [{ type: "week", startDate: "2026-04-01" }, { type: "constructor", startDate: "2026-04-01" }, { type: "__proto__", startDate: "2026-04-01" }, { type: "toString", startDate: "2026-04-01" }, { type: "month", startDate: "2026-02-30" }, { type: "month", startDate: "2026/04/01" }, { type: "month", startDate: "2026-04-01", x: 1 }, "month"]) {
      assert.strictEqual((await panel.call("PATCH", "api/accounts/me", { challenge })).status, 400, JSON.stringify(challenge));
    }
    const today = dateInZone(new Date(), "Asia/Shanghai");
    const saved = await panel.call("PATCH", "api/accounts/me", { challenge: { type: "month", startDate: today } });
    assert.deepStrictEqual(saved.json.account.challenge, { type: "month", startDate: today });
    const detail = (await panel.call("GET", "api/accounts/me")).json;
    assert.deepStrictEqual([detail.challengeProgress.status, detail.challengeProgress.dayNumber, detail.challengeProgress.missedDays], ["active", 1, 0]);
    assert.strictEqual((await panel.call("GET", "api/accounts/me/calendar")).json.challenge.startDate, today);
    await panel.call("PATCH", "api/accounts/me", { challenge: null });
    assert.strictEqual((await panel.call("GET", "api/accounts/me")).json.challengeProgress, null);
    // 旧版本保存下来的继承属性类型：没有进度，不让账号详情与打卡日历出错
    assert.strictEqual(challengeProgress(dataDir, { id: "ch", challenge: { type: "constructor", startDate: "2026-04-01" } }, { timezone }), null);
  });

  await scenario("统计接口：概览数字、趋势、热力图与运行情况，本月数字与日历一致；全部账号相加；账号带连续天数；运行历史可按日期查看；参数校验", async () => {
    const panel = await startAuthed();
    await panel.call("PATCH", "api/settings", { settings: { timezone: "UTC" } });
    await panel.call("POST", "api/accounts", { id: "me" });
    await panel.call("POST", "api/accounts", { id: "you" });
    const dataDir = panel.options.dataDir;
    const today = dateInZone(new Date(), "UTC");
    const shift = (days) => new Date(Date.parse(`${today}T00:00:00.000Z`) + days * 86400000).toISOString();
    const dayOf = (days) => shift(days).slice(0, 10);
    writeRun(dataDir, "me", { queuedAt: shift(0), marks: minutesFrom(shift(0), 10) });
    writeRun(dataDir, "me", { queuedAt: shift(-1), marks: minutesFrom(shift(-1), 6), trigger: "catchup" });
    writeRun(dataDir, "me", { queuedAt: shift(-2), marks: minutesFrom(shift(-2), 3), status: "failed", loginPrompted: true });
    writeRun(dataDir, "you", { queuedAt: shift(-1), marks: minutesFrom(shift(-1), 7) });

    const res = await panel.call("GET", "api/stats?account=me&days=30");
    assert.strictEqual(res.status, 200);
    const stats = res.json;
    assert.deepStrictEqual([stats.account, stats.today, stats.timezone, stats.rangeDays], ["me", today, "UTC", 30]);
    assert.deepStrictEqual(stats.accounts.map((item) => item.id), ["me", "you"]);
    assert.strictEqual(stats.summary.currentStreak, 2);
    assert.strictEqual(stats.trend.length, 30);
    assert.deepStrictEqual(stats.trend.slice(-3).map((day) => [day.date, day.minutes, day.checkedIn]), [
      [dayOf(-2), 3, false],
      [dayOf(-1), 6, true],
      [today, 10, true],
    ]);
    assert.strictEqual(stats.heatmap.length, 365);
    assert.deepStrictEqual([stats.heatmap.at(-1).level, stats.heatmap.at(-2).level], [1, 1]);
    assert.deepStrictEqual([stats.runs.total, stats.runs.catchups, stats.runs.loginPrompted, stats.runs.byStatus.failed], [3, 1, 1, 1]);
    assert.strictEqual(stats.note, "按本工具运行记录统计，非微信读书官方数据");
    const calendar = (await panel.call("GET", "api/accounts/me/calendar")).json;
    assert.deepStrictEqual(
      [stats.summary.month.minutes, stats.summary.month.checkedDays],
      [calendar.monthMinutes, calendar.monthCheckedDays],
      "本月累计与打卡天数与日历一致"
    );

    const all = (await panel.call("GET", "api/stats?days=90")).json;
    assert.deepStrictEqual([all.account, all.trend.length, all.challenge], ["all", 90, null]);
    assert.strictEqual(all.trend.at(-2).minutes, 13, "全部账号时分钟数相加");
    const accounts = (await panel.call("GET", "api/accounts")).json.accounts;
    assert.deepStrictEqual(accounts.map((account) => account.streak), [2, 1], "you 今天还没读、昨天打卡，不算中断");

    const onDay = (await panel.call("GET", `api/accounts/me/runs?date=${dayOf(-1)}`)).json.runs;
    assert.deepStrictEqual(onDay.map((run) => run.queuedAt), [shift(-1), shift(-2)], "按日期查看时从当天往前");

    for (const query of ["days=7", "days=abc", "account=me&days=0"]) {
      assert.strictEqual((await panel.call("GET", `api/stats?${query}`)).status, 400, query);
    }
    assert.strictEqual((await panel.call("GET", "api/stats?account=nobody")).status, 404);
    assert.strictEqual((await panel.call("GET", "api/accounts/me/runs?date=2026-02-30")).status, 400);

    // 面板自己完成的运行：结束后统计立即包含（缓存随运行记录的写入更新）
    await panel.call("POST", "api/accounts", { id: "ok-1" });
    const before = (await panel.call("GET", "api/stats?account=ok-1")).json.trend.at(-1).minutes;
    const finished = nextRun(panel, ended("ok-1"));
    await panel.call("POST", "api/accounts/ok-1/runs");
    const run = await finished;
    const after = (await panel.call("GET", "api/stats?account=ok-1")).json;
    assert.ok(run.minutes > 0);
    assert.strictEqual(after.summary.last30.minutes - before, run.minutes);
  });

  await scenario("保留策略：截图只保留最近 N 次有截图的运行，日志超过天数后删除，运行记录永久保留；进行中的运行不清理；运行结束后自动清理", async () => {
    const panel = await startAuthed();
    const dataDir = panel.options.dataDir;
    await panel.call("POST", "api/accounts", { id: "keep" });
    const daysAgo = (days) => new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const shots = { "screenshot-1.png": "a", "screenshot-2.png": "b", "output.log": "log\n" };
    // 从旧到新：5 次有截图的运行（最早两次在 3 天前结束），最新一次是仅登录、没有截图
    const runIds = [5, 4, 3, 2, 1].map((age, index) =>
      writeRun(dataDir, "keep", { queuedAt: daysAgo(index < 2 ? 3 : 0.5 - index * 0.01), endedAt: daysAgo(index < 2 ? 3 : 0.4), files: shots })
    );
    const loginOnly = writeRun(dataDir, "keep", { queuedAt: daysAgo(0.1), mode: "login", files: { "output.log": "log\n" } });
    const dirOf = (id) => path.join(dataDir, "runs", "keep", id);

    await panel.call("PATCH", "api/settings", { settings: { screenshotRetentionRuns: 2, logRetentionDays: 1 } });
    await until(() => !fs.existsSync(path.join(dirOf(runIds[0]), "screenshot-1.png")), { message: "修改保留设置后应清理" });
    const list = (await panel.call("GET", "api/accounts/keep/runs?limit=10")).json.runs;
    const byId = Object.fromEntries(list.map((run) => [run.id, run]));
    assert.strictEqual(list.length, 6, "运行记录全部保留");
    assert.deepStrictEqual(runIds.map((id) => byId[id].screenshots.length), [0, 0, 0, 2, 2], "只保留最近 2 次有截图的运行");
    assert.deepStrictEqual(runIds.map((id) => byId[id].hasLog), [false, false, true, true, true], "超过 1 天的日志被删除");
    assert.strictEqual(byId[loginOnly].hasLog, true);
    assert.strictEqual((await panel.call("GET", `api/accounts/keep/runs/${runIds[0]}/log`)).status, 404);

    // 进行中的运行即使超出保留数也不清理
    const removed = cleanupRuns(dataDir, { screenshotRetentionRuns: 0, logRetentionDays: 1 }, { activeRunIds: new Set([runIds[4]]) });
    assert.deepStrictEqual(removed, { screenshots: 2, logs: 0 });
    assert.ok(fs.existsSync(path.join(dirOf(runIds[4]), "screenshot-2.png")));
    assert.ok(!fs.existsSync(path.join(dirOf(runIds[3]), "screenshot-2.png")));

    // 运行结束后自动清理：只保留最近 1 次
    await panel.call("PATCH", "api/settings", { settings: { screenshotRetentionRuns: 1 } });
    await panel.call("POST", "api/accounts", { id: "ok-1" });
    const done = [];
    for (let i = 0; i < 2; i += 1) {
      const finished = nextRun(panel, ended("ok-1"));
      await panel.call("POST", "api/accounts/ok-1/runs");
      done.push((await finished).id);
    }
    await until(() => !fs.existsSync(path.join(dataDir, "runs", "ok-1", done[0], "screenshot-1.png")), { message: "运行结束后应清理上一次的截图" });
    assert.ok(fs.existsSync(path.join(dataDir, "runs", "ok-1", done[1], "screenshot-2.png")));
    assert.ok(fs.existsSync(path.join(dataDir, "runs", "ok-1", done[0], "meta.json")));
  });
};
