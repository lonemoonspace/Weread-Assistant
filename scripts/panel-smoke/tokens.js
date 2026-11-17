// 面板 smoke：API 令牌的管理与 api/v1（按权限与账号限定、过期、限速、不能访问管理接口、不返回敏感字段）

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { until } = require("./helpers");

const bearer = (token) => ({ Authorization: `Bearer ${token}` });

module.exports = async function tokenScenarios({ scenario, startAuthed }) {
  await scenario("API 令牌：新建时校验名称、权限、账号与有效期；令牌只返回一次，panel.json 只存哈希；可以删除", async () => {
    const panel = await startAuthed();
    await panel.call("POST", "api/accounts", { id: "ok-a", name: "甲" });
    const empty = (await panel.call("GET", "api/tokens")).json;
    assert.deepStrictEqual([empty.tokens, Object.keys(empty.scopes)], [[], ["read", "run", "notes"]]);

    const bad = [
      [{ name: "", scopes: ["read"] }, /名称/],
      [{ name: "x", scopes: [] }, /权限/],
      [{ name: "x", scopes: ["admin"] }, /权限/],
      [{ name: "x", scopes: ["read"], accounts: ["nope"] }, /账号不存在/],
      [{ name: "x", scopes: ["read"], accounts: [] }, /accounts/],
      [{ name: "x", scopes: ["read"], expiresInDays: 0 }, /有效天数/],
      [{ name: "x", scopes: ["read"], extra: 1 }, /未知的字段/],
    ];
    for (const [body, pattern] of bad) {
      const res = await panel.call("POST", "api/tokens", body);
      assert.strictEqual(res.status, 400, JSON.stringify(body));
      assert.match(res.json.message, pattern);
    }

    const created = await panel.call("POST", "api/tokens", { name: "脚本", scopes: ["run", "read"], accounts: ["ok-a"], expiresInDays: 30 });
    assert.strictEqual(created.status, 201);
    const { token, info } = created.json;
    assert.match(token, /^wat_[A-Za-z0-9_-]{43}$/);
    assert.deepStrictEqual([info.name, info.scopes, info.accounts, info.hash], ["脚本", ["read", "run"], ["ok-a"], undefined]);
    assert.ok(info.hint.startsWith(token.slice(0, 8)) && info.hint.endsWith(token.slice(-4)));
    assert.ok(Date.parse(info.expiresAt) - Date.parse(info.createdAt) === 30 * 86400000);

    const listed = (await panel.call("GET", "api/tokens")).json.tokens;
    assert.deepStrictEqual(listed.map((item) => [item.id, item.hash]), [[info.id, undefined]]);
    const saved = fs.readFileSync(path.join(panel.options.dataDir, "panel.json"), "utf8");
    assert.ok(!saved.includes(token), "panel.json 中不能有令牌本身");
    assert.match(JSON.parse(saved).auth.tokens[0].hash, /^[0-9a-f]{64}$/);

    assert.strictEqual((await panel.request("api/v1/me", { headers: bearer(token) })).status, 200);
    assert.strictEqual((await panel.call("DELETE", `api/tokens/${info.id}`)).status, 204);
    assert.strictEqual((await panel.call("DELETE", `api/tokens/${info.id}`)).status, 404);
    assert.strictEqual((await panel.request("api/v1/me", { headers: bearer(token) })).status, 401, "删除后立即失效");
    assert.strictEqual((await panel.request("api/tokens")).status, 401, "管理接口需要登录");
  });

  await scenario("api/v1：令牌按权限与账号限定，不能访问其他账号与管理接口，不返回配置与登录链接；可以开始与停止运行", async () => {
    const panel = await startAuthed();
    for (const id of ["slow-a", "ok-b"]) {
      await panel.call("POST", "api/accounts", { id, name: id });
    }
    await panel.call("PATCH", "api/accounts/slow-a", { overrides: { duration: 5, barkKey: "secret-bark-key" } });
    const make = async (body) => (await panel.call("POST", "api/tokens", { name: "t", ...body })).json.token;
    const reader = await make({ scopes: ["read"], accounts: ["slow-a"] });
    const runner = await make({ scopes: ["read", "run"] });
    const get = (token, url) => panel.request(url, { headers: bearer(token) });
    const post = (token, url, body) => panel.request(url, { method: "POST", body, headers: bearer(token) });

    // 认证：没有令牌、格式不对、只有面板会话都不行；令牌不能访问面板自己的接口
    const none = await panel.request("api/v1/accounts");
    assert.strictEqual(none.status, 401);
    assert.match(none.headers.get("www-authenticate"), /^Bearer/);
    assert.strictEqual((await get("wat_nope", "api/v1/accounts")).status, 401);
    assert.strictEqual((await panel.call("GET", "api/v1/accounts")).status, 401, "面板会话不能代替令牌");
    assert.strictEqual((await get(runner, "api/settings")).status, 401, "令牌不能访问管理接口");
    assert.strictEqual((await get(runner, "api/tokens")).status, 401);
    assert.strictEqual((await get(runner, "api/v1/nope")).status, 404);

    // 只能看到允许的账号；不允许的账号与不存在的一样 404
    const me = (await get(reader, "api/v1/me")).json;
    assert.deepStrictEqual(me, { name: "t", scopes: ["read"], accounts: ["slow-a"] });
    const accounts = (await get(reader, "api/v1/accounts")).json;
    assert.deepStrictEqual(accounts.accounts.map((account) => account.id), ["slow-a"]);
    assert.strictEqual((await get(reader, "api/v1/accounts/ok-b")).status, 404);
    assert.strictEqual((await get(reader, "api/v1/accounts/missing")).status, 404);
    const detail = await get(reader, "api/v1/accounts/slow-a");
    assert.strictEqual(detail.status, 200);
    assert.ok(!/overrides|barkKey|secret-bark-key|loginUrl|cookies/.test(detail.text), "不返回配置、密钥与登录链接");
    assert.deepStrictEqual(Object.keys(detail.json.today), ["date", "minutes", "checkedIn"]);

    // 没有 run 权限时 403；有时可以开始与停止
    const denied = await post(reader, "api/v1/accounts/slow-a/runs", { mode: "read" });
    assert.deepStrictEqual([denied.status, denied.json.error], [403, "forbidden"]);
    assert.strictEqual((await post(reader, "api/v1/accounts/slow-a/stop")).status, 403);
    assert.strictEqual((await post(runner, "api/v1/accounts/slow-a/runs", { mode: "bad" })).status, 400);
    const started = await post(runner, "api/v1/accounts/slow-a/runs", { mode: "read" });
    assert.strictEqual(started.status, 202);
    assert.ok(!/loginUrl|screenshot/.test(started.text));
    await until(async () => (await get(runner, "api/v1/accounts/slow-a")).json.activeRun?.status === "reading", { message: "应开始阅读" });
    assert.strictEqual((await post(runner, "api/v1/accounts/slow-a/runs", {})).status, 409, "已在运行时 409");
    assert.strictEqual((await post(runner, "api/v1/accounts/slow-a/stop")).status, 202);
    await until(async () => (await get(runner, "api/v1/accounts/slow-a/runs?limit=1")).json.runs[0]?.status === "stopped", { message: "应停止" });
    assert.strictEqual((await get(runner, "api/v1/accounts/slow-a/runs?limit=99")).status, 400);
    assert.strictEqual((await get(runner, "api/v1/accounts/ok-b/notes")).status, 403, "没有 notes 权限");
    const notes = await make({ scopes: ["notes"], accounts: ["ok-b"] });
    assert.deepStrictEqual(
      [(await get(notes, "api/v1/accounts/ok-b/notes")).json.configured, (await get(notes, "api/v1/accounts/ok-b")).status],
      [false, 403],
      "只有 notes 权限时能读笔记状态，不能看账号状态"
    );
    assert.strictEqual((await post(notes, "api/v1/accounts/ok-b/notes/sync")).status, 400, "没有 API Key 时 400");
    assert.strictEqual((await get(notes, "api/v1/accounts/ok-b/notes/search?q=")).status, 400);
    assert.strictEqual((await get(notes, "api/v1/accounts/ok-b/notes/markdown")).status, 404);

    // 删除账号后，限定了这个账号的令牌不再包含它；新建同名账号也不能访问
    assert.strictEqual((await panel.call("DELETE", "api/accounts/ok-b")).status, 204);
    await panel.call("POST", "api/accounts", { id: "ok-b", name: "新的" });
    assert.deepStrictEqual((await get(notes, "api/v1/me")).json.accounts, []);
    assert.strictEqual((await get(notes, "api/v1/accounts/ok-b/notes")).status, 404);
  });

  await scenario("api/v1：过期的令牌失效；同一 IP 认证失败过多时暂停（有效的令牌也暂停）", async () => {
    const clock = { offset: 0, now: () => Date.now() + clock.offset };
    const panel = await startAuthed({ tokens: { now: clock.now } });
    const token = (await panel.call("POST", "api/tokens", { name: "短期", scopes: ["read"], expiresInDays: 1 })).json.token;
    const get = (value) => panel.request("api/v1/me", { headers: bearer(value) });
    assert.strictEqual((await get(token)).status, 200);
    clock.offset = 86400000 + 1000;
    assert.strictEqual((await get(token)).status, 401, "过期后失效");
    const listed = (await panel.call("GET", "api/tokens")).json.tokens;
    assert.ok(listed[0].lastUsedAt, "记录最近使用时间");

    clock.offset = 0;
    const fresh = (await panel.call("POST", "api/tokens", { name: "长期", scopes: ["read"] })).json.token;
    // 算上前面过期的那一次，共 19 次失败
    for (let i = 0; i < 18; i += 1) {
      assert.strictEqual((await get(`wat_${"x".repeat(43)}`)).status, 401);
    }
    assert.strictEqual((await get(fresh)).status, 200, "19 次失败后仍可使用");
    assert.strictEqual((await get("bad")).status, 401);
    const limited = await get(fresh);
    assert.strictEqual(limited.status, 429);
    assert.ok(Number(limited.headers.get("retry-after")) > 0);
  });
};
