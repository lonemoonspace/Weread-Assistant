const { isBarkEnabled, sendBark } = require("./bark");
const { isNtfyEnabled, sendNtfy } = require("./ntfy");
const { buildLoginLinkEmailHtml, canSendLoginLinkEmail, sendMail } = require("./email");

function getEnabledNotificationChannels(config) {
  const channels = [];
  if (isBarkEnabled(config)) {
    channels.push("bark");
  }
  if (isNtfyEnabled(config)) {
    channels.push("ntfy");
  }
  return channels;
}

// 统一推送入口：向所有已启用的渠道并行发送，任一渠道失败不影响其他渠道
async function notify(config, title, body, options = {}) {
  const channels = getEnabledNotificationChannels(config);
  if (!channels.length) {
    console.info("未启用任何推送通知渠道（配置 BARK_KEY 或 NTFY_TOPIC 后生效）");
    return [];
  }

  const senders = channels.map((channel) => (channel === "ntfy" ? sendNtfy : sendBark));
  const settled = await Promise.allSettled(senders.map((send) => send(config, title, body, options)));

  const results = channels.map((channel, index) => ({
    channel,
    ok: settled[index].status === "fulfilled" && settled[index].value === true,
  }));
  console.info(
    "推送通知渠道结果:",
    results.map((item) => `${item.channel}=${item.ok ? "ok" : "failed"}`).join(", ")
  );
  return results;
}

async function notifyLoginLink(config, loginUrl) {
  const tasks = [];
  const qrImageUrl = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(loginUrl)}`;

  if (isBarkEnabled(config)) {
    tasks.push(
      sendBark(config, "微信读书挑战", "请扫码登录微信读书", {
        subtitle: "扫码登录",
        url: loginUrl,
        image: qrImageUrl,
        level: "active",
        sound: "birdsong",
      })
    );
  }

  if (isNtfyEnabled(config)) {
    tasks.push(
      sendNtfy(
        config,
        "微信读书挑战",
        `请扫码登录微信读书。\n\n登录链接：${loginUrl}\n二维码：${qrImageUrl}`,
        {
          subtitle: "扫码登录",
          url: loginUrl,
          image: qrImageUrl,
          level: "active",
          sound: "birdsong",
          markdown: true,
          actions: [
            { action: "view", label: "打开登录链接", url: loginUrl, clear: false },
            { action: "view", label: "查看二维码", url: qrImageUrl, clear: false },
          ],
        }
      )
    );
  }

  if (canSendLoginLinkEmail(config)) {
    tasks.push(
      sendMail(
        config,
        "[项目进展--登录链接]",
        "检测到新的微信读书登录二维码，请在邮件中扫码登录。",
        [],
        { html: buildLoginLinkEmailHtml(loginUrl) }
      )
    );
  }

  if (!tasks.length) {
    console.info("未启用登录链接推送（需要 BARK_KEY、NTFY_TOPIC 或 ENABLE_EMAIL=true）");
    return;
  }

  await Promise.allSettled(tasks);
}

// 绑定一次运行的配置；登录链接只在变化时推送
function createNotifier(config) {
  let lastPushedLoginLink = "";

  return {
    emailEnabled: config.emailEnabled,
    notify: (title, body, options) => notify(config, title, body, options),
    sendMail: (subject, text, filePaths, options) => sendMail(config, subject, text, filePaths, options),
    async loginLink(loginUrl) {
      if (!loginUrl) {
        return;
      }
      if (loginUrl === lastPushedLoginLink) {
        console.info("登录链接未变化，跳过重复推送");
        return;
      }
      lastPushedLoginLink = loginUrl;
      await notifyLoginLink(config, loginUrl);
    },
  };
}

module.exports = {
  createNotifier,
  getEnabledNotificationChannels,
  notify,
  sendBark,
  sendMail,
  sendNtfy,
};
