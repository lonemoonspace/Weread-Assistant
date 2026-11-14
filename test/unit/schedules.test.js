const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { describeSchedule, nextRunAt, nextRuns, normalizeSchedules, schedulePatterns } = require("../../src/panel/schedules");

describe("normalizeSchedules", () => {
  it("规范化每天固定时间：去重、排序、默认启用", () => {
    const [rule] = normalizeSchedules([{ type: "daily", times: ["18:30", "06:00", "06:00"] }]);
    assert.deepEqual(rule.times, ["06:00", "18:30"]);
    assert.equal(rule.enabled, true);
    assert.match(rule.id, /^[a-z0-9]{1,16}$/);
  });

  it("没有 ID 或 ID 重复的规则分配新 ID", () => {
    const rules = normalizeSchedules([
      { id: "a1", type: "interval", hours: 6 },
      { id: "a1", type: "interval", hours: 12, minute: 30 },
    ]);
    assert.equal(rules[0].id, "a1");
    assert.notEqual(rules[1].id, "a1");
    assert.equal(rules[0].minute, 0);
  });

  it("拒绝无效的规则", () => {
    const cases = [
      [{ type: "weekly" }, /类型只能是/],
      [{ type: "daily", times: ["24:00"] }, /HH:MM/],
      [{ type: "daily", times: [] }, /需要 1–24 个时间/],
      [{ type: "interval", hours: 5 }, /间隔小时数/],
      [{ type: "interval", hours: 6, minute: 60 }, /分钟必须是 0–59/],
      [{ type: "cron", expression: "* * * *" }, /5 段/],
      [{ type: "cron", expression: "@daily" }, /5 段/],
      [{ type: "daily", times: ["06:00"], extra: 1 }, /不支持的字段：extra/],
      [{ type: "daily", times: ["06:00"], enabled: "yes" }, /enabled/],
      [{ type: "daily", times: ["06:00"], id: "Bad-ID" }, /ID 只能包含/],
    ];
    for (const [raw, message] of cases) {
      assert.throws(() => normalizeSchedules([raw]), message, JSON.stringify(raw));
    }
    assert.throws(() => normalizeSchedules({}), /必须是数组/);
    assert.throws(() => normalizeSchedules(Array(11).fill({ type: "interval", hours: 1 })), /最多 10 条/);
  });
});

describe("schedulePatterns 与 describeSchedule", () => {
  it("每天固定时间每个时间一条 cron", () => {
    assert.deepEqual(schedulePatterns({ type: "daily", times: ["06:05", "18:30"] }), ["5 6 * * *", "30 18 * * *"]);
    assert.equal(describeSchedule({ type: "daily", times: ["06:05", "18:30"] }), "每天 06:05、18:30");
  });

  it("每 N 小时从 0 点起算", () => {
    assert.deepEqual(schedulePatterns({ type: "interval", hours: 1, minute: 15 }), ["15 * * * *"]);
    assert.deepEqual(schedulePatterns({ type: "interval", hours: 6, minute: 0 }), ["0 */6 * * *"]);
    assert.equal(describeSchedule({ type: "interval", hours: 6, minute: 5 }), "每 6 小时（从 00:05 起）");
  });
});

describe("nextRuns", () => {
  const from = new Date("2026-11-14T22:30:00Z");

  it("按面板时区计算触发时间", () => {
    const rule = { type: "daily", times: ["06:00"], enabled: true };
    // 上海时间 06:00 = UTC 前一天 22:00；22:30Z 之后的下一次是第二天 22:00Z
    assert.deepEqual(nextRuns(rule, { timezone: "Asia/Shanghai", from, count: 2 }), [
      "2026-11-15T22:00:00.000Z",
      "2026-11-16T22:00:00.000Z",
    ]);
    assert.deepEqual(nextRuns(rule, { timezone: "Europe/Berlin", from, count: 1 }), ["2026-11-15T05:00:00.000Z"]);
  });

  it("多个时间合并后按时间排序", () => {
    const rule = { type: "daily", times: ["06:00", "23:45"], enabled: true };
    assert.deepEqual(nextRuns(rule, { timezone: "UTC", from, count: 3 }), [
      "2026-11-14T23:45:00.000Z",
      "2026-11-15T06:00:00.000Z",
      "2026-11-15T23:45:00.000Z",
    ]);
  });

  it("无效规则返回空数组", () => {
    assert.deepEqual(nextRuns({ type: "cron", expression: "not a cron" }, { timezone: "UTC", from }), []);
  });

  it("nextRunAt 只看启用的账号与规则", () => {
    const account = {
      enabled: true,
      schedules: [
        { type: "daily", times: ["08:00"], enabled: false },
        { type: "daily", times: ["09:00"], enabled: true },
      ],
    };
    assert.equal(nextRunAt(account, "UTC", from), "2026-11-15T09:00:00.000Z");
    assert.equal(nextRunAt({ ...account, enabled: false }, "UTC", from), null);
    assert.equal(nextRunAt({ enabled: true, schedules: [] }, "UTC", from), null);
  });
});
