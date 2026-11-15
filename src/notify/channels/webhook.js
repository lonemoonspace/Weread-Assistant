const { isHttpUrl, postJson } = require("../../shared/http");
const { VERSION } = require("../../shared/version");
const { CHANNEL_TIMEOUT_MS, failure, httpFailure, plainText, redact, success, truncate } = require("./common");

// 附加请求头“名称: 值”：名称为 HTTP token，值不能含换行与控制字符
const HEADER_PATTERN = /^([!#$%&'*+.^_`|~0-9A-Za-z-]+)[ \t]*:[ \t]*((?:[^\p{Cc}]|\t)+)$/u;
// 不允许通过附加请求头修改的请求头
const RESERVED_HEADERS = new Set(["host", "content-length", "content-type", "transfer-encoding", "connection"]);

const FORMAT_LABELS = {
  json: "通用 JSON",
  wecom: "企业微信群机器人",
  feishu: "飞书群机器人",
  dingtalk: "钉钉群机器人",
};

function isWebhookConfigured(config) {
  return Boolean(config.webhookUrl);
}

// 解析附加请求头；为空时返回 {}，格式不对时返回 null
function parseWebhookHeader(value) {
  const text = String(value || "").trim();
  if (!text) {
    return {};
  }
  const match = HEADER_PATTERN.exec(text);
  if (!match || RESERVED_HEADERS.has(match[1].toLowerCase())) {
    return null;
  }
  return { [match[1]]: match[2].trim() };
}

// 各格式的请求体
function webhookPayload(config, message) {
  const format = config.webhookFormat || "json";
  if (format === "wecom" || format === "dingtalk") {
    return { msgtype: "text", text: { content: plainText(message) } };
  }
  if (format === "feishu") {
    return { msg_type: "text", content: { text: plainText(message) } };
  }
  return {
    source: "WeReadAssistant",
    version: VERSION,
    event: message.event || "",
    account: config.accountName || "",
    title: message.title,
    subtitle: message.subtitle || "",
    text: message.body,
    level: message.level || "active",
    url: message.url || "",
    time: new Date().toISOString(),
  };
}

// 三个群机器人在出错时也返回 HTTP 200，要看响应体中的错误码
function checkResponse(format, body) {
  if (format === "json") {
    return "";
  }
  let data;
  try {
    data = JSON.parse(body);
  } catch (_) {
    return `响应不是 JSON：${truncate(body)}`;
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return `响应不是对象：${truncate(body)}`;
  }
  const code = format === "feishu" ? (data.code ?? data.StatusCode) : data.errcode;
  // 错误码有时是字符串 "0"
  if (code !== null && code !== "" && Number(code) === 0) {
    return "";
  }
  const detail = format === "feishu" ? data.msg || data.StatusMessage : data.errmsg;
  return `错误码 ${code === undefined ? "（无）" : code}${detail ? `：${truncate(detail)}` : ""}`;
}

// 发送一条 Webhook 消息，返回 { ok, error }。地址中通常带有密钥，日志与错误信息中都不出现
async function pushWebhook(config, message, { timeoutMs = CHANNEL_TIMEOUT_MS } = {}) {
  const format = config.webhookFormat || "json";
  const label = FORMAT_LABELS[format];
  if (!label) {
    return failure(`不支持的 Webhook 格式：${format}`);
  }
  if (!isHttpUrl(String(config.webhookUrl).trim())) {
    console.error("Webhook 地址无效（需以 http:// 或 https:// 开头）");
    return failure("Webhook 地址无效（需以 http:// 或 https:// 开头）");
  }
  const headers = parseWebhookHeader(config.webhookHeader);
  if (!headers) {
    console.error("Webhook 附加请求头格式不对，应为“名称: 值”");
    return failure("Webhook 附加请求头格式不对，应为“名称: 值”");
  }
  console.info(`发送 Webhook 推送（${label}）`);
  const result = await postJson(String(config.webhookUrl).trim(), webhookPayload(config, message), headers, timeoutMs);
  if (!result.ok) {
    const reason = httpFailure(config, result);
    console.error("Webhook 推送失败:", reason);
    return failure(reason);
  }
  // 先脱敏再截断，见 redact
  const problem = checkResponse(format, redact(config, result.body || ""));
  if (problem) {
    const reason = problem;
    console.error("Webhook 推送失败:", reason);
    return failure(reason);
  }
  console.info("Webhook 推送发送成功");
  return success();
}

const webhookChannel = {
  id: "webhook",
  label: "Webhook",
  toggle: "webhookEnabled",
  isConfigured: isWebhookConfigured,
  send: (config, message) => pushWebhook(config, message),
};

module.exports = {
  FORMAT_LABELS,
  RESERVED_HEADERS,
  checkResponse,
  isWebhookConfigured,
  parseWebhookHeader,
  pushWebhook,
  webhookChannel,
  webhookPayload,
};
