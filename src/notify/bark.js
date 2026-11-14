const { isHttpUrl, postJson } = require("../shared/http");

function isBarkEnabled(config) {
  return Boolean(config.barkKey);
}

async function sendBark(config, title, body, options = {}) {
  if (!config.barkKey) {
    console.info("Bark推送密钥未配置");
    return false;
  }
  if (!isHttpUrl(config.barkServer)) {
    console.error("Bark 服务器地址无效（需以 http:// 或 https:// 开头）:", config.barkServer);
    return false;
  }

  const {
    subtitle = "",
    sound = "alarm",
    group = "WeReadAssistant",
    icon = "",
    url = "",
    image = "",
    level = "active"
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

  const result = await postJson(barkUrl, payload);
  if (result.ok) {
    console.info("Bark推送发送成功");
    return true;
  }
  if (result.error) {
    console.error("Bark推送请求错误:", result.error);
  } else {
    console.error(`Bark推送失败: ${result.status} - ${result.body}`);
  }
  return false;
}

module.exports = {
  isBarkEnabled,
  sendBark,
};
