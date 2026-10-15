const path = require("path");
const { isBarkEnabled, sendBark } = require("./bark");
const { isNtfyEnabled, sendNtfy } = require("./ntfy");
const { buildLoginLinkEmailHtml, canSendEmail, sendMail } = require("./email");

const BRAND = "WeReadAssistant";

// 每类事件对应的开关与推送样式；level / sound 由各渠道映射为自己的优先级与提示音
const NOTIFY_EVENTS = {
  start: { toggle: "notifyOnStart", subtitle: "开始运行", level: "passive", sound: "beginning" },
  loginRequired: { toggle: "notifyOnLoginRequired", subtitle: "需要扫码", level: "timeSensitive", sound: "birdsong" },
  loginSuccess: { toggle: "notifyOnLoginSuccess", subtitle: "登录成功", level: "active", sound: "birdsong" },
  done: { toggle: "notifyOnDone", subtitle: "阅读完成", level: "active", sound: "success" },
  failure: { toggle: "notifyOnFailure", subtitle: "运行失败", level: "critical", sound: "alarm" },
};

const LOGIN_LINK_TEXT = "请在微信中打开登录链接，或扫描二维码登录。二维码约 1 分钟后失效，失效后会自动刷新。";

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

function notificationTitle(config) {
  return config.accountName ? `${BRAND} · ${config.accountName}` : BRAND;
}

// 绑定一次运行的配置。loginLinkIntervalMs：两次推送登录链接的最小间隔
function createNotifier(config, { loginLinkIntervalMs = 0 } = {}) {
  let lastLoginLink = "";
  let lastLoginLinkAt = 0;
  const isEnabled = (name) => Boolean(config[NOTIFY_EVENTS[name].toggle]);

  // 按事件开关向推送渠道与邮件发送；attachments 为邮件附件路径，html 为自定义邮件正文
  async function event(name, body, { url = "", actions = [], attachments = [], html = "" } = {}) {
    const spec = NOTIFY_EVENTS[name];
    if (!isEnabled(name)) {
      console.info(`通知事件「${spec.subtitle}」未开启，跳过推送`);
      return;
    }

    const title = notificationTitle(config);
    const tasks = [
      notify(config, title, body, {
        subtitle: spec.subtitle,
        level: spec.level,
        sound: spec.sound,
        url,
        actions,
      }),
    ];
    if (canSendEmail(config)) {
      tasks.push(
        sendMail(config, `${title} · ${spec.subtitle}`, body, attachments, { heading: title, html })
      );
    }
    await Promise.allSettled(tasks);
  }

  async function loginLink(loginUrl, qrImagePath = "") {
    if (!loginUrl) {
      return;
    }
    if (loginUrl === lastLoginLink) {
      console.info("登录链接未变化，跳过重复推送");
      return;
    }
    const now = Date.now();
    if (lastLoginLinkAt && now - lastLoginLinkAt < loginLinkIntervalMs) {
      console.info(`距上次推送登录链接不足 ${Math.round(loginLinkIntervalMs / 60000)} 分钟，本次不推送`);
      return;
    }
    lastLoginLink = loginUrl;
    lastLoginLinkAt = now;

    await event("loginRequired", `${LOGIN_LINK_TEXT}\n\n登录链接：${loginUrl}`, {
      url: loginUrl,
      actions: [{ action: "view", label: "打开登录链接", url: loginUrl, clear: false }],
      attachments: qrImagePath ? [qrImagePath] : [],
      html: buildLoginLinkEmailHtml(
        notificationTitle(config),
        loginUrl,
        qrImagePath ? path.basename(qrImagePath) : ""
      ),
    });
  }

  return {
    event,
    loginLink,
    // 该事件是否会发送邮件，用于决定是否需要先截图作为附件
    willEmail: (name) => isEnabled(name) && config.emailEnabled,
  };
}

module.exports = {
  NOTIFY_EVENTS,
  createNotifier,
  getEnabledNotificationChannels,
  notify,
  sendBark,
  sendMail,
  sendNtfy,
};
