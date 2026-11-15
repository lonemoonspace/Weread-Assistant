const { isHttpUrl, postJson } = require("../../shared/http");
const { CHANNEL_TIMEOUT_MS, failure, httpFailure, success } = require("./common");

function isBarkConfigured(config) {
  return Boolean(config.barkKey);
}

// 发送一条 Bark 推送，返回 { ok, error }
async function pushBark(config, title, body, options = {}) {
  if (!config.barkKey) {
    console.info("Bark推送密钥未配置");
    return failure("没有填写 Bark Key");
  }
  if (!isHttpUrl(config.barkServer)) {
    console.error("Bark 服务器地址无效（需以 http:// 或 https:// 开头）:", config.barkServer);
    return failure("Bark 服务器地址无效（需以 http:// 或 https:// 开头）");
  }

  const {
    subtitle = "",
    sound = "alarm",
    group = "WeReadAssistant",
    icon = "",
    url = "",
    image = "",
    level = "active",
    timeoutMs = CHANNEL_TIMEOUT_MS,
  } = options;

  // 使用 POST /push 并把 device_key 放进请求体：Key 不出现在请求路径中（不会进入代理与服务端的访问日志），
  // 服务器地址末尾带斜杠时也不会拼出 //
  const barkUrl = `${String(config.barkServer).trim().replace(/\/+$/, "")}/push`;
  const payload = { device_key: config.barkKey, title, body, sound, group, level };
  if (subtitle) payload.subtitle = subtitle;
  if (icon) payload.icon = icon;
  if (url) payload.url = url;
  if (image) payload.image = image;

  console.info("发送Bark推送:", barkUrl);

  const result = await postJson(barkUrl, payload, {}, timeoutMs);
  if (result.ok) {
    console.info("Bark推送发送成功");
    return success();
  }
  const reason = httpFailure(config, result);
  console.error("Bark推送失败:", reason);
  return failure(reason);
}

// 兼容旧的调用方式：返回是否发送成功
async function sendBark(config, title, body, options = {}) {
  return (await pushBark(config, title, body, options)).ok;
}

const barkChannel = {
  id: "bark",
  label: "Bark",
  toggle: "barkEnabled",
  isConfigured: isBarkConfigured,
  send: (config, message) =>
    pushBark(config, message.title, message.body, {
      subtitle: message.subtitle,
      level: message.level,
      sound: message.sound,
      url: message.url,
    }),
};

module.exports = {
  barkChannel,
  isBarkConfigured,
  pushBark,
  sendBark,
};
