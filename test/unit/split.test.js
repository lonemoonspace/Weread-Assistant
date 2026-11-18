const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { PanelError } = require("../../src/panel/errors");
const { createPlanner, zonedTime } = require("../../src/panel/planner");
const { SEGMENT_GAP_MINUTES, minuteOf, normalizeSplit, planSegments, storedSplit } = require("../../src/panel/split");
const { createStore } = require("../../src/panel/store");
const { minutesFrom, writeRun } = require("../../scripts/fixtures/run-records");

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

// 可重复的伪随机数
function seeded(seed) {
  let value = seed;
  return () => {
    value = (value * 9301 + 49297) % 233280;
    return value / 233280;
  };
}

const SPLIT = { minutes: 60, from: "07:00", to: "23:00", minSegment: 15, maxSegment: 35 };

describe("分段阅读设置", () => {
  it("校验字段、时段与能否排下", () => {
    assert.deepEqual(normalizeSplit(SPLIT), { enabled: true, ...SPLIT });
    assert.equal(normalizeSplit(null), null);
    assert.throws(() => normalizeSplit({ ...SPLIT, minutes: 0 }), /1–1440/);
    assert.throws(() => normalizeSplit({ ...SPLIT, from: "7:00" }), /HH:MM/);
    assert.throws(() => normalizeSplit({ ...SPLIT, from: "23:00", to: "07:00" }), /晚于开始时间/);
    assert.throws(() => normalizeSplit({ ...SPLIT, minSegment: 40 }), /最短不能超过最长/);
    assert.throws(() => normalizeSplit({ ...SPLIT, maxSegment: 4 }), /5–240/);
    assert.throws(() => normalizeSplit({ ...SPLIT, extra: 1 }), /不支持的字段/);
    assert.throws(() => normalizeSplit({ ...SPLIT, minutes: 300, from: "07:00", to: "10:00" }), /最多能读 105 分钟/);
    assert.equal(storedSplit({ minutes: "x" }), null, "panel.json 中无效的设置当作没有");
  });

  it("排出的各段：总分钟数、每段长度、段间隔与时段都符合设置", () => {
    for (let seed = 1; seed <= 200; seed += 1) {
      const segments = planSegments({ total: 60, start: minuteOf("07:00"), end: minuteOf("23:00"), minSegment: 15, maxSegment: 35, random: seeded(seed) });
      assert.equal(segments.reduce((sum, segment) => sum + segment.minutes, 0), 60);
      let lastEnd = -Infinity;
      for (const segment of segments) {
        assert.ok(segment.minutes >= 15 && segment.minutes <= 35, JSON.stringify(segments));
        const start = minuteOf(segment.time);
        assert.ok(start >= minuteOf("07:00") && start + segment.minutes <= minuteOf("23:00"), JSON.stringify(segments));
        assert.ok(start - lastEnd >= SEGMENT_GAP_MINUTES, JSON.stringify(segments));
        lastEnd = start + segment.minutes;
      }
    }
  });

  it("只有最后一段可以短于每段最短时长（例如每段固定 20 分钟、一天 50 分钟）", () => {
    for (const [total, minSegment, maxSegment] of [[50, 20, 20], [30, 20, 20], [50, 15, 15], [100, 25, 40], [61, 30, 31], [60, 15, 35]]) {
      for (let seed = 1; seed <= 100; seed += 1) {
        const segments = planSegments({ total, start: minuteOf("07:00"), end: minuteOf("23:00"), minSegment, maxSegment, random: seeded(seed) });
        const label = `${total}/${minSegment}–${maxSegment}: ${JSON.stringify(segments)}`;
        assert.equal(segments.reduce((sum, segment) => sum + segment.minutes, 0), total, label);
        assert.ok(segments.every((segment) => segment.minutes <= maxSegment), label);
        assert.ok(segments.slice(0, -1).every((segment) => segment.minutes >= minSegment), label);
      }
    }
    assert.deepEqual(
      planSegments({ total: 50, start: minuteOf("07:00"), end: minuteOf("23:00"), minSegment: 20, maxSegment: 20, random: seeded(3) }).map((s) => s.minutes),
      [20, 20, 10]
    );
  });

  it("剩下的分钟不到一段时排一段；时段不够时少读一些", () => {
    assert.deepEqual(
      planSegments({ total: 10, start: 600, end: 700, minSegment: 15, maxSegment: 35, random: () => 0 }),
      [{ time: "10:00", minutes: 10 }]
    );
    const tight = planSegments({ total: 60, start: minuteOf("22:20"), end: minuteOf("23:00"), minSegment: 15, maxSegment: 35, random: () => 0 });
    assert.deepEqual(tight, [{ time: "22:20", minutes: 35 }]);
    assert.deepEqual(planSegments({ total: 0, start: 600, end: 700, minSegment: 15, maxSegment: 35 }), []);
    assert.deepEqual(planSegments({ total: 30, start: 700, end: 700, minSegment: 15, maxSegment: 35 }), []);
  });
});

describe("计划器中的分段阅读", () => {
  let dataDir;
  let store;
  let now;
  let enqueued;
  let active;
  const clock = { now: () => now, setTimeout: () => null, clearTimeout: () => {}, setInterval: () => null, clearInterval: () => {} };
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
  const at = (time, date = "2026-11-15") => zonedTime(date, time, "Asia/Shanghai");
  const create = () => createPlanner({ dataDir, store, runner, clock, random: seeded(7), warn: async () => {} });

  beforeEach(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "split-test-"));
    store = createStore(dataDir);
    await store.update((data) => {
      data.accounts.push({
        id: "a1",
        name: "a1",
        enabled: true,
        overrides: {},
        schedules: [],
        challenge: null,
        goal: null,
        split: normalizeSplit(SPLIT),
      });
    });
    now = at("00:00");
    enqueued = [];
    active = new Set();
  });

  afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it("每天排好各段，到点以 split 加入队列；读满后取消剩下的段", () => {
    const planner = create();
    quietly(() => planner.recover());
    const { segments } = planner.accountStatus("a1").split;
    assert.ok(segments.length >= 2);
    assert.equal(segments.reduce((sum, segment) => sum + segment.minutes, 0), 60);
    assert.ok(segments.every((segment) => segment.status === "planned"));

    // 第一段到点
    now = Date.parse(segments[0].at);
    quietly(() => planner.tick());
    assert.deepEqual(enqueued, [{ accountId: "a1", mode: "read", trigger: "split", minutes: segments[0].minutes, delayedMinutes: 0 }]);
    assert.equal(planner.accountStatus("a1").split.segments[0].status, "started");

    // 手动读满 60 分钟：下一次检查取消剩下的段
    const start = new Date(now + 60000).toISOString();
    writeRun(dataDir, "a1", { queuedAt: start, marks: minutesFrom(start, 60) });
    now += 2 * 60 * 60000;
    const logs = quietly(() => planner.tick());
    assert.ok(logs.some((line) => line.includes("取消剩下的")));
    assert.ok(planner.accountStatus("a1").split.segments.slice(1).every((segment) => segment.status === "cancelled"));
    assert.equal(enqueued.length, 1);
  });

  it("账号忙时等待，晚了 2 小时跳过；只读今天还差的分钟", () => {
    const planner = create();
    quietly(() => planner.recover());
    const [first, second] = planner.accountStatus("a1").split.segments;
    active.add("a1");
    now = Date.parse(first.at) + 60000;
    quietly(() => planner.tick());
    assert.equal(enqueued.length, 0);
    now = Date.parse(first.at) + 2 * 60 * 60000;
    const logs = quietly(() => planner.tick());
    assert.ok(logs.some((line) => line.includes("跳过")));
    active.clear();

    // 今天已经读了 50 分钟：第二段只读 10 分钟
    const start = new Date(Date.parse(second.at) - 3 * 60 * 60000).toISOString();
    writeRun(dataDir, "a1", { queuedAt: start, marks: minutesFrom(start, 50) });
    now = Math.max(now, Date.parse(second.at));
    quietly(() => planner.tick());
    const last = enqueued.at(-1);
    assert.equal(last.trigger, "split");
    assert.equal(last.minutes, 10);
  });

  it("中途开启时从现在起排今天还差的；设置变了重新排；关闭后删除计划；第二天重新排", async () => {
    now = at("21:00");
    const planner = create();
    quietly(() => planner.recover());
    const { segments } = planner.accountStatus("a1").split;
    assert.ok(segments.every((segment) => Date.parse(segment.at) > now && Date.parse(segment.at) < at("23:00")));

    await store.update((data) => {
      data.accounts[0].split = normalizeSplit({ ...SPLIT, minutes: 20, minSegment: 20, maxSegment: 20 });
    });
    quietly(() => planner.refreshSplit("a1"));
    assert.deepEqual(planner.accountStatus("a1").split.segments.map((segment) => segment.minutes), [20]);

    await store.update((data) => {
      data.accounts[0].split = { ...data.accounts[0].split, enabled: false };
    });
    quietly(() => planner.tick());
    assert.equal(planner.accountStatus("a1").split, null);

    await store.update((data) => {
      data.accounts[0].split = { ...data.accounts[0].split, enabled: true };
    });
    now = at("06:00", "2026-11-16");
    quietly(() => planner.tick());
    assert.equal(planner.accountStatus("a1").split.date, "2026-11-16");
    // 计划写入 planner.json，重启后仍在
    planner.close();
    const again = create();
    assert.equal(again.accountStatus("a1").split.date, "2026-11-16");
    again.close();
  });

  it("只开了分段阅读的账号也算每天应该打卡：今天的段都过去了还没打卡时提醒", async () => {
    await store.update((data) => {
      data.accounts[0].split = normalizeSplit({ ...SPLIT, minutes: 30, from: "07:00", to: "12:00" });
    });
    const warnings = [];
    const planner = createPlanner({ dataDir, store, runner, clock, warn: async (config, body) => warnings.push(body) });
    now = at("06:00");
    quietly(() => planner.recover());
    for (const segment of planner.accountStatus("a1").split.segments) {
      now = Date.parse(segment.at);
      quietly(() => planner.tick());
    }
    assert.ok(planner.accountStatus("a1").split.segments.every((segment) => segment.status !== "planned"));
    now = at("21:30");
    quietly(() => planner.tick());
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /^今天只读了 0 分钟/);
  });

  it("planner.json 中无效的分段计划与分段加载时丢弃", () => {
    const valid = { at: new Date(at("10:00")).toISOString(), time: "10:00", minutes: 20, status: "planned" };
    fs.writeFileSync(
      path.join(dataDir, "planner.json"),
      JSON.stringify({
        version: 1,
        pending: [],
        catchups: {},
        splits: {
          a1: { date: "2026-11-15", key: "x", segments: [valid, { ...valid, at: "oops" }, { ...valid, minutes: "20" }, { ...valid, status: "weird" }, null] },
          b2: { date: 20261115, segments: [] },
          c3: "broken",
        },
      })
    );
    const logs = quietly(() => create().close());
    assert.ok(logs.some((line) => line.includes("6 个分段计划或分段格式无效")), logs.join("\n"));
  });

  it("还有没开始的段时不发断签预警", async () => {
    const warnings = [];
    now = at("21:30");
    const planner = createPlanner({ dataDir, store, runner, clock, random: () => 0.99, warn: async (config, body) => warnings.push(body) });
    quietly(() => planner.recover());
    assert.ok(planner.accountStatus("a1").split.segments.some((segment) => segment.status === "planned"));
    assert.equal(warnings.length, 0);
  });
});
