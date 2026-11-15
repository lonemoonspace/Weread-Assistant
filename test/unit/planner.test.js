const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { PanelError } = require("../../src/panel/errors");
const { catchupWindowMinutes, normalizeGoal, publicGoal, storedGoal, suggestedGoalMinutes } = require("../../src/panel/goal");
const { createPlanner, zonedTime } = require("../../src/panel/planner");
const { retriesLeftFor, retryDelayMs } = require("../../src/panel/retry");
const { describeSchedule, nextRunInfo, normalizeSchedules } = require("../../src/panel/schedules");
const { createStore } = require("../../src/panel/store");

// 静默运行，返回捕获的日志
function quietly(fn) {
  const logs = [];
  const saved = {};
  for (const level of ["info", "warn", "error", "log"]) {
    saved[level] = console[level];
    console[level] = (...args) => logs.push(args.join(" "));
  }
  try {
    fn();
  } finally {
    Object.assign(console, saved);
  }
  return logs;
}

describe("重试规则", () => {
  it("只有自动触发的运行有重试次数，按尝试次数递减", () => {
    assert.equal(retriesLeftFor("manual", 1, 2), 0);
    assert.equal(retriesLeftFor("schedule", 1, 2), 2);
    assert.equal(retriesLeftFor("retry", 2, 2), 1);
    assert.equal(retriesLeftFor("retry", 3, 2), 0);
    assert.equal(retriesLeftFor("catchup", 1, 0), 0);
  });

  it("间隔依次为 5、15、30 分钟，之后都是 30 分钟", () => {
    assert.deepEqual([1, 2, 3, 4, 5].map((n) => retryDelayMs(n) / 60000), [5, 15, 30, 30, 30]);
  });
});

describe("每日目标", () => {
  it("校验目标设置", () => {
    assert.deepEqual(normalizeGoal({ minutes: 30, checkAt: "21:30" }), { enabled: true, minutes: 30, checkAt: "21:30" });
    assert.equal(normalizeGoal(null), null);
    assert.throws(() => normalizeGoal({ minutes: 0, checkAt: "21:30" }), /1–1440/);
    assert.throws(() => normalizeGoal({ minutes: 30, checkAt: "9:30" }), /HH:MM/);
    assert.throws(() => normalizeGoal({ minutes: 30, checkAt: "21:30", extra: 1 }), /不支持的字段/);
    assert.equal(storedGoal({ minutes: "x" }), null, "panel.json 中无效的目标当作没有设置");
  });

  it("补跑读到 23:57 为止；检查时间太晚时提示", () => {
    assert.equal(catchupWindowMinutes("22:00"), 117);
    assert.equal(catchupWindowMinutes("23:59"), 0);
    assert.equal(publicGoal({ enabled: true, minutes: 30, checkAt: "22:00" }, null).warning, "");
    assert.match(publicGoal({ enabled: true, minutes: 30, checkAt: "23:40" }, null).warning, /最多还能补读 17 分钟/);
  });

  it("按挑战给出每日建议值", () => {
    assert.equal(suggestedGoalMinutes({ type: "month" }), 60);
    assert.equal(suggestedGoalMinutes({ type: "year" }), 50);
    assert.equal(suggestedGoalMinutes(null), null);
  });
});

describe("调度随机延后", () => {
  it("jitterMinutes 校验，为 0 时不保存", () => {
    const [rule, plain] = normalizeSchedules([
      { type: "daily", times: ["06:00"], jitterMinutes: 10 },
      { type: "daily", times: ["07:00"], jitterMinutes: 0 },
    ]);
    assert.equal(rule.jitterMinutes, 10);
    assert.equal(Object.hasOwn(plain, "jitterMinutes"), false);
    assert.match(describeSchedule(rule), /随机延后 0–10 分钟/);
    assert.throws(() => normalizeSchedules([{ type: "daily", times: ["06:00"], jitterMinutes: 31 }]), /0–30/);
  });

  it("下次运行带上随机延后的范围", () => {
    const account = { enabled: true, schedules: normalizeSchedules([{ type: "daily", times: ["06:00"], jitterMinutes: 10 }]) };
    const next = nextRunInfo(account, "Asia/Shanghai", new Date("2026-11-15T00:00:00Z"));
    assert.deepEqual(next, { at: "2026-11-15T22:00:00.000Z", jitterMinutes: 10 });
  });
});

describe("zonedTime", () => {
  it("把时区中的日期与时刻换算为时间戳，含夏令时", () => {
    assert.equal(new Date(zonedTime("2026-11-15", "06:00", "Asia/Shanghai")).toISOString(), "2026-11-14T22:00:00.000Z");
    assert.equal(new Date(zonedTime("2026-07-01", "12:00", "America/New_York")).toISOString(), "2026-07-01T16:00:00.000Z");
    assert.equal(new Date(zonedTime("2026-12-01", "12:00", "America/New_York")).toISOString(), "2026-12-01T17:00:00.000Z");
  });
});

describe("createPlanner", () => {
  let dataDir;
  let store;
  let now;
  let enqueued;
  let active;
  const clock = {
    now: () => now,
    setTimeout: () => null,
    clearTimeout: () => {},
    setInterval: () => null,
    clearInterval: () => {},
  };
  const runner = {
    enqueue(accountId, options) {
      if (active.has(accountId)) {
        throw new PanelError(409, "run_active", "账号已在运行或排队");
      }
      enqueued.push({ accountId, ...options });
      return { id: `run-${enqueued.length}` };
    },
    isActive: (accountId) => active.has(accountId),
  };
  const failedRun = (extra = {}) => ({
    id: "20261115T000000000Z-aaaa",
    accountId: "a1",
    mode: "read",
    trigger: "schedule",
    status: "failed",
    errorKind: "error",
    attempt: 1,
    startedAt: "2026-11-15T00:00:00.000Z",
    plannedMinutes: 30,
    minutes: 12,
    ...extra,
  });

  beforeEach(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "planner-test-"));
    store = createStore(dataDir);
    await store.update((data) => {
      data.accounts.push({ id: "a1", name: "a1", enabled: true, overrides: {}, schedules: [], challenge: null, goal: null });
    });
    now = Date.parse("2026-11-15T04:00:00Z");
    enqueued = [];
    active = new Set();
  });

  afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it("失败后按间隔重试，只读剩余分钟；到期前不执行；手动运行与扫码超时不重试", () => {
    const planner = createPlanner({ dataDir, store, runner, clock });
    quietly(() => {
      planner.recover();
      planner.handleFinished(failedRun());
      planner.handleFinished(failedRun({ trigger: "manual", id: "20261115T000000000Z-bbbb" }));
      planner.handleFinished(failedRun({ errorKind: "login-timeout", id: "20261115T000000000Z-cccc" }));
    });
    assert.equal(planner.accountStatus("a1").pending.length, 1);
    now += 4 * 60000;
    quietly(() => planner.tick());
    assert.equal(enqueued.length, 0);
    now += 60000;
    quietly(() => planner.tick());
    assert.deepEqual(enqueued, [
      { accountId: "a1", mode: "read", trigger: "retry", minutes: 18, attempt: 2, originRunId: "20261115T000000000Z-aaaa" },
    ]);
  });

  it("重试到期时账号正在运行则每 5 分钟顺延，2 小时后放弃；账号停用后丢弃待办", async () => {
    const planner = createPlanner({ dataDir, store, runner, clock });
    quietly(() => {
      planner.recover();
      planner.handleFinished(failedRun());
    });
    active.add("a1");
    now += 5 * 60000;
    let logs = quietly(() => planner.tick());
    assert.equal(enqueued.length, 0);
    assert.ok(logs.some((line) => line.includes("这次重试顺延到")));
    const [postponed] = planner.accountStatus("a1").pending;
    assert.equal(Date.parse(postponed.dueAt), now + 5 * 60000);

    // 账号空下来后照常重试
    active.clear();
    now += 5 * 60000;
    quietly(() => planner.tick());
    assert.equal(enqueued.length, 1);
    assert.equal(enqueued[0].trigger, "retry");

    // 一直忙：从原定时间起 2 小时后放弃
    quietly(() => planner.handleFinished(failedRun({ id: "20261115T000000000Z-eeee" })));
    active.add("a1");
    now += 5 * 60000;
    for (let i = 0; i < 30 && planner.accountStatus("a1").pending.length > 0; i += 1) {
      logs = quietly(() => planner.tick());
      now += 5 * 60000;
    }
    assert.equal(planner.accountStatus("a1").pending.length, 0);
    assert.ok(logs.some((line) => line.includes("放弃这次重试，不再执行")));
    assert.equal(enqueued.length, 1);

    active.clear();
    quietly(() => planner.handleFinished(failedRun()));
    await store.update((data) => {
      data.accounts[0].enabled = false;
    });
    assert.equal(planner.accountStatus("a1").pending.length, 0);
  });

  it("已经读满时不重试；没开始阅读的按配置的时长重试", () => {
    const planner = createPlanner({ dataDir, store, runner, clock });
    quietly(() => {
      planner.recover();
      planner.handleFinished(failedRun({ minutes: 30 }));
    });
    assert.equal(planner.accountStatus("a1").pending.length, 0, "读满计划分钟数的不重试");
    quietly(() => planner.handleFinished(failedRun({ startedAt: null, plannedMinutes: 0, minutes: 0 })));
    now += 5 * 60000;
    quietly(() => planner.tick());
    assert.equal(enqueued.length, 1);
    assert.equal(enqueued[0].minutes, null, "没开始阅读时按配置的时长（不覆盖）");
  });

  it("子进程因还会重试而没发通知、结束时却不再重试的，由面板补发失败通知", async () => {
    const sent = [];
    const notify = async (config, body) => {
      sent.push(body);
    };
    const planner = createPlanner({ dataDir, store, runner, clock, notify });
    const config = { accountName: "a1" };
    quietly(() => planner.recover());
    // 运行中把重试次数改为 0
    await store.update((data) => {
      data.settings.retryCount = 0;
    });
    quietly(() => planner.handleFinished(failedRun({ error: "出错了" }), { config, retriesLeft: 2 }));
    assert.equal(planner.accountStatus("a1").pending.length, 0);
    assert.deepEqual(sent, ["运行失败：出错了"]);
    // 子进程自己发过通知（启动时没有重试次数）的不重复发送
    quietly(() => planner.handleFinished(failedRun({ error: "又出错了" }), { config, retriesLeft: 0 }));
    assert.equal(sent.length, 1);
  });

  it("定时触发因账号忙而顺延时，记录的延后分钟数包括顺延的时间", () => {
    const dueAt = new Date(now + 60000).toISOString();
    fs.writeFileSync(
      path.join(dataDir, "planner.json"),
      JSON.stringify({ pending: [{ kind: "schedule", accountId: "a1", scheduleId: "r1", dueAt, delayedMinutes: 3 }] })
    );
    const planner = createPlanner({ dataDir, store, runner, clock });
    quietly(() => planner.recover());
    active.add("a1");
    now += 60000;
    quietly(() => planner.tick());
    assert.equal(enqueued.length, 0);
    active.clear();
    now += 5 * 60000;
    quietly(() => planner.tick());
    assert.equal(enqueued.length, 1);
    assert.equal(enqueued[0].delayedMinutes, 8);
    planner.close();
  });

  it("待办写入 planner.json，重启后仍在；文件损坏时当作没有待办", () => {
    const first = createPlanner({ dataDir, store, runner, clock });
    quietly(() => first.handleFinished(failedRun()));
    first.close();
    const file = path.join(dataDir, "planner.json");
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    const second = createPlanner({ dataDir, store, runner, clock });
    assert.equal(second.accountStatus("a1").pending.length, 1);
    second.close();

    fs.writeFileSync(file, "{oops");
    let third;
    const logs = quietly(() => {
      third = createPlanner({ dataDir, store, runner, clock });
    });
    assert.equal(third.accountStatus("a1").pending.length, 0);
    assert.ok(logs.some((line) => line.includes("当作没有待办")));
  });

  it("停机期间过期的重试：宽限时间内执行，超过的丢弃", () => {
    const first = createPlanner({ dataDir, store, runner, clock });
    quietly(() => first.handleFinished(failedRun()));
    quietly(() => first.handleFinished(failedRun({ accountId: "a1", id: "20261115T000000000Z-dddd" })));
    first.close();
    const state = JSON.parse(fs.readFileSync(path.join(dataDir, "planner.json"), "utf8"));
    state.pending[1].dueAt = new Date(now - 300 * 60000).toISOString();
    fs.writeFileSync(path.join(dataDir, "planner.json"), JSON.stringify(state));
    now += 60 * 60000;
    const second = createPlanner({ dataDir, store, runner, clock });
    const logs = quietly(() => second.recover());
    assert.equal(enqueued.length, 1);
    assert.ok(logs.some((line) => line.includes("已超过补触发宽限时间，不再执行")));
  });

  it("每日目标：检查时间之前不补跑；之后补差额并截断到 23:57；每天最多 3 次", async () => {
    await store.update((data) => {
      data.accounts[0].goal = { enabled: true, minutes: 60, checkAt: "23:00" };
    });
    const planner = createPlanner({ dataDir, store, runner, clock });
    now = zonedTime("2026-11-15", "22:59", "Asia/Shanghai");
    quietly(() => planner.recover());
    assert.equal(enqueued.length, 0);
    now = zonedTime("2026-11-15", "23:20", "Asia/Shanghai");
    quietly(() => planner.tick());
    assert.deepEqual(enqueued, [{ accountId: "a1", mode: "read", trigger: "catchup", minutes: 37, goalDeficit: 60 }]);
    quietly(() => {
      planner.tick();
      planner.tick();
      planner.tick();
    });
    assert.equal(enqueued.length, 3, "每天最多补跑 3 次");
    assert.deepEqual(planner.accountStatus("a1").catchups, { count: 3, max: 3, blocked: false });
  });

  it("每日目标：加入队列失败时不计入当天的次数", async () => {
    await store.update((data) => {
      data.accounts[0].goal = { enabled: true, minutes: 60, checkAt: "23:00" };
    });
    const failing = { enqueue: () => { throw new Error("磁盘已满"); }, isActive: () => false };
    const planner = createPlanner({ dataDir, store, runner: failing, clock });
    now = zonedTime("2026-11-15", "23:20", "Asia/Shanghai");
    quietly(() => planner.recover());
    assert.deepEqual(planner.accountStatus("a1").catchups, { count: 0, max: 3, blocked: false });
  });

  it("planner.json 中到期时间无效的待办在加载时丢弃", () => {
    const file = path.join(dataDir, "planner.json");
    fs.writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        lastCheckAt: null,
        pending: [
          { id: "x1", kind: "retry", accountId: "a1", dueAt: "oops", attempt: 2, minutes: 5 },
          { id: "x2", kind: "retry", accountId: "a1", dueAt: new Date(now).toISOString(), attempt: 2, minutes: 5 },
          { id: "x3", kind: "resume", accountId: "a1", runId: "r", trigger: "schedule", endedAt: new Date(now).toISOString() },
        ],
        catchups: {},
      })
    );
    let planner;
    const logs = quietly(() => {
      planner = createPlanner({ dataDir, store, runner, clock });
    });
    assert.equal(planner.accountStatus("a1").pending.length, 1);
    assert.ok(logs.some((line) => line.includes("1 个待办格式无效")));
  });

  it("启动恢复完成之前调度器触发不更新检查时间；高频规则长时间停机后仍补触发最近的一次", async () => {
    await store.update((data) => {
      data.accounts[0].schedules = normalizeSchedules([{ type: "cron", expression: "*/5 * * * *" }]);
    });
    const file = path.join(dataDir, "planner.json");
    const lastCheckAt = new Date(now - 3 * 24 * 60 * 60000).toISOString();
    fs.writeFileSync(file, JSON.stringify({ version: 1, lastCheckAt, pending: [], catchups: {} }));
    const first = createPlanner({ dataDir, store, runner, clock });
    quietly(() => first.fireSchedule("a1", { id: "r1", type: "daily", times: ["06:00"], enabled: true }));
    first.close();
    assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).lastCheckAt, lastCheckAt, "还没恢复时不应更新检查时间");

    enqueued = [];
    now += 60000;
    const second = createPlanner({ dataDir, store, runner, clock });
    quietly(() => second.recover());
    const missed = enqueued.filter((item) => item.trigger === "schedule");
    assert.equal(missed.length, 1);
    assert.ok(missed[0].delayedMinutes <= 5, "补触发的应是最近错过的一次");
  });
});
