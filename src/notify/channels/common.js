const { CONFIG_SCHEMA } = require("../../config/schema");

// 推送渠道共用的部分。每个渠道是 channels/ 下的一个文件，导出相同的描述对象：
//   id、label：渠道标识与名称
//   toggle：按账号停用该渠道的开关（配置项，默认开）
//   isConfigured(config)：配置是否完整
//   send(config, message)：发送一条消息，返回 { ok, error }，error 为可以展示给用户的原因（不含密钥）
// message 为统一的消息对象：{ event, title, subtitle, body, level, sound, url, actions, photo }，
// photo 为可选的图片 { filename, content }（扫码时的二维码截图）

// 单个渠道一次发送的时限
const CHANNEL_TIMEOUT_MS = 10000;
const SECRET_MASK = "••••••";
const SECRET_KEYS = CONFIG_SCHEMA.filter((field) => field.secret).map((field) => field.key);

// 把配置中的密钥值（4 个字符以上）替换为掩码：错误信息与响应体中可能带有请求地址或密钥
function redact(config, text) {
  let result = String(text);
  const secrets = SECRET_KEYS.map((key) => config[key])
    .filter((value) => typeof value === "string" && value.length >= 4)
    .sort((a, b) => b.length - a.length);
  for (const secret of secrets) {
    result = result.split(secret).join(SECRET_MASK);
  }
  return result;
}

function truncate(text, max = 200) {
  const value = String(text || "").trim();
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

// postJson 的失败结果转换为原因
function httpFailure(config, result) {
  if (result.error) {
    return redact(config, `请求出错：${result.error}`);
  }
  const body = truncate(result.body);
  return redact(config, `HTTP ${result.status}${body ? `：${body}` : ""}`);
}

// 纯文本形式的消息：标题 · 副标题、正文；有点击地址且正文中没有时附在最后
function plainText(message) {
  const heading = message.subtitle ? `${message.title} · ${message.subtitle}` : message.title;
  const parts = [heading, message.body];
  if (message.url && !String(message.body).includes(message.url)) {
    parts.push(message.url);
  }
  return parts.filter(Boolean).join("\n\n");
}

function success() {
  return { ok: true, error: "" };
}

function failure(error) {
  return { ok: false, error };
}

module.exports = {
  CHANNEL_TIMEOUT_MS,
  SECRET_MASK,
  failure,
  httpFailure,
  plainText,
  redact,
  success,
  truncate,
};
