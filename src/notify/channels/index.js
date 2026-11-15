const { barkChannel } = require("./bark");
const { ntfyChannel } = require("./ntfy");
const { telegramChannel } = require("./telegram");
const { webhookChannel } = require("./webhook");

// 推送渠道列表，按这个顺序发送与展示。邮件有附件与自定义 HTML，走 email.js 单独的路径
const CHANNELS = [barkChannel, ntfyChannel, webhookChannel, telegramChannel];

// 渠道实际发送的条件：账号上没有关闭（开关默认开），并且配置完整
function isChannelActive(config, channel) {
  return config[channel.toggle] !== false && channel.isConfigured(config);
}

function activeChannels(config) {
  return CHANNELS.filter((channel) => isChannelActive(config, channel));
}

module.exports = {
  CHANNELS,
  activeChannels,
  isChannelActive,
};
