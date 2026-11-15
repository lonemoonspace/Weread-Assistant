const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { CHANNELS, activeChannels } = require("../../src/notify/channels");
const { httpFailure, plainText, redact } = require("../../src/notify/channels/common");
const { inlineKeyboard } = require("../../src/notify/channels/telegram");
const { RESERVED_HEADERS, checkResponse, parseWebhookHeader, webhookPayload } = require("../../src/notify/channels/webhook");
const { CONFIG_SCHEMA } = require("../../src/config/schema");
const { resolveConfig } = require("../../src/config/resolve");

const message = {
  event: "done",
  title: "WeReadAssistant · 小明",
  subtitle: "阅读完成",
  body: "阅读完成，共 68 分钟",
  level: "active",
  url: "",
  actions: [],
};

describe("渠道列表", () => {
  it("每个渠道导出相同的描述，开关都是配置项", () => {
    const keys = new Set(Object.keys(resolveConfig({})));
    for (const channel of CHANNELS) {
      assert.equal(typeof channel.id, "string");
      assert.equal(typeof channel.isConfigured, "function");
      assert.equal(typeof channel.send, "function");
      assert.ok(keys.has(channel.toggle), channel.toggle);
    }
    assert.deepEqual(CHANNELS.map((channel) => channel.id), ["bark", "ntfy", "webhook", "telegram"]);
  });

  it("配置完整且开关为开时才发送；旧配置没有开关时按开处理", () => {
    const config = resolveConfig({ barkKey: "k", ntfyTopic: "t", ntfyEnabled: false, telegramBotToken: "1:x" });
    assert.deepEqual(activeChannels(config).map((channel) => channel.id), ["bark"], "Telegram 缺少会话 ID");
    assert.deepEqual(activeChannels({ barkKey: "k" }).map((channel) => channel.id), ["bark"]);
  });
});

describe("Webhook 请求体", () => {
  const config = resolveConfig({ accountName: "小明" });

  it("通用 JSON 带事件、账号与时间", () => {
    const payload = webhookPayload(config, message);
    assert.equal(payload.source, "WeReadAssistant");
    assert.equal(payload.event, "done");
    assert.equal(payload.account, "小明");
    assert.equal(payload.text, message.body);
    assert.ok(!Number.isNaN(Date.parse(payload.time)));
  });

  it("群机器人发纯文本，标题中含关键词 WeReadAssistant", () => {
    const text = "WeReadAssistant · 小明 · 阅读完成\n\n阅读完成，共 68 分钟";
    assert.deepEqual(webhookPayload({ ...config, webhookFormat: "wecom" }, message), { msgtype: "text", text: { content: text } });
    assert.deepEqual(webhookPayload({ ...config, webhookFormat: "dingtalk" }, message), { msgtype: "text", text: { content: text } });
    assert.deepEqual(webhookPayload({ ...config, webhookFormat: "feishu" }, message), { msg_type: "text", content: { text } });
  });

  it("附加请求头：名称: 值；不能改写 Content-Type 等，不能换行", () => {
    assert.deepEqual(parseWebhookHeader(""), {});
    assert.deepEqual(parseWebhookHeader("Authorization: Bearer abc"), { Authorization: "Bearer abc" });
    assert.deepEqual(parseWebhookHeader("X-Token:abc "), { "X-Token": "abc" });
    assert.equal(parseWebhookHeader("Content-Type: text/plain"), null);
    assert.equal(parseWebhookHeader("A: b\r\nHost: evil"), null);
    assert.equal(parseWebhookHeader("no colon"), null);
  });

  it("配置项的格式校验在保存时就拒绝不能改写的请求头，与发送时的检查一致", () => {
    const { pattern } = CONFIG_SCHEMA.find((field) => field.key === "webhookHeader");
    for (const name of RESERVED_HEADERS) {
      assert.equal(pattern.test(`${name}: x`), false, name);
      assert.equal(pattern.test(`${name.toUpperCase()} : x`), false, name);
    }
    assert.ok(pattern.test("Authorization: Bearer abc"));
    assert.ok(pattern.test("X-Host-Name: a"), "名称只是以保留名开头的不受影响");
  });

  it("群机器人按响应体的错误码判断，字符串 0 也算成功，响应不是对象时给出原因", () => {
    assert.equal(checkResponse("wecom", '{"errcode":0,"errmsg":"ok"}'), "");
    assert.equal(checkResponse("dingtalk", '{"errcode":"0"}'), "");
    assert.equal(checkResponse("feishu", '{"StatusCode":0}'), "");
    assert.equal(checkResponse("wecom", '{"errcode":93000,"errmsg":"invalid webhook url"}'), "错误码 93000：invalid webhook url");
    assert.equal(checkResponse("wecom", "{}"), "错误码 （无）");
    assert.match(checkResponse("feishu", "null"), /^响应不是对象/);
    assert.match(checkResponse("dingtalk", "[1]"), /^响应不是对象/);
    assert.equal(checkResponse("json", "anything"), "");
  });
});

describe("公用部分", () => {
  it("纯文本：点击地址不在正文中时附在最后", () => {
    assert.equal(plainText({ ...message, url: "https://x/y" }), "WeReadAssistant · 小明 · 阅读完成\n\n阅读完成，共 68 分钟\n\nhttps://x/y");
    assert.equal(plainText({ ...message, body: "打开 https://x/y", url: "https://x/y" }), "WeReadAssistant · 小明 · 阅读完成\n\n打开 https://x/y");
  });

  it("错误信息中的密钥替换为掩码", () => {
    const config = resolveConfig({ telegramBotToken: "123:secret-token-value", webhookUrl: "https://hook/abc" });
    assert.equal(redact(config, "GET https://api/bot123:secret-token-value/sendMessage"), "GET https://api/bot••••••/sendMessage");
    assert.equal(httpFailure(config, { error: "connect https://hook/abc refused" }), "请求出错：connect •••••• refused");
    assert.equal(httpFailure(config, { status: 500, body: "x".repeat(300) }).length, "HTTP 500：".length + 201);
  });

  it("先脱敏再截断：跨过截断位置的密钥不会留下前一段；URL 编码后的密钥同样替换", () => {
    const secret = "https://hook.example/send?key=abcdef0123456789";
    const config = resolveConfig({ webhookUrl: secret });
    const reason = httpFailure(config, { status: 400, body: `${"x".repeat(190)}${secret}` });
    assert.ok(!reason.includes("https://hook"), reason);
    assert.ok(reason.includes("••••••"), reason);
    assert.equal(redact(config, `url=${encodeURIComponent(secret)}`), "url=••••••");
  });

  it("Telegram 按钮只保留 http(s) 地址", () => {
    assert.equal(inlineKeyboard([]), null);
    assert.deepEqual(inlineKeyboard([{ label: "打开", url: "https://a" }, { label: "坏", url: "javascript:x" }]), {
      inline_keyboard: [[{ text: "打开", url: "https://a" }]],
    });
  });
});
