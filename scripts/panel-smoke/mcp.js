// 面板 smoke：MCP 接口（Streamable HTTP，无状态）。认证与权限沿用 API 令牌，工具按权限列出

const assert = require("assert");
const { until } = require("./helpers");

module.exports = async function mcpScenarios({ scenario, startAuthed }) {
  await scenario("MCP：初始化、按令牌的权限列出工具、调用工具；协议与传输的错误按 JSON-RPC 返回", async () => {
    const panel = await startAuthed();
    for (const id of ["slow-a", "ok-b"]) {
      await panel.call("POST", "api/accounts", { id, name: id });
    }
    const make = async (body) => (await panel.call("POST", "api/tokens", { name: "助手", ...body })).json.token;
    const reader = await make({ scopes: ["read"], accounts: ["slow-a"] });
    const full = await make({ scopes: ["read", "run", "notes"] });
    let nextId = 1;
    const send = (token, body, headers = {}) =>
      panel.request("mcp", { method: "POST", body, headers: { Authorization: `Bearer ${token}`, Accept: "application/json, text/event-stream", ...headers } });
    const rpc = async (token, method, params) => {
      const res = await send(token, { jsonrpc: "2.0", id: nextId++, method, ...(params ? { params } : {}) });
      assert.strictEqual(res.status, 200, res.text);
      return res.json;
    };
    const call = async (token, name, args = {}) => (await rpc(token, "tools/call", { name, arguments: args })).result;

    // 传输：没有令牌 401；只支持 POST；协议版本、Origin、JSON 的检查
    const anonymous = await panel.request("mcp", { method: "POST", body: { jsonrpc: "2.0", id: 1, method: "ping" } });
    assert.deepStrictEqual([anonymous.status, anonymous.json.error.code], [401, -32001]);
    assert.match(anonymous.headers.get("www-authenticate"), /^Bearer/);
    const get = await panel.request("mcp", { headers: { Authorization: `Bearer ${reader}` } });
    assert.deepStrictEqual([get.status, get.headers.get("allow")], [405, "POST"]);
    assert.strictEqual((await send(reader, { jsonrpc: "2.0", id: 1, method: "ping" }, { "MCP-Protocol-Version": "1999-01-01" })).status, 400);
    assert.strictEqual((await send(reader, { jsonrpc: "2.0", id: 1, method: "ping" }, { Origin: "https://evil.example" })).status, 403);
    assert.strictEqual((await send(reader, { jsonrpc: "2.0", id: 1, method: "ping" }, { Origin: `http://127.0.0.1:${panel.port}` })).status, 200);
    const broken = await panel.request("mcp", { method: "POST", body: "{", headers: { Authorization: `Bearer ${reader}`, "Content-Type": "application/json" } });
    assert.deepStrictEqual([broken.status, broken.json.error.code], [400, -32700]);

    // 初始化：回应客户端请求的版本（支持时），否则最新版本；通知返回 202
    const init = await rpc(reader, "initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "smoke", version: "1" } });
    assert.deepStrictEqual([init.result.protocolVersion, init.result.serverInfo.name, Boolean(init.result.capabilities.tools)], ["2025-03-26", "weread-assistant", true]);
    assert.strictEqual((await rpc(reader, "initialize", { protocolVersion: "2099-01-01" })).result.protocolVersion, "2025-06-18");
    const initialized = await send(reader, { jsonrpc: "2.0", method: "notifications/initialized" });
    assert.deepStrictEqual([initialized.status, initialized.text], [202, ""]);
    assert.deepStrictEqual((await rpc(reader, "ping")).result, {});
    assert.strictEqual((await rpc(reader, "resources/list")).error.code, -32601);
    assert.strictEqual((await send(reader, { hello: 1 })).json.error.code, -32600);

    // 工具按权限列出；看不到的工具不能调用
    const readerTools = (await rpc(reader, "tools/list")).result.tools;
    assert.deepStrictEqual(readerTools.map((tool) => tool.name), ["list_accounts", "get_account_status", "list_recent_runs"]);
    assert.ok(readerTools.every((tool) => tool.inputSchema.type === "object" && tool.annotations.readOnlyHint === true));
    const fullTools = (await rpc(full, "tools/list")).result.tools.map((tool) => tool.name);
    assert.ok(["start_reading", "stop_run", "get_book_notes", "search_notes", "get_weekly_report"].every((name) => fullTools.includes(name)));
    assert.strictEqual((await rpc(reader, "tools/call", { name: "start_reading", arguments: {} })).error.code, -32602);
    assert.strictEqual((await rpc(reader, "tools/call", { name: "list_recent_runs", arguments: { limit: "3" } })).error.code, -32602);
    assert.strictEqual((await rpc(reader, "tools/call", { name: "list_accounts", arguments: { extra: 1 } })).error.code, -32602);

    // 调用：结果同时有文本与结构化内容；令牌只能访问一个账号时可以不填 account_id
    const listed = await call(reader, "list_accounts");
    assert.deepStrictEqual(listed.structuredContent.accounts.map((account) => account.id), ["slow-a"]);
    assert.deepStrictEqual(JSON.parse(listed.content[0].text), listed.structuredContent);
    const status = await call(reader, "get_account_status");
    assert.deepStrictEqual([status.isError, status.structuredContent.id], [false, "slow-a"]);
    const hidden = await call(reader, "get_account_status", { account_id: "ok-b" });
    assert.deepStrictEqual([hidden.isError, /账号不存在/.test(hidden.content[0].text)], [true, true]);
    const ambiguous = await call(full, "get_account_status");
    assert.ok(ambiguous.isError && /slow-a、ok-b/.test(ambiguous.content[0].text), "能访问多个账号时要求指定");

    // 开始与停止阅读；结果中没有登录链接
    const started = await call(full, "start_reading", { account_id: "slow-a" });
    assert.strictEqual(started.isError, false);
    assert.ok(!/loginUrl/.test(started.content[0].text));
    await until(async () => (await call(full, "get_account_status", { account_id: "slow-a" })).structuredContent.activeRun?.status === "reading", {
      message: "应开始阅读",
    });
    const again = await call(full, "start_reading", { account_id: "slow-a" });
    assert.ok(again.isError && /已在运行/.test(again.content[0].text));
    assert.strictEqual((await call(full, "stop_run", { account_id: "slow-a" })).isError, false);
    await until(async () => (await call(full, "list_recent_runs", { account_id: "slow-a", limit: 1 })).structuredContent.runs[0]?.status === "stopped", {
      message: "应停止",
    });

    // 笔记：没有同步过时是工具错误，不是协议错误；Markdown 以文本返回
    const notes = await call(full, "get_book_notes", { account_id: "ok-b", book_id: "1" });
    assert.ok(notes.isError && /Markdown/.test(notes.content[0].text));
    assert.strictEqual((await rpc(full, "tools/call", { name: "get_book_notes", arguments: { account_id: "ok-b" } })).error.code, -32602, "缺少必填参数");

    // 批量：每条请求一个响应，通知没有响应
    const batch = await send(full, [
      { jsonrpc: "2.0", id: "a", method: "ping" },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: "b", method: "tools/list" },
    ]);
    assert.deepStrictEqual(batch.json.map((reply) => reply.id), ["a", "b"]);
  });
};
