const { describe, it, mock } = require("node:test");
const assert = require("node:assert/strict");
const { SECRET_MASK } = require("../../src/panel/config");
const { createRedactor, fillMinuteMarks } = require("../../src/panel/runner");

describe("fillMinuteMarks", () => {
  it("在上一条记录与现在之间均匀补齐，最后一条为现在", () => {
    mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-11-14T10:10:00Z") });
    try {
      const run = { minuteMarks: ["2026-11-14T10:04:00.000Z"], readingStartedAt: "2026-11-14T10:00:00Z" };
      fillMinuteMarks(run, 4);
      assert.deepEqual(run.minuteMarks, [
        "2026-11-14T10:04:00.000Z",
        "2026-11-14T10:06:00.000Z",
        "2026-11-14T10:08:00.000Z",
        "2026-11-14T10:10:00.000Z",
      ]);
    } finally {
      mock.timers.reset();
    }
  });

  it("没有记录时从开始阅读的时间算起；已经足够时不变", () => {
    mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-11-14T10:02:00Z") });
    try {
      const run = { minuteMarks: [], readingStartedAt: "2026-11-14T10:00:00Z" };
      fillMinuteMarks(run, 2);
      assert.deepEqual(run.minuteMarks, ["2026-11-14T10:01:00.000Z", "2026-11-14T10:02:00.000Z"]);
      fillMinuteMarks(run, 1);
      assert.equal(run.minuteMarks.length, 2);
    } finally {
      mock.timers.reset();
    }
  });
});

describe("createRedactor", () => {
  it("替换配置中的密钥值与扫码登录链接中的 uid", () => {
    const redact = createRedactor({ barkKey: "bark-secret", ntfyTopic: "abc", emailPass: "longer-bark-secret-pass" });
    const line = "key=bark-secret pass=longer-bark-secret-pass topic=abc url=https://weread.qq.com/web/confirm?pf=2&uid=123456&x=1";
    assert.equal(
      redact(line),
      `key=${SECRET_MASK} pass=${SECRET_MASK} topic=abc url=https://weread.qq.com/web/confirm?pf=2&uid=${SECRET_MASK}&x=1`
    );
  });
});
