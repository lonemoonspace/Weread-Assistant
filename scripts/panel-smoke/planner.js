// 面板 smoke：计划器（失败重试、代发失败通知、启动恢复、错过的调度、随机延后、每日目标补跑）

const assert = require("assert");
const fs = require("fs");
const http = require("http");
const path = require("path");

const { zonedTime } = require(path.resolve(__dirname, "..", "..", "src", "panel", "planner"));
const { dateInZone } = require(path.resolve(__dirname, "..", "..", "src", "panel", "history"));
const { writeRun } = require("../fixtures/run-records");
const { tempDir, until } = require("./helpers");

const TIMEZONE = "Asia/Shanghai";
const RULE = { id: "r1", type: "daily", times: ["06:00"], enabled: true };

// 计划器的测试参数：不等待启动、每 50 毫秒检查一次、重试间隔缩短；clock.offset 可以把时钟往后拨
function plannerOptions(extra = {}) {
  const clock = {
    offset: 0,
    now: () => Date.now() + clock.offset,
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (timer) => clearTimeout(timer),
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (timer) => clearInterval(timer),
  };
  return { clock, startupDelayMs: 0, tickMs: 50, retryDelaysMs: [100, 200, 300], ...extra };
}

// 账号的全部运行记录，按时间升序
function accountRuns(panel, accountId) {
  const dir = path.join(panel.options.dataDir, "runs", accountId);
  if (!fs.existsSync(dir)) {
    return [];
  }
  return fs
    .readdirSync(dir)
    .sort()
    .map((id) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(dir, id, "meta.json"), "utf8"));
      } catch (_) {
        return null;
      }
    })
    .filter(Boolean);
}

const finished = (run) => Boolean(run.endedAt);
const runLog = (panel, run) => fs.readFileSync(path.join(panel.options.dataDir, "runs", run.accountId, run.id, "output.log"), "utf8");

// 等到账号有 count 条已结束的运行，且没有进行中的运行与待办
async function settle(panel, accountId, count, message) {
  await until(
    () =>
      accountRuns(panel, accountId).filter(finished).length >= count &&
      !panel.runner.isActive(accountId) &&
      panel.planner.accountStatus(accountId).pending.length === 0,
    { timeoutMs: 10000, message }
  );
  return accountRuns(panel, accountId);
}

// 记录收到的 Bark 推送
async function startBarkServer() {
  const pushes = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try {
        pushes.push(JSON.parse(body));
      } catch (_) {
        pushes.push({ raw: body });
      }
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ code: 200 }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { pushes, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((resolve) => server.close(resolve)) };
}

module.exports = async function plannerScenarios({ scenario, start, startAuthed }) {
  await scenario("失败重试：自动触发的运行出错后按间隔重试、只读剩余分钟；手动运行、扫码超时与配置无效不重试；重试次数用完为止", async () => {
    const panel = await startAuthed({ planner: plannerOptions() });
    await panel.call("PATCH", "api/settings", { settings: { maxConcurrentRuns: 3 } });
    for (const id of ["flaky-a", "fail-b", "timeout-c", "fail-d"]) {
      await panel.call("POST", "api/accounts", { id });
    }
    await panel.call("PATCH", "api/accounts/flaky-a", { overrides: { duration: 5 } });

    panel.planner.fireSchedule("flaky-a", RULE);
    const [first, second] = await settle(panel, "flaky-a", 2, "flaky-a 应失败一次后重试成功");
    assert.deepStrictEqual([first.trigger, first.status, first.errorKind, first.attempt, first.minutes], ["schedule", "failed", "error", 1, 1]);
    assert.deepStrictEqual(
      [second.trigger, second.status, second.attempt, second.originRunId, second.plannedMinutes, second.minutes],
      ["retry", "success", 2, first.id, 4, 4]
    );
    assert.match(runLog(panel, first), /retry=\{"attempt":1,"retriesLeft":2\} duration=5/);
    assert.match(runLog(panel, second), /加入队列：重试触发（第 2 次尝试，读 4 分钟）/);
    assert.match(runLog(panel, second), /retry=\{"attempt":2,"retriesLeft":1\} duration=4/);

    // 手动运行：失败后不重试，下发的剩余重试次数为 0
    await panel.call("POST", "api/accounts/fail-b/runs");
    const [manual] = await settle(panel, "fail-b", 1);
    assert.match(runLog(panel, manual), /retry=\{"attempt":1,"retriesLeft":0\}/);
    // 扫码超时：不重试
    panel.planner.fireSchedule("timeout-c", RULE);
    const [timedOut] = await settle(panel, "timeout-c", 1);
    assert.strictEqual(timedOut.errorKind, "login-timeout");
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.strictEqual(accountRuns(panel, "timeout-c").length, 1, "扫码超时不应重试");
    assert.strictEqual(accountRuns(panel, "fail-b").length, 1, "手动运行不应重试");

    // 重试次数为 1：失败、重试一次仍失败后停止
    await panel.call("PATCH", "api/settings", { settings: { retryCount: 1 } });
    panel.planner.fireSchedule("fail-d", RULE);
    await settle(panel, "fail-d", 2);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const failures = accountRuns(panel, "fail-d");
    assert.deepStrictEqual(failures.map((run) => [run.trigger, run.attempt, run.status]), [["schedule", 1, "failed"], ["retry", 2, "failed"]]);
    assert.match(runLog(panel, failures[1]), /retry=\{"attempt":2,"retriesLeft":0\}/);
  });

  await scenario("子进程崩溃或超时被结束时由面板代发失败通知；还会重试时不发，最后一次写明重试过几次", async () => {
    const bark = await startBarkServer();
    try {
      const panel = await startAuthed({ planner: plannerOptions() });
      await panel.call("PATCH", "api/settings", {
        settings: { retryCount: 0 },
        defaults: { barkKey: "bark-key", barkServer: bark.url, notifyOnFailure: true, notifyOnStart: false },
      });
      await panel.call("POST", "api/accounts", { id: "crash-e" });
      panel.planner.fireSchedule("crash-e", RULE);
      await settle(panel, "crash-e", 1);
      await until(() => bark.pushes.length === 1, { message: "崩溃后应由面板代发一条失败通知" });
      assert.match(bark.pushes[0].body, /运行失败：阅读子进程异常退出（退出码 3）$/);

      await panel.call("PATCH", "api/settings", { settings: { retryCount: 1 } });
      panel.planner.fireSchedule("crash-e", RULE);
      await settle(panel, "crash-e", 3);
      await until(() => bark.pushes.length === 2, { message: "重试后仍失败时应发一条失败通知" });
      assert.match(bark.pushes[1].body, /（已重试 1 次）$/);
      await new Promise((resolve) => setTimeout(resolve, 200));
      assert.strictEqual(bark.pushes.length, 2, "还会重试的那次失败不应发通知");
    } finally {
      await bark.close();
    }
  });

  await scenario("启动恢复：面板停止或崩溃时被中断的自动运行在宽限时间内补读剩余分钟，只恢复一次；手动运行与超过宽限的不恢复", async (logs) => {
    const dataDir = tempDir();
    const first = await startAuthed({ dataDir, planner: plannerOptions() });
    await first.call("POST", "api/accounts", { id: "slow-f" });
    await first.call("POST", "api/accounts", { id: "slow-m" });
    await first.call("POST", "api/accounts", { id: "slow-g" });
    await first.call("POST", "api/accounts", { id: "slow-h" });
    first.planner.fireSchedule("slow-f", RULE);
    await first.call("POST", "api/accounts/slow-m/runs");
    await until(() => accountRuns(first, "slow-f").some((run) => run.minutes >= 2));
    await first.close();
    const [interrupted] = accountRuns(first, "slow-f");
    assert.strictEqual(interrupted.status, "interrupted");
    const remaining = interrupted.plannedMinutes - interrupted.minutes;
    const state = JSON.parse(fs.readFileSync(path.join(dataDir, "planner.json"), "utf8"));
    assert.deepStrictEqual(
      state.pending.filter((item) => item.kind === "resume").map((item) => [item.accountId, item.minutes]),
      [["slow-f", remaining]],
      "手动运行不应记为待恢复"
    );
    assert.strictEqual(fs.statSync(path.join(dataDir, "planner.json")).mode & 0o777, 0o600);

    // 崩溃留下的进行中记录（启动时标为中断）：宽限时间内的恢复，超过的不恢复
    const now = Date.now();
    writeRun(dataDir, "slow-g", {
      queuedAt: new Date(now - 20 * 60000).toISOString(),
      trigger: "schedule",
      status: "reading",
      plannedMinutes: 10,
      minutes: 3,
      endedAt: null,
    });
    const oldId = writeRun(dataDir, "slow-h", {
      queuedAt: new Date(now - 300 * 60000).toISOString(),
      trigger: "schedule",
      status: "reading",
      plannedMinutes: 10,
      minutes: 3,
      endedAt: null,
    });
    const oldDir = path.join(dataDir, "runs", "slow-h", oldId);
    const past = new Date(now - 300 * 60000);
    fs.utimesSync(path.join(oldDir, "meta.json"), past, past);
    const second = await start({ dataDir, password: "correct-horse", planner: plannerOptions() });
    await until(() => accountRuns(second, "slow-f").length === 2, { message: "slow-f 应恢复一次" });
    await until(() => accountRuns(second, "slow-g").length === 2, { message: "slow-g 应恢复一次" });
    const resumedG = accountRuns(second, "slow-g")[1];
    assert.match(runLog(second, resumedG), /加入队列：恢复触发（读 7 分钟）/);
    const resumed = accountRuns(second, "slow-f")[1];
    assert.deepStrictEqual([resumed.trigger, resumed.originRunId, resumed.attempt], ["resume", interrupted.id, 1]);
    assert.ok(logs.some((line) => line.includes(`恢复被中断的运行 ${interrupted.id}（补读剩余 ${remaining} 分钟）`)));
    assert.ok(logs.some((line) => line.includes(`被中断的运行 ${oldId}（账号 slow-h）已超过补触发宽限时间，不恢复`)));
    assert.strictEqual(accountRuns(second, "slow-m").length, 1, "手动运行不应恢复");
    await second.close();

    // 再次启动不会重复恢复
    const third = await start({ dataDir, password: "correct-horse", planner: plannerOptions() });
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.strictEqual(accountRuns(third, "slow-f").length, 2, "每次被中断的运行只恢复一次");
  });

  await scenario("停机期间错过的调度：宽限时间内的每条规则补触发一次，超过的只记录日志；没有检查记录时不补触发", async (logs) => {
    const dataDir = tempDir();
    const now = Date.now();
    const hhmm = (ts) =>
      new Intl.DateTimeFormat("en-GB", { timeZone: TIMEZONE, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(ts));
    const account = (id, time) => ({
      id,
      name: id,
      enabled: true,
      createdAt: new Date(now - 86400000).toISOString(),
      overrides: {},
      schedules: [{ id: "m1", type: "daily", times: [time], enabled: true }],
    });
    fs.writeFileSync(
      path.join(dataDir, "panel.json"),
      JSON.stringify({ version: 1, auth: { passwordHash: "" }, accounts: [account("slow-i", hhmm(now - 10 * 60000)), account("slow-j", hhmm(now - 180 * 60000))] }),
      { mode: 0o600 }
    );
    fs.writeFileSync(
      path.join(dataDir, "planner.json"),
      JSON.stringify({ version: 1, lastCheckAt: new Date(now - 240 * 60000).toISOString(), pending: [], catchups: {} }),
      { mode: 0o600 }
    );
    const panel = await start({ dataDir, password: "correct-horse", planner: plannerOptions() });
    await until(() => accountRuns(panel, "slow-i").length === 1, { message: "slow-i 应补触发一次" });
    const [missed] = accountRuns(panel, "slow-i");
    assert.deepStrictEqual([missed.trigger, missed.scheduleId], ["schedule", "m1"]);
    assert.ok(missed.delayedMinutes >= 9 && missed.delayedMinutes <= 11, `延迟分钟数 ${missed.delayedMinutes}`);
    assert.ok(logs.some((line) => /停机期间错过了调度 账号 slow-j，规则 m1.*已超过补触发宽限时间，不补触发/.test(line)));
    assert.strictEqual(accountRuns(panel, "slow-j").length, 0);
    panel.runner.stop("slow-i");
    await until(() => !panel.runner.isActive("slow-i"));
  });

  await scenario("随机延后：规则带 jitterMinutes 时到点后延后加入队列，待办写入 planner.json；阅读时长随机增加只增不减", async () => {
    const options = plannerOptions({ random: () => 0.99 });
    const panel = await startAuthed({ planner: options });
    await panel.call("POST", "api/accounts", { id: "goal-k" });
    await panel.call("PATCH", "api/accounts/goal-k", { overrides: { duration: 2, durationJitter: 3 } });
    panel.planner.fireSchedule("goal-k", { ...RULE, jitterMinutes: 2 });
    const [pending] = panel.planner.accountStatus("goal-k").pending;
    assert.strictEqual(pending.kind, "schedule");
    const state = JSON.parse(fs.readFileSync(path.join(panel.options.dataDir, "planner.json"), "utf8"));
    assert.strictEqual(state.pending[0].delayedMinutes, 2);
    const overview = (await panel.call("GET", "api/accounts")).json.accounts[0];
    assert.strictEqual(overview.planned.pending[0].kind, "schedule");
    assert.strictEqual(accountRuns(panel, "goal-k").length, 0, "延后期间不应加入队列");

    options.clock.offset = 2 * 60000 + 1000;
    const [run] = await settle(panel, "goal-k", 1);
    assert.deepStrictEqual([run.trigger, run.scheduleId, run.delayedMinutes], ["schedule", "r1", 2]);
    assert.ok(run.plannedMinutes >= 2 && run.plannedMinutes <= 5, `计划时长 ${run.plannedMinutes}`);
  });

  await scenario("每日目标：到检查时间后补跑差额；补跑不跨过 23:57，每天最多 3 次；扫码超时后当天不再补跑；接口校验", async () => {
    const options = plannerOptions();
    const panel = await startAuthed({ planner: options });
    const today = dateInZone(new Date(), TIMEZONE);
    const setClock = (time) => {
      options.clock.offset = zonedTime(today, time, TIMEZONE) - Date.now();
    };
    setClock("12:00");
    await panel.call("PATCH", "api/settings", { settings: { maxConcurrentRuns: 3 } });
    for (const id of ["goal-l", "goal-m", "timeout-n"]) {
      await panel.call("POST", "api/accounts", { id });
    }

    // 接口：校验、按挑战给出建议值、检查时间太晚时提示
    assert.strictEqual((await panel.call("PUT", "api/accounts/goal-l/goal", { goal: { minutes: 0, checkAt: "06:00" } })).status, 400);
    assert.strictEqual((await panel.call("PUT", "api/accounts/goal-l/goal", { goal: { minutes: 5, checkAt: "25:00" } })).status, 400);
    assert.strictEqual((await panel.call("PUT", "api/accounts/goal-l/goal", {})).status, 400);
    await panel.call("PATCH", "api/accounts/goal-l", { challenge: { type: "month", startDate: today } });
    const empty = (await panel.call("GET", "api/accounts/goal-l/goal")).json;
    assert.deepStrictEqual([empty.goal, empty.suggestedMinutes], [null, 60]);
    const late = (await panel.call("PUT", "api/accounts/goal-m/goal", { goal: { minutes: 20, checkAt: "23:50" } })).json;
    assert.match(late.warning, /最多还能补读 7 分钟/);

    // 当天已读 0 分钟、目标 5 分钟：补跑 5 分钟，读够后不再补跑
    const saved = await panel.call("PUT", "api/accounts/goal-l/goal", { goal: { minutes: 5, checkAt: "06:00" } });
    assert.deepStrictEqual(saved.json.goal, { enabled: true, minutes: 5, checkAt: "06:00" });
    const [catchup] = await settle(panel, "goal-l", 1);
    assert.deepStrictEqual([catchup.trigger, catchup.plannedMinutes, catchup.minutes], ["catchup", 5, 5]);
    assert.match(runLog(panel, catchup), /goalDeficit=5/);
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.strictEqual(accountRuns(panel, "goal-l").length, 1, "读够目标后不应再补跑");
    const goalView = (await panel.call("GET", "api/accounts/goal-l/goal")).json;
    assert.deepStrictEqual([goalView.today.minutes, goalView.planned.catchups.count], [5, 1]);

    // 23:54 多一点时检查、目标 20 分钟：每次只补到 23:57（不足 3 分钟，按 2 分钟），当天最多 3 次
    setClock("23:54");
    const runs = await settle(panel, "goal-m", 3);
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.deepStrictEqual(
      accountRuns(panel, "goal-m").map((run) => [run.trigger, run.plannedMinutes]),
      [["catchup", 2], ["catchup", 2], ["catchup", 2]]
    );
    assert.strictEqual(runs.length, 3);

    // 扫码超时：通知中写明还差多少，当天不再补跑
    setClock("12:00");
    await panel.call("PUT", "api/accounts/timeout-n/goal", { goal: { minutes: 30, checkAt: "06:00" } });
    const [timedOut] = await settle(panel, "timeout-n", 1);
    assert.match(runLog(panel, timedOut), /goalDeficit=30/);
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.strictEqual(accountRuns(panel, "timeout-n").length, 1, "扫码超时后当天不应再补跑");
    assert.strictEqual(panel.planner.accountStatus("timeout-n").catchups.blocked, true);
  });
};
