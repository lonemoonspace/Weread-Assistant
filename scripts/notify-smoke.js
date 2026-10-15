#!/usr/bin/env node
/**
 * 通知渠道 smoke 测试。
 *
 * 通过本地 mock HTTP 服务校验 Bark / ntfy 的实际请求负载，不访问外网、不需要真实密钥。
 * 用法: node scripts/notify-smoke.js
 */

const assert = require("assert");
const http = require("http");
const path = require("path");

const notifications = require(path.resolve(__dirname, "..", "src", "weread-challenge.js"));

const {
  notify,
  sendBark,
  sendNtfy,
  setRuntimeConfigFromEnv,
} = notifications;

function startMockServer() {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      requests.push({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body,
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ id: "mock-message", event: "message" }));
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        server,
        requests,
        baseUrl: `http://127.0.0.1:${port}`,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

async function withQuietConsole(fn) {
  const original = { info: console.info, warn: console.warn, error: console.error };
  const logs = [];
  const capture = (...args) => logs.push(args.map(String).join(" "));
  console.info = capture;
  console.warn = capture;
  console.error = capture;
  try {
    return await fn();
  } catch (error) {
    error.capturedLogs = logs;
    throw error;
  } finally {
    console.info = original.info;
    console.warn = original.warn;
    console.error = original.error;
  }
}

function parseBody(request) {
  return JSON.parse(request.body);
}

async function main() {
  const mock = await startMockServer();
  const results = [];

  const scenario = async (name, fn) => {
    mock.requests.length = 0;
    await withQuietConsole(() => fn());
    results.push(name);
    console.log(`✅ ${name}`);
  };

  try {
    await scenario("Bark 负载保持原有字段", async () => {
      setRuntimeConfigFromEnv({
        BARK_KEY: "bark-key-123",
        BARK_SERVER: mock.baseUrl,
      });

      const ok = await sendBark("微信读书挑战", "登录成功", {
        subtitle: "项目启动",
        level: "active",
        sound: "birdsong",
        url: "https://weread.qq.com/",
      });

      assert.strictEqual(ok, true);
      assert.strictEqual(mock.requests.length, 1);
      const request = mock.requests[0];
      assert.strictEqual(request.method, "POST");
      assert.strictEqual(request.url, "/bark-key-123");
      assert.deepStrictEqual(parseBody(request), {
        title: "微信读书挑战",
        body: "登录成功",
        sound: "birdsong",
        group: "WeRead-Challenge",
        level: "active",
        subtitle: "项目启动",
        url: "https://weread.qq.com/",
      });
    });

    await scenario("ntfy 负载映射优先级、标签、点击与附件", async () => {
      setRuntimeConfigFromEnv({
        NTFY_TOPIC: "weread_smoke_topic",
        NTFY_SERVER: mock.baseUrl,
      });

      const ok = await sendNtfy("微信读书挑战", "发生错误：超时", {
        subtitle: "项目停滞",
        level: "critical",
        sound: "alarm",
        url: "https://weread.qq.com/",
        image: "https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=abc",
        markdown: true,
        actions: [{ action: "view", label: "打开链接", url: "https://weread.qq.com/" }],
      });

      assert.strictEqual(ok, true);
      assert.strictEqual(mock.requests.length, 1);
      const request = mock.requests[0];
      assert.strictEqual(request.url, "/");
      assert.match(request.headers["content-type"], /application\/json/);
      assert.deepStrictEqual(parseBody(request), {
        topic: "weread_smoke_topic",
        title: "微信读书挑战 · 项目停滞",
        message: "发生错误：超时",
        priority: 5,
        tags: ["rotating_light"],
        click: "https://weread.qq.com/",
        attach: "https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=abc",
        markdown: true,
        actions: [{ action: "view", label: "打开链接", url: "https://weread.qq.com/" }],
      });
    });

    await scenario("ntfy 支持 Access Token 与 Basic Auth", async () => {
      setRuntimeConfigFromEnv({
        NTFY_TOPIC: "weread_smoke_topic",
        NTFY_SERVER: mock.baseUrl,
        NTFY_TOKEN: "tk_123",
      });
      await sendNtfy("标题", "正文");
      assert.strictEqual(mock.requests[0].headers.authorization, "Bearer tk_123");

      setRuntimeConfigFromEnv({
        NTFY_TOPIC: "weread_smoke_topic",
        NTFY_SERVER: mock.baseUrl,
        NTFY_USERNAME: "demo",
        NTFY_PASSWORD: "secret",
      });
      await sendNtfy("标题", "正文");
      const expected = `Basic ${Buffer.from("demo:secret", "utf8").toString("base64")}`;
      assert.strictEqual(mock.requests[1].headers.authorization, expected);
    });

    await scenario("NTFY_PRIORITY / NTFY_TAGS 覆盖默认映射", async () => {
      setRuntimeConfigFromEnv({
        NTFY_TOPIC: "weread_smoke_topic",
        NTFY_SERVER: mock.baseUrl,
        NTFY_PRIORITY: "5",
        NTFY_TAGS: "book,heavy_check_mark",
      });
      await sendNtfy("标题", "正文", { level: "active", sound: "birdsong" });
      const payload = parseBody(mock.requests[0]);
      assert.strictEqual(payload.priority, 5);
      assert.deepStrictEqual(payload.tags, ["book", "heavy_check_mark"]);

      // 字符串别名必须归一化为数字：ntfy JSON 接口的 priority 是 int，
      // 传字符串会得到 400 {"code":40024,"error":"invalid request: request body must be valid JSON"}
      setRuntimeConfigFromEnv({
        NTFY_TOPIC: "weread_smoke_topic",
        NTFY_SERVER: mock.baseUrl,
        NTFY_PRIORITY: "urgent",
      });
      await sendNtfy("标题", "正文", { level: "active", sound: "birdsong" });
      assert.strictEqual(parseBody(mock.requests[1]).priority, 5);

      setRuntimeConfigFromEnv({
        NTFY_TOPIC: "weread_smoke_topic",
        NTFY_SERVER: mock.baseUrl,
      });
      await sendNtfy("标题", "正文", { level: "active", sound: "birdsong" });
      assert.strictEqual(parseBody(mock.requests[2]).priority, 3);
      await sendNtfy("标题", "正文", { level: "critical", sound: "alarm" });
      assert.strictEqual(parseBody(mock.requests[3]).priority, 5);
    });

    await scenario("非法 ntfy 主题直接拦截且不发起请求", async () => {
      setRuntimeConfigFromEnv({
        NTFY_TOPIC: "bad topic!",
        NTFY_SERVER: mock.baseUrl,
      });
      const ok = await sendNtfy("标题", "正文");
      assert.strictEqual(ok, false);
      assert.strictEqual(mock.requests.length, 0);
    });

    await scenario("notify 同时推送 Bark 与 ntfy", async () => {
      setRuntimeConfigFromEnv({
        BARK_KEY: "bark-key-123",
        BARK_SERVER: mock.baseUrl,
        NTFY_TOPIC: "weread_smoke_topic",
        NTFY_SERVER: mock.baseUrl,
      });

      const sent = await notify("微信读书挑战", `阅读完成，持续时间：10分钟`, {
        subtitle: "项目完成",
        level: "active",
        sound: "success",
      });

      assert.deepStrictEqual(sent, [
        { channel: "bark", ok: true },
        { channel: "ntfy", ok: true },
      ]);
      assert.strictEqual(mock.requests.length, 2);
      assert.deepStrictEqual(
        mock.requests.map((request) => request.url).sort(),
        ["/", "/bark-key-123"]
      );
      const ntfyPayload = parseBody(mock.requests.find((request) => request.url === "/"));
      assert.strictEqual(ntfyPayload.title, "微信读书挑战 · 项目完成");
      assert.deepStrictEqual(ntfyPayload.tags, ["tada"]);
    });

    await scenario("未配置任何渠道时 notify 静默返回空结果", async () => {
      setRuntimeConfigFromEnv({});
      const sent = await notify("标题", "正文");
      assert.deepStrictEqual(sent, []);
      assert.strictEqual(mock.requests.length, 0);
    });

    await scenario("渠道失败不影响其他渠道结果", async () => {
      setRuntimeConfigFromEnv({
        BARK_KEY: "bark-key-123",
        BARK_SERVER: "http://127.0.0.1:1",
        NTFY_TOPIC: "weread_smoke_topic",
        NTFY_SERVER: mock.baseUrl,
      });

      const sent = await notify("标题", "正文", { level: "critical", sound: "alarm" });
      assert.deepStrictEqual(sent, [
        { channel: "bark", ok: false },
        { channel: "ntfy", ok: true },
      ]);
    });

    console.log(`\n通知 smoke 全部通过（${results.length} 个场景）`);
  } finally {
    await mock.close();
  }
}

main().catch((error) => {
  console.error(`通知 smoke 失败: ${error.message}`);
  if (error.capturedLogs) {
    console.error("捕获的日志:");
    console.error(error.capturedLogs.join("\n"));
  }
  process.exit(1);
});
