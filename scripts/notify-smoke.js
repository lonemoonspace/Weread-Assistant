#!/usr/bin/env node
/**
 * 通知渠道 smoke 测试。
 *
 * 通过本地 mock HTTP 服务校验 Bark / ntfy 的实际请求负载，用本地 SMTP 服务校验邮件，不访问外网、不需要真实密钥。
 * 用法: node scripts/notify-smoke.js
 */

const assert = require("assert");
const fs = require("fs");
const http = require("http");
const net = require("net");
const os = require("os");
const path = require("path");
const { PNG } = require("pngjs");

const { createNotifier, notify, sendBark, sendNtfy, sendTestNotification } = require(path.resolve(__dirname, "..", "src", "notify"));
const { resolveConfig } = require(path.resolve(__dirname, "..", "src", "config", "resolve"));

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

// 最简单的 SMTP 服务（不支持 TLS）：记录认证信息、发件人、收件人与邮件原文；rejectAuth 为 true 时拒绝认证
function startMockSmtp() {
  const messages = [];
  const state = { rejectAuth: false };
  const server = net.createServer((socket) => {
    let buffer = "";
    let inData = false;
    let current = { auth: "", from: "", to: [], data: "" };
    const reply = (line) => socket.write(`${line}\r\n`);
    reply("220 mock-smtp ESMTP");
    socket.on("data", (chunk) => {
      buffer += chunk.toString("latin1");
      for (;;) {
        if (inData) {
          const end = buffer.indexOf("\r\n.\r\n");
          if (end === -1) {
            return;
          }
          messages.push({ ...current, data: buffer.slice(0, end) });
          buffer = buffer.slice(end + 5);
          inData = false;
          current = { auth: current.auth, from: "", to: [], data: "" };
          reply("250 OK queued");
          continue;
        }
        const end = buffer.indexOf("\r\n");
        if (end === -1) {
          return;
        }
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const command = line.split(" ")[0].toUpperCase();
        if (command === "EHLO") {
          socket.write("250-mock-smtp\r\n250-AUTH PLAIN LOGIN\r\n250 8BITMIME\r\n");
        } else if (command === "AUTH") {
          current.auth = line.slice(5);
          reply(state.rejectAuth ? "535 5.7.8 Authentication credentials invalid" : "235 Authentication successful");
        } else if (command === "MAIL") {
          current.from = line;
          reply("250 OK");
        } else if (command === "RCPT") {
          current.to.push(line);
          reply("250 OK");
        } else if (command === "DATA") {
          inData = true;
          reply("354 End data with <CR><LF>.<CR><LF>");
        } else if (command === "QUIT") {
          reply("221 Bye");
          socket.end();
        } else {
          reply("250 OK");
        }
      }
    });
    socket.on("error", () => {});
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        messages,
        state,
        port: server.address().port,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

// 解码邮件头中的 =?UTF-8?B?...?= / =?UTF-8?Q?...?=
function decodeHeader(value) {
  return value.replace(/\?=\s+=\?/g, "?==?").replace(/=\?UTF-8\?([BQ])\?([^?]*)\?=/gi, (_, encoding, text) =>
    encoding.toUpperCase() === "B"
      ? Buffer.from(text, "base64").toString("utf8")
      : Buffer.from(text.replace(/_/g, " ").replace(/=([0-9A-F]{2})/gi, (__, hex) => String.fromCharCode(parseInt(hex, 16))), "latin1").toString("utf8")
  );
}

function mailHeader(data, name) {
  const match = data.match(new RegExp(`^${name}: ((?:.*)(?:\r\n[ \t].*)*)`, "mi"));
  return match ? decodeHeader(match[1].replace(/\r\n[ \t]/g, " ")) : "";
}

async function withQuietConsole(fn) {
  const original = { info: console.info, warn: console.warn, error: console.error };
  const logs = [];
  const capture = (...args) => logs.push(args.map(String).join(" "));
  console.info = capture;
  console.warn = capture;
  console.error = capture;
  try {
    return await fn(logs);
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
  let config;

  const scenario = async (name, fn) => {
    mock.requests.length = 0;
    await withQuietConsole((logs) => fn(logs));
    results.push(name);
    console.log(`✅ ${name}`);
  };

  try {
    await scenario("Bark 负载保持原有字段；日志中不出现 Bark Key", async (logs) => {
      config = resolveConfig({
        barkKey: "bark-key-123",
        barkServer: mock.baseUrl,
      });

      const ok = await sendBark(config, "微信读书挑战", "登录成功", {
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
      assert.ok(logs.some((line) => line.includes(`发送Bark推送: ${mock.baseUrl}`)));
      assert.ok(!logs.some((line) => line.includes("bark-key-123")), "日志中不应出现 Bark Key");
      assert.deepStrictEqual(parseBody(request), {
        title: "微信读书挑战",
        body: "登录成功",
        sound: "birdsong",
        group: "WeReadAssistant",
        level: "active",
        subtitle: "项目启动",
        url: "https://weread.qq.com/",
      });
    });

    await scenario("Bark 服务器地址缺少协议时直接拦截，日志中不出现 Bark Key", async (logs) => {
      config = resolveConfig({
        barkKey: "bark-key-123",
        barkServer: "api.day.app",
      });

      const ok = await sendBark(config, "微信读书挑战", "登录成功");

      assert.strictEqual(ok, false);
      assert.strictEqual(mock.requests.length, 0);
      assert.ok(logs.some((line) => line.includes("Bark 服务器地址无效")));
      assert.ok(!logs.some((line) => line.includes("bark-key-123")), "日志中不应出现 Bark Key");
    });

    await scenario("ntfy 负载映射优先级、标签、点击与附件", async () => {
      config = resolveConfig({
        ntfyTopic: "weread_smoke_topic",
        ntfyServer: mock.baseUrl,
      });

      const ok = await sendNtfy(config, "微信读书挑战", "发生错误：超时", {
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
      config = resolveConfig({
        ntfyTopic: "weread_smoke_topic",
        ntfyServer: mock.baseUrl,
        ntfyToken: "tk_123",
      });
      await sendNtfy(config, "标题", "正文");
      assert.strictEqual(mock.requests[0].headers.authorization, "Bearer tk_123");

      config = resolveConfig({
        ntfyTopic: "weread_smoke_topic",
        ntfyServer: mock.baseUrl,
        ntfyUsername: "demo",
        ntfyPassword: "secret",
      });
      await sendNtfy(config, "标题", "正文");
      const expected = `Basic ${Buffer.from("demo:secret", "utf8").toString("base64")}`;
      assert.strictEqual(mock.requests[1].headers.authorization, expected);
    });

    await scenario("NTFY_PRIORITY / NTFY_TAGS 覆盖默认映射", async () => {
      config = resolveConfig({
        ntfyTopic: "weread_smoke_topic",
        ntfyServer: mock.baseUrl,
        ntfyPriority: "5",
        ntfyTags: "book,heavy_check_mark",
      });
      await sendNtfy(config, "标题", "正文", { level: "active", sound: "birdsong" });
      const payload = parseBody(mock.requests[0]);
      assert.strictEqual(payload.priority, 5);
      assert.deepStrictEqual(payload.tags, ["book", "heavy_check_mark"]);

      // 字符串别名必须归一化为数字：ntfy JSON 接口的 priority 是 int，
      // 传字符串会得到 400 {"code":40024,"error":"invalid request: request body must be valid JSON"}
      config = resolveConfig({
        ntfyTopic: "weread_smoke_topic",
        ntfyServer: mock.baseUrl,
        ntfyPriority: "urgent",
      });
      await sendNtfy(config, "标题", "正文", { level: "active", sound: "birdsong" });
      assert.strictEqual(parseBody(mock.requests[1]).priority, 5);

      config = resolveConfig({
        ntfyTopic: "weread_smoke_topic",
        ntfyServer: mock.baseUrl,
      });
      await sendNtfy(config, "标题", "正文", { level: "active", sound: "birdsong" });
      assert.strictEqual(parseBody(mock.requests[2]).priority, 3);
      await sendNtfy(config, "标题", "正文", { level: "critical", sound: "alarm" });
      assert.strictEqual(parseBody(mock.requests[3]).priority, 5);
    });

    await scenario("非法 ntfy 主题直接拦截且不发起请求", async () => {
      config = resolveConfig({
        ntfyTopic: "bad topic!",
        ntfyServer: mock.baseUrl,
      });
      const ok = await sendNtfy(config, "标题", "正文");
      assert.strictEqual(ok, false);
      assert.strictEqual(mock.requests.length, 0);
    });

    await scenario("notify 同时推送 Bark 与 ntfy", async () => {
      config = resolveConfig({
        barkKey: "bark-key-123",
        barkServer: mock.baseUrl,
        ntfyTopic: "weread_smoke_topic",
        ntfyServer: mock.baseUrl,
      });

      const sent = await notify(config, "微信读书挑战", `阅读完成，持续时间：10分钟`, {
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
      config = resolveConfig({});
      const sent = await notify(config, "标题", "正文");
      assert.deepStrictEqual(sent, []);
      assert.strictEqual(mock.requests.length, 0);
    });

    await scenario("渠道失败不影响其他渠道结果", async () => {
      config = resolveConfig({
        barkKey: "bark-key-123",
        barkServer: "http://127.0.0.1:1",
        ntfyTopic: "weread_smoke_topic",
        ntfyServer: mock.baseUrl,
      });

      const sent = await notify(config, "标题", "正文", { level: "critical", sound: "alarm" });
      assert.deepStrictEqual(sent, [
        { channel: "bark", ok: false },
        { channel: "ntfy", ok: true },
      ]);
    });

    await scenario("登录链接推送附带按钮且同一链接只推送一次", async () => {
      config = resolveConfig({
        ntfyTopic: "weread_smoke_topic",
        ntfyServer: mock.baseUrl,
      });
      const notifier = createNotifier(config);
      const loginUrl = "https://weread.qq.com/web/confirm?uid=smoke";

      await notifier.loginLink(loginUrl);
      await notifier.loginLink(loginUrl);

      assert.strictEqual(mock.requests.length, 1);
      const payload = parseBody(mock.requests[0]);
      assert.strictEqual(payload.title, "WeReadAssistant · 需要扫码");
      assert.strictEqual(payload.priority, 4);
      assert.strictEqual(payload.click, loginUrl);
      assert.match(payload.message, /登录链接：https:\/\/weread\.qq\.com\/web\/confirm\?uid=smoke/);
      assert.deepStrictEqual(
        payload.actions.map((action) => action.label),
        ["打开登录链接"]
      );
      // 不再经过第三方服务生成二维码图片
      assert.strictEqual(payload.attach, undefined);
      assert.doesNotMatch(mock.requests[0].body, /qrserver/);
    });

    await scenario("配置了面板地址时扫码推送附带面板链接；解析不出登录链接时改为推送面板链接", async () => {
      config = resolveConfig({
        ntfyTopic: "weread_smoke_topic",
        ntfyServer: mock.baseUrl,
      });
      const panelLink = "https://example.com/weread/#/accounts/me/live";
      const notifier = createNotifier(config, { panelLink });
      await notifier.loginLink("https://weread.qq.com/web/confirm?uid=both");
      const both = parseBody(mock.requests[0]);
      assert.strictEqual(both.click, "https://weread.qq.com/web/confirm?uid=both");
      assert.match(both.message, /在面板中扫码：https:\/\/example\.com\/weread\/#\/accounts\/me\/live/);
      assert.deepStrictEqual(both.actions.map((action) => action.label), ["打开登录链接", "在面板中扫码"]);

      await notifier.loginLink("");
      await notifier.loginLink("");
      assert.strictEqual(mock.requests.length, 2, "解析不出登录链接时只推送一次面板链接");
      const panelOnly = parseBody(mock.requests[1]);
      assert.strictEqual(panelOnly.click, panelLink);
      assert.match(panelOnly.message, /未能从二维码中解析出登录链接/);
      assert.deepStrictEqual(panelOnly.actions.map((action) => action.label), ["在面板中扫码"]);

      // 没有面板地址时解析不出登录链接不推送
      await createNotifier(config).loginLink("");
      assert.strictEqual(mock.requests.length, 2);
    });

    await scenario("二维码刷新后按最小间隔限制登录链接推送", async () => {
      config = resolveConfig({
        ntfyTopic: "weread_smoke_topic",
        ntfyServer: mock.baseUrl,
      });
      const notifier = createNotifier(config, { loginLinkIntervalMs: 60000 });

      await notifier.loginLink("https://weread.qq.com/web/confirm?uid=first");
      await notifier.loginLink("https://weread.qq.com/web/confirm?uid=second");

      assert.strictEqual(mock.requests.length, 1);
      assert.strictEqual(parseBody(mock.requests[0]).click, "https://weread.qq.com/web/confirm?uid=first");
    });

    await scenario("通知标题带账号名，按事件开关推送", async () => {
      config = resolveConfig({
        ntfyTopic: "weread_smoke_topic",
        ntfyServer: mock.baseUrl,
        accountName: "小明",
      });
      const notifier = createNotifier(config);

      // 默认只开启需要扫码、阅读完成、运行失败
      await notifier.event("start", "开始自动阅读");
      await notifier.event("loginSuccess", "登录成功");
      assert.strictEqual(mock.requests.length, 0);

      await notifier.event("done", "阅读完成，共 68 分钟");
      await notifier.event("failure", "运行出错：超时");
      assert.strictEqual(mock.requests.length, 2);
      const [done, failure] = mock.requests.map(parseBody);
      assert.strictEqual(done.title, "WeReadAssistant · 小明 · 阅读完成");
      assert.deepStrictEqual(done.tags, ["tada"]);
      assert.strictEqual(failure.title, "WeReadAssistant · 小明 · 运行失败");
      assert.strictEqual(failure.priority, 5);

      config = resolveConfig({
        ntfyTopic: "weread_smoke_topic",
        ntfyServer: mock.baseUrl,
        notifyOnStart: "true",
        notifyOnDone: "false",
      });
      const custom = createNotifier(config);
      await custom.event("start", "开始自动阅读");
      await custom.event("done", "阅读完成");
      assert.strictEqual(mock.requests.length, 3);
      assert.strictEqual(parseBody(mock.requests[2]).title, "WeReadAssistant · 开始运行");
    });

    await scenario("邮件：经 SMTP 认证后发送，主题带账号名与版本，截图作为内嵌附件；测试通知返回成功；认证失败、无法连接时返回失败，日志中不出现密码", async (logs) => {
      const smtp = await startMockSmtp();
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "notify-smoke-"));
      try {
        const screenshot = path.join(dir, "screenshot-1.png");
        fs.writeFileSync(screenshot, PNG.sync.write(new PNG({ width: 4, height: 4 })));
        const emailConfig = {
          accountName: "小明",
          emailEnabled: "true",
          emailSmtp: "127.0.0.1",
          emailPort: smtp.port,
          emailUser: "reader@example.com",
          emailPass: "smtp-pass-123",
          emailTo: "me@example.com",
        };
        config = resolveConfig(emailConfig);
        await createNotifier(config).event("done", "阅读完成，共 68 分钟", { attachments: [screenshot] });
        assert.strictEqual(smtp.messages.length, 1);
        const [message] = smtp.messages;
        assert.strictEqual(Buffer.from(message.auth.replace(/^PLAIN /, ""), "base64").toString(), "\0reader@example.com\0smtp-pass-123");
        assert.match(message.from, /^MAIL FROM:<reader@example\.com>/);
        assert.deepStrictEqual(message.to, ["RCPT TO:<me@example.com>"]);
        assert.match(mailHeader(message.data, "Subject"), /^WeReadAssistant · 小明 · 阅读完成 \[v\d+\.\d+\.\d+\]$/);
        assert.match(message.data, /Content-Type: image\/png;\s+name=screenshot-1\.png/);
        assert.match(message.data, /Content-ID: <screenshot-1\.png>/);
        assert.match(message.data, /Content-Type: text\/html/);

        const results = await sendTestNotification(config);
        assert.deepStrictEqual(results, [{ channel: "email", ok: true }]);
        assert.match(mailHeader(smtp.messages[1].data, "Subject"), /^WeReadAssistant · 小明 · 测试通知/);

        smtp.state.rejectAuth = true;
        assert.deepStrictEqual(await sendTestNotification(config), [{ channel: "email", ok: false }], "认证失败");
        await smtp.close();
        assert.deepStrictEqual(await sendTestNotification(config), [{ channel: "email", ok: false }], "无法连接");
        const credentials = Buffer.from("\0reader@example.com\0smtp-pass-123").toString("base64");
        assert.ok(!logs.some((line) => line.includes("smtp-pass-123") || line.includes(credentials)), "日志中不应出现邮箱密码");
      } finally {
        await smtp.close().catch(() => {});
        fs.rmSync(dir, { recursive: true, force: true });
      }
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
