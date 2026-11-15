const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { CHANNELS, activeChannels } = require("../../src/notify/channels");
const { httpFailure, plainText, redact } = require("../../src/notify/channels/common");
const { inlineKeyboard } = require("../../src/notify/channels/telegram");
const { parseWebhookHeader, webhookPayload } = require("../../src/notify/channels/webhook");
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

  it("Telegram 按钮只保留 http(s) 地址", () => {
    assert.equal(inlineKeyboard([]), null);
    assert.deepEqual(inlineKeyboard([{ label: "打开", url: "https://a" }, { label: "坏", url: "javascript:x" }]), {
      inline_keyboard: [[{ text: "打开", url: "https://a" }]],
    });
  });
});
