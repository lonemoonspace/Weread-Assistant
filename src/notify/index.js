const fs = require("fs");
const path = require("path");
const { CHANNELS, activeChannels, isChannelActive } = require("./channels");
const { sendBark } = require("./channels/bark");
const { sendNtfy } = require("./channels/ntfy");
const { telegramChannel } = require("./channels/telegram");
const { buildLoginLinkEmailHtml, canSendEmail, deliverMail, missingEmailFields, sendMail } = require("./email");

const BRAND = "WeReadAssistant";
// 运行结束时等待后台通知发送完成的最长时间
const FLUSH_TIMEOUT_MS = 10000;

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

// 实际会发送的推送渠道（不含邮件）
function getEnabledNotificationChannels(config) {
  return activeChannels(config).map((channel) => channel.id);
}

// 统一的消息对象，见 channels/common.js
function buildMessage(title, body, options = {}) {
  const { event = "", subtitle = "", level = "active", sound = "", url = "", actions = [], photo = null } = options;
  return { event, title, subtitle, body, level, sound, url, actions, photo };
}

// 向一组渠道并行发送；渠道实现抛出异常时同样记为失败。返回 [{ channel, ok, error }]
async function sendToChannels(config, channels, message) {
  const settled = await Promise.allSettled(channels.map((channel) => channel.send(config, message)));
  return channels.map((channel, index) => {
    const outcome = settled[index];
    if (outcome.status === "fulfilled" && outcome.value && outcome.value.ok) {
      return { channel: channel.id, ok: true, error: "" };
    }
    const error = outcome.status === "rejected" ? `发送出错：${outcome.reason?.message || outcome.reason}` : outcome.value?.error;
    return { channel: channel.id, ok: false, error: error || "发送失败" };
  });
}

// 统一推送入口：向所有已启用的渠道并行发送，任一渠道失败不影响其他渠道。
// options：event、subtitle、level、sound、url、actions、photo（见 buildMessage）
async function notify(config, title, body, options = {}) {
  const channels = activeChannels(config);
  if (!channels.length) {
    console.info("未启用任何推送通知渠道（在面板中配置 Bark、ntfy、Webhook 或 Telegram 后生效）");
    return [];
  }
  const results = await sendToChannels(config, channels, buildMessage(title, body, options));
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
// 通知在后台发送，不阻塞阅读流程：event / loginLink 立即返回一个 Promise（不会 reject），
// 运行结束前调用 flush(timeoutMs) 等待仍在发送的通知（包括等待期间新加入的），最多等待 timeoutMs
function createNotifier(config, { loginLinkIntervalMs = 0, panelLink = "" } = {}) {
  let lastLoginLink = "";
  let lastLoginLinkAt = 0;
  const pending = new Set();
  const isEnabled = (name) => Boolean(config[NOTIFY_EVENTS[name].toggle]);

  function track(promise) {
    const tracked = promise.then(
      () => {},
      (e) => console.warn("发送通知出错:", e?.message || e)
    );
    pending.add(tracked);
    tracked.finally(() => pending.delete(tracked));
    return tracked;
  }

  async function flush(timeoutMs = FLUSH_TIMEOUT_MS) {
    if (!pending.size) {
      return true;
    }
    let timer;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
    });
    // 等待期间新加入的通知也一并等待，直到全部发送完成或超时
    const drain = async () => {
      while (pending.size) {
        await Promise.all([...pending]);
      }
      return true;
    };
    const done = await Promise.race([drain(), timeout]);
    clearTimeout(timer);
    if (!done) {
      console.warn(`仍有通知在 ${Math.round(timeoutMs / 1000)} 秒内未发送完成，不再等待`);
    }
    return done;
  }

  // 按事件开关向推送渠道与邮件发送；attachments 为邮件附件（见 email.js 的 toMailAttachments），html 为自定义邮件正文
  function event(name, body, options = {}) {
    return track(sendEvent(name, body, options));
  }

  async function sendEvent(name, body, { url = "", actions = [], attachments = [], html = "", photo = null } = {}) {
    const spec = NOTIFY_EVENTS[name];
    if (!isEnabled(name)) {
      console.info(`通知事件「${spec.subtitle}」未开启，跳过推送`);
      return;
    }

    const title = notificationTitle(config);
    const tasks = [
      notify(config, title, body, {
        event: name,
        subtitle: spec.subtitle,
        level: spec.level,
        sound: spec.sound,
        url,
        actions,
        photo,
      }),
    ];
    if (canSendEmail(config)) {
      tasks.push(
        sendMail(config, `${title} · ${spec.subtitle}`, body, attachments, { heading: title, html })
      );
    }
    await Promise.allSettled(tasks);
  }

  // 推送登录链接。解析不出登录链接（loginUrl 为空）时，有面板地址则推送面板链接，在面板中扫码。
  // 二维码图片在调用时读入内存：后台发送期间二维码刷新或被删除不影响这封邮件
  function loginLink(loginUrl, qrImagePath = "") {
    const key = loginUrl || panelLink;
    if (!key) {
      return Promise.resolve();
    }
    if (key === lastLoginLink) {
      console.info("登录链接未变化，跳过重复推送");
      return Promise.resolve();
    }
    const now = Date.now();
    if (lastLoginLinkAt && now - lastLoginLinkAt < loginLinkIntervalMs) {
      console.info(`距上次推送登录链接不足 ${Math.round(loginLinkIntervalMs / 60000)} 分钟，本次不推送`);
      return Promise.resolve();
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
    // 邮件附件与 Telegram 的图片都用这张二维码截图
    let qrAttachment = null;
    if (qrImagePath && (willEmail("loginRequired") || (isEnabled("loginRequired") && isChannelActive(config, telegramChannel)))) {
      try {
        qrAttachment = { filename: path.basename(qrImagePath), content: fs.readFileSync(qrImagePath) };
      } catch (e) {
        console.warn("读取登录二维码图片失败，邮件中不附二维码:", e.message);
      }
    }
    return event("loginRequired", lines.join("\n\n"), {
      url: key,
      actions,
      attachments: qrAttachment ? [qrAttachment] : [],
      photo: qrAttachment,
      html: buildLoginLinkEmailHtml(notificationTitle(config), loginUrl, qrAttachment ? qrAttachment.filename : "", panelLink),
    });
  }

  // 该事件是否会发送邮件，用于决定是否需要先截图作为附件；邮件配置不完整时为 false（不在这里记录日志）
  function willEmail(name) {
    return isEnabled(name) && canSendEmail(config, { quiet: true });
  }

  return {
    event,
    flush,
    loginLink,
    pendingCount: () => pending.size,
    willEmail,
  };
}

// 向已配置的每个渠道发送一条测试通知，不受事件开关影响；返回 [{ channel, ok, error, disabled? }]，没有配置任何渠道时为空数组。
// 已配置但在账号上关闭的渠道不发送，记为 { ok: false, disabled: true }
async function sendTestNotification(config) {
  const title = notificationTitle(config);
  const body = "这是一条测试通知，收到说明通知配置正确。";
  const message = buildMessage(title, body, { event: "test", subtitle: "测试通知", level: "active", sound: "birdsong" });
  const configured = CHANNELS.filter((channel) => channel.isConfigured(config));
  const active = configured.filter((channel) => isChannelActive(config, channel));
  const tasks = [sendToChannels(config, active, message)];
  if (config.emailEnabled) {
    const missing = missingEmailFields(config);
    tasks.push(
      missing.length
        ? Promise.resolve({ ok: false, error: `缺少配置：${missing.join("、")}` })
        : deliverMail(config, `${title} · 测试通知`, body, [], { heading: title })
    );
  }
  const [channelResults, mail] = await Promise.all(tasks);
  const byId = new Map(channelResults.map((item) => [item.channel, item]));
  const results = configured.map(
    (channel) => byId.get(channel.id) || { channel: channel.id, ok: false, error: "已在配置中关闭，未发送", disabled: true }
  );
  if (mail) {
    results.push({ channel: "email", ok: mail.ok, error: mail.ok ? "" : mail.error || "发送失败" });
  }
  return results;
}

module.exports = {
  CHANNELS,
  FLUSH_TIMEOUT_MS,
  NOTIFY_EVENTS,
  createNotifier,
  sendTestNotification,
  getEnabledNotificationChannels,
  notify,
  sendBark,
  sendMail,
  sendNtfy,
};
