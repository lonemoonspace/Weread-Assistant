const fs = require("fs");
const path = require("path");
const { CONFIG_SCHEMA } = require("../config/schema");
const { VERSION } = require("../shared/version");
const { redact } = require("./channels/common");

// 发送邮件所需的配置项，缺失时按配置项名称提示
const REQUIRED_EMAIL_FIELDS = ["emailSmtp", "emailUser", "emailPass", "emailTo"];
const FIELD_LABELS = Object.fromEntries(CONFIG_SCHEMA.map((field) => [field.key, field.label]));

function escapeHtml(str = "") {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatEmailSubject(subject) {
  const versionLabel = `[v${VERSION}]`;
  return String(subject).includes(versionLabel)
    ? String(subject)
    : `${subject} ${versionLabel}`;
}

function resolveEmailAttachments(filePaths = []) {
  return filePaths
    .filter(Boolean)
    .filter((filePath) => {
      if (fs.existsSync(filePath)) {
        return true;
      }
      console.warn("邮件附件不存在，已跳过:", filePath);
      return false;
    });
}

// 邮件中的时间固定用中文格式；时区取进程的 TZ（容器中默认 Asia/Shanghai），并注明与 UTC 的偏移：
// 面板按设置中的时区显示，容器的 TZ 与之不同时也能对上
function formatEmailTime(date = new Date()) {
  const offset = new Intl.DateTimeFormat("en-US", { timeZoneName: "longOffset" })
    .formatToParts(date)
    .find((part) => part.type === "timeZoneName")?.value;
  const zone = !offset || offset === "GMT" ? "UTC" : offset.replace("GMT", "UTC");
  return `${date.toLocaleString("zh-CN", { hour12: false })}（${zone}）`;
}

// 附件的 MIME 类型：只为认识的图片扩展名填写，其余交给 nodemailer 按文件名推断
const IMAGE_TYPES = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };
function imageContentType(filename) {
  return IMAGE_TYPES[path.extname(filename).toLowerCase()];
}

function wrapEmailHtml(heading, innerHtml) {
  const versionText = escapeHtml(VERSION);
  return `
    <!DOCTYPE html>
    <html>
    <head>
        <meta charset="utf-8">
        <style>
            body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
        </style>
    </head>
    <body>
        <div style="max-width: 600px; margin: 0 auto; padding: 20px;">
            <h2 style="color: #2c3e50; text-align: center;">${escapeHtml(heading)}</h2>
            <p style="color: #7f8c8d; text-align: center; margin-top: 0;">${escapeHtml(formatEmailTime())}</p>
            ${innerHtml}
            <hr style="border: none; border-top: 1px solid #eee; margin: 20px 0;">
            <p style="font-size: 12px; color: #7f8c8d; text-align: center;">
                此邮件由 WeReadAssistant 自动发送，请勿回复。Version ${versionText}
            </p>
        </div>
    </body>
    </html>
`;
}

function buildReportEmailHtml(heading, text, attachments = []) {
  const images = attachments
    .map(
      (att) =>
        `<img src="cid:${att.cid}" alt="${escapeHtml(att.filename)}" style="display: block; margin: 10px auto; max-width: 100%;"/>`
    )
    .join("");

  return wrapEmailHtml(
    heading,
    `
            <div style="background: #f9f9f9; border-left: 4px solid #2980b9; padding: 15px; margin: 20px 0; white-space: pre-line;">${escapeHtml(text)}</div>
            ${images}
    `
  );
}

// 登录链接邮件：二维码图片作为附件内嵌（qrCid 为附件文件名），不经过第三方服务生成
// loginUrl 为空（二维码解析不出登录链接）时只放二维码截图；panelLink 为面板中该账号的实时页面
function buildLoginLinkEmailHtml(heading, loginUrl, qrCid = "", panelLink = "") {
  const button = (url, text) =>
    `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer" style="display: inline-block; background: #2d8cf0; color: #fff; text-decoration: none; padding: 8px 14px; border-radius: 6px; margin: 4px;">${text}</a>`;
  const qrImage = qrCid
    ? `<img src="cid:${escapeHtml(qrCid)}" alt="微信读书登录二维码" style="width: 240px; height: 240px; display: block; margin: 8px auto 12px auto;" />`
    : "";

  return wrapEmailHtml(
    heading,
    `
            <p>需要扫码登录微信读书。二维码约 1 分钟后失效，失效后会自动刷新。</p>
            <div style="background: #f9f9f9; border-left: 4px solid #2d8cf0; padding: 16px; text-align: center;">
                ${qrImage}
                ${loginUrl ? button(loginUrl, "在微信中打开登录链接") : ""}
                ${panelLink ? button(panelLink, "在面板中扫码") : ""}
            </div>
    `
  );
}

// quiet：只判断、不记录日志（用于事先判断是否需要准备邮件附件）
function canSendEmail(config, { quiet = false } = {}) {
  if (!config.emailEnabled) {
    return false;
  }
  const missed = missingEmailFields(config);
  if (missed.length) {
    if (!quiet) {
      console.warn("邮件通知未发送：缺少配置", missed.join("、"));
    }
    return false;
  }
  return true;
}

// 465 端口直接使用 SSL；其他端口要求 STARTTLS，服务器不支持时发送失败，
// 除非开启了“允许不加密的 SMTP 连接”（emailAllowInsecure）
function smtpTransportOptions(config) {
  const secure = config.emailPort === 465;
  return {
    host: config.emailSmtp,
    port: config.emailPort,
    secure,
    requireTLS: !secure && !config.emailAllowInsecure,
    // SMTP 服务器无响应时不要一直等待（面板中发送测试通知时请求会被挂住）
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 30000,
    auth: {
      user: config.emailUser,
      pass: config.emailPass,
    },
  };
}

// 附件可以是文件路径，也可以是 { filename, content }（内存中的图片，例如截图）。
// 内存中的附件在发送时不依赖磁盘上的文件，异步发送期间文件被刷新或删除也不受影响
function toMailAttachments(items = []) {
  return items.filter(Boolean).flatMap((item) => {
    if (typeof item === "string") {
      return resolveEmailAttachments([item]).map((filePath) => {
        const filename = path.basename(filePath);
        return withContentType({ filename, path: filePath, cid: filename });
      });
    }
    const filename = item.filename;
    return [withContentType({ filename, content: item.content, cid: filename })];
  });
}

function withContentType(attachment) {
  const contentType = imageContentType(attachment.filename);
  return contentType ? { ...attachment, contentType } : attachment;
}

// 缺少的必填项名称，用于测试通知中说明原因
function missingEmailFields(config) {
  return REQUIRED_EMAIL_FIELDS.filter((key) => !config[key]).map((key) => FIELD_LABELS[key]);
}

// 发送邮件，返回 { ok, error }。filePaths：附件（见 toMailAttachments）；options.heading：邮件正文标题；options.html：完整的自定义 HTML
async function deliverMail(config, subject, text, filePaths = [], options = {}) {
  // 构造连接与邮件内容出错（例如 SMTP 参数无效、附件无法读取）也返回失败原因，不抛出
  try {
    const nodemailer = require("nodemailer");
    const transporter = nodemailer.createTransport(smtpTransportOptions(config));
    const attachments = toMailAttachments(filePaths);
    const mailOptions = {
      // 没有填写发件人时用 SMTP 用户名
      from: config.emailFrom || config.emailUser,
      to: config.emailTo,
      subject: formatEmailSubject(subject),
      text: text,
      attachments: attachments,
      html: options.html || buildReportEmailHtml(options.heading || "WeReadAssistant", text, attachments),
    };
    let info = await transporter.sendMail(mailOptions);
    console.info("Email sent successfully");
    console.info("Message ID: ", info.messageId);
    return { ok: true, error: "" };
  } catch (error) {
    console.error("Error sending email: ", error);
    return { ok: false, error: redact(config, error.message || String(error)) };
  }
}

// 兼容旧的调用方式：返回是否发送成功
async function sendMail(config, subject, text, filePaths = [], options = {}) {
  return (await deliverMail(config, subject, text, filePaths, options)).ok;
}

module.exports = {
  buildLoginLinkEmailHtml,
  canSendEmail,
  deliverMail,
  formatEmailTime,
  missingEmailFields,
  sendMail,
  smtpTransportOptions,
  toMailAttachments,
};
