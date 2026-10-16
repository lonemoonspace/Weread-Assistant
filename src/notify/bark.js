const { postJson } = require("../shared/http");

function isBarkEnabled(config) {
  return Boolean(config.barkKey);
}

async function sendBark(config, title, body, options = {}) {
  if (!config.barkKey) {
    console.info("Bark推送密钥未配置");
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

  const barkUrl = `${config.barkServer}/${config.barkKey}`;
  const payload = { title, body, sound, group, level };
  if (subtitle) payload.subtitle = subtitle;
  if (icon) payload.icon = icon;
  if (url) payload.url = url;
  if (image) payload.image = image;

  // 推送地址中含有 Bark Key，日志中只记录服务器地址
  console.info("发送Bark推送:", config.barkServer);

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
