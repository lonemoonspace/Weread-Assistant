const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { describeSeleniumStatus, displaySeleniumUrl, normalizeSeleniumUrl, parseSeleniumStatus } = require("../../src/shared/selenium");

describe("Selenium 地址", () => {
  it("补协议、协议小写、去掉末尾斜杠", () => {
    assert.equal(normalizeSeleniumUrl(" grid:4444/ "), "http://grid:4444");
    assert.equal(normalizeSeleniumUrl("HTTPS://grid/wd/hub//"), "https://grid/wd/hub");
  });

  it("展示时去掉用户名与密码", () => {
    assert.equal(displaySeleniumUrl("http://u:p@grid:4444"), "http://grid:4444");
    assert.equal(displaySeleniumUrl("not a url//u:p@host"), "not a url//host");
  });
});

describe("parseSeleniumStatus", () => {
  it("Grid：统计已用与可用的会话数", () => {
    const status = parseSeleniumStatus({
      value: {
        ready: true,
        message: "Selenium Grid ready.",
        nodes: [
          { availability: "UP", maxSessions: 2, slots: [{ session: { id: 1 } }, { session: null }, { session: null }] },
          { availability: "DOWN", maxSessions: 1, slots: [{ session: null }] },
        ],
      },
    });
    assert.deepEqual(status, { state: "ready", ready: true, message: "Selenium Grid ready.", sessions: { used: 1, total: 2 }, nodes: 2 });
    assert.equal(describeSeleniumStatus(status), "就绪，已用 1/2 个会话：Selenium Grid ready.");
  });

  it("会话全部占用时为 busy，否则为 not-ready", () => {
    const full = parseSeleniumStatus({ value: { ready: false, nodes: [{ availability: "UP", slots: [{ session: {} }] }] } });
    assert.equal(full.state, "busy");
    const down = parseSeleniumStatus({ value: { ready: false, nodes: [] } });
    assert.equal(down.state, "not-ready");
  });

  it("chromedriver 只有 ready；不是状态时返回 null", () => {
    assert.deepEqual(parseSeleniumStatus({ value: { ready: true } }).sessions, null);
    assert.equal(parseSeleniumStatus({ value: {} }), null);
    assert.equal(parseSeleniumStatus("<html>"), null);
  });

  it("无法连接时的说明", () => {
    assert.equal(describeSeleniumStatus({ state: "unreachable", error: "连接被拒绝（ECONNREFUSED）" }), "无法连接，连接被拒绝（ECONNREFUSED）");
  });
});
