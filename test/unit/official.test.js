const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { OfficialApiError, SKILL_VERSION, createOfficialApi } = require("../../src/official/api");

const KEY = "wrk-test1234567890";

// 依次返回 responses 中的结果，并记录请求
function fakePost(responses) {
  const calls = [];
  const post = async (url, payload, headers, timeoutMs, options) => {
    calls.push({ url, payload, headers, timeoutMs, options });
    const next = responses.shift();
    return typeof next === "function" ? next() : next;
  };
  return { post, calls };
}

const ok = (body) => ({ ok: true, status: 200, body: JSON.stringify(body), error: "" });

describe("微信读书官方 API 客户端", () => {
  it("参数平铺在顶层，带 api_name、skill_version 与 Bearer 鉴权", async () => {
    const { post, calls } = fakePost([ok({ errcode: 0, totalBookCount: 3 })]);
    const api = createOfficialApi({ apiKey: KEY, post, gatewayUrl: "http://gateway.test/api" });
    const body = await api.call("/user/notebooks", { count: 20, lastSort: 123 });
    assert.equal(body.totalBookCount, 3);
    assert.deepEqual(calls[0].payload, { count: 20, lastSort: 123, api_name: "/user/notebooks", skill_version: SKILL_VERSION });
    assert.equal(calls[0].headers.Authorization, `Bearer ${KEY}`);
    assert.equal(calls[0].url, "http://gateway.test/api");
    assert.ok(calls[0].options.maxBytes > 1024 * 1024);
  });

  it("没有 API Key 或格式不对时报错", () => {
    assert.throws(() => createOfficialApi({ apiKey: "" }), (e) => e instanceof OfficialApiError && e.kind === "key");
    assert.throws(() => createOfficialApi({ apiKey: "sk-123456789" }), /wrk-/);
  });

  it("errcode 非 0、HTTP 401、回包不是 JSON 时报出类别；错误信息中不出现 API Key", async () => {
    const cases = [
      [{ ok: true, status: 200, body: JSON.stringify({ errcode: -2012, errmsg: `登录超时 ${KEY}` }), error: "" }, "key"],
      [{ ok: true, status: 200, body: JSON.stringify({ errcode: 100, errmsg: "参数错误" }), error: "" }, "api"],
      [{ ok: false, status: 401, body: "", error: "" }, "key"],
      [{ ok: true, status: 200, body: "<html>", error: "" }, "format"],
      [{ ok: false, status: 400, body: "", error: "" }, "network"],
    ];
    for (const [response, kind] of cases) {
      const { post } = fakePost([response]);
      const api = createOfficialApi({ apiKey: KEY, post });
      await assert.rejects(api.call("/user/notebooks"), (e) => {
        assert.equal(e.kind, kind, JSON.stringify(response));
        assert.ok(!e.message.includes(KEY));
        return true;
      });
    }
  });

  it("499、5xx 与网络错误时重试，最多 3 次", async () => {
    const { post, calls } = fakePost([
      { ok: false, status: 499, body: "", error: "" },
      { ok: false, status: 0, body: "", error: "socket hang up" },
      ok({ errcode: 0, books: [] }),
    ]);
    const api = createOfficialApi({ apiKey: KEY, post, retryDelayMs: 1 });
    assert.deepEqual((await api.call("/user/notebooks")).books, []);
    assert.equal(calls.length, 3);

    const failing = fakePost([
      { ok: false, status: 503, body: "", error: "" },
      { ok: false, status: 503, body: "", error: "" },
      { ok: false, status: 503, body: "", error: "" },
    ]);
    const api2 = createOfficialApi({ apiKey: KEY, post: failing.post, retryDelayMs: 1 });
    await assert.rejects(api2.call("/user/notebooks"), /HTTP 503/);
    assert.equal(failing.calls.length, 3);
  });
});
