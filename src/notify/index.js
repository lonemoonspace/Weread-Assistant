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

const PANEL_ONLY_TEXT = "需要扫码登录，但未能从二维码中解析出登录链接，请在面板中扫码。";
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
    console.info("未启用任何推送通知渠道（在面板中配置 Bark Key 或 ntfy 主题后生效）");
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

// 绑定一次运行的配置。loginLinkIntervalMs：两次推送登录链接的最小间隔；
// panelLink：面板中该账号实时页面的地址（配置了 PANEL_PUBLIC_URL 时），附在扫码推送中
function createNotifier(config, { loginLinkIntervalMs = 0, panelLink = "" } = {}) {
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

  // 推送登录链接。解析不出登录链接（loginUrl 为空）时，有面板地址则推送面板链接，在面板中扫码
  async function loginLink(loginUrl, qrImagePath = "") {
    const key = loginUrl || panelLink;
    if (!key) {
      return;
    }
    if (key === lastLoginLink) {
      console.info("登录链接未变化，跳过重复推送");
      return;
    }
    const now = Date.now();
    if (lastLoginLinkAt && now - lastLoginLinkAt < loginLinkIntervalMs) {
      console.info(`距上次推送登录链接不足 ${Math.round(loginLinkIntervalMs / 60000)} 分钟，本次不推送`);
      return;
    }
    lastLoginLink = key;
    lastLoginLinkAt = now;

    const lines = [loginUrl ? `${LOGIN_LINK_TEXT}\n\n登录链接：${loginUrl}` : PANEL_ONLY_TEXT];
    const actions = [];
    if (loginUrl) {
      actions.push({ action: "view", label: "打开登录链接", url: loginUrl, clear: false });
    }
    if (panelLink) {
      lines.push(`在面板中扫码：${panelLink}`);
      actions.push({ action: "view", label: "在面板中扫码", url: panelLink, clear: false });
    }
    await event("loginRequired", lines.join("\n\n"), {
      url: key,
      actions,
      attachments: qrImagePath ? [qrImagePath] : [],
      html: buildLoginLinkEmailHtml(
        notificationTitle(config),
        loginUrl,
        qrImagePath ? path.basename(qrImagePath) : "",
        panelLink
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

// 向已配置的每个渠道发送一条测试通知，不受事件开关影响；返回 [{ channel, ok }]，没有配置任何渠道时为空数组
async function sendTestNotification(config) {
  const title = notificationTitle(config);
  const body = "这是一条测试通知，收到说明通知配置正确。";
  const tasks = [];
  if (isBarkEnabled(config)) {
    tasks.push(["bark", sendBark(config, title, body, { subtitle: "测试通知", level: "active", sound: "birdsong" })]);
  }
  if (isNtfyEnabled(config)) {
    tasks.push(["ntfy", sendNtfy(config, title, body, { subtitle: "测试通知", level: "active", sound: "birdsong" })]);
  }
  if (config.emailEnabled) {
    tasks.push([
      "email",
      canSendEmail(config) ? sendMail(config, `${title} · 测试通知`, body, [], { heading: title }) : Promise.resolve(false),
    ]);
  }
  const settled = await Promise.allSettled(tasks.map(([, task]) => task));
  return tasks.map(([channel], index) => ({
    channel,
    ok: settled[index].status === "fulfilled" && settled[index].value === true,
  }));
}

module.exports = {
  NOTIFY_EVENTS,
  createNotifier,
  sendTestNotification,
  getEnabledNotificationChannels,
  notify,
  sendBark,
  sendMail,
  sendNtfy,
};
