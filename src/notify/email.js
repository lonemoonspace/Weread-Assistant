const fs = require("fs");
const path = require("path");
const { CONFIG_SCHEMA } = require("../config/schema");
const { VERSION } = require("../shared/version");

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
            <p style="color: #7f8c8d; text-align: center; margin-top: 0;">${escapeHtml(new Date().toLocaleString())}</p>
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
function buildLoginLinkEmailHtml(heading, loginUrl, qrCid = "") {
  const safeUrl = escapeHtml(loginUrl);
  const qrImage = qrCid
    ? `<img src="cid:${escapeHtml(qrCid)}" alt="微信读书登录二维码" style="width: 240px; height: 240px; display: block; margin: 8px auto 12px auto;" />`
    : "";

  return wrapEmailHtml(
    heading,
    `
            <p>需要扫码登录微信读书。二维码约 1 分钟后失效，失效后会自动刷新。</p>
            <div style="background: #f9f9f9; border-left: 4px solid #2d8cf0; padding: 16px; text-align: center;">
                ${qrImage}
                <a href="${safeUrl}" target="_blank" rel="noopener noreferrer" style="display: inline-block; background: #2d8cf0; color: #fff; text-decoration: none; padding: 8px 14px; border-radius: 6px;">在微信中打开登录链接</a>
            </div>
    `
  );
}

function canSendEmail(config) {
  if (!config.emailEnabled) {
    return false;
  }
  const missed = REQUIRED_EMAIL_FIELDS.filter((key) => !config[key]).map((key) => FIELD_LABELS[key]);
  if (missed.length) {
    console.warn("邮件通知未发送：缺少配置", missed.join("、"));
    return false;
  }
  return true;
}

// options.heading：邮件正文标题；options.html：完整的自定义 HTML
async function sendMail(config, subject, text, filePaths = [], options = {}) {
  const nodemailer = require("nodemailer");

  // 根据端口自动判断是否使用SSL
  // 通常 465 使用 SSL，587 和 25 不使用
  const secure = config.emailPort === 465;

  let transporter = nodemailer.createTransport({
    host: config.emailSmtp,
    port: config.emailPort,
    secure: secure, // true for 465, false for other ports
    // SMTP 服务器无响应时不要一直等待（面板中发送测试通知时请求会被挂住）
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 30000,
    auth: {
      user: config.emailUser,
      pass: config.emailPass,
    },
  });

  const existingFilePaths = resolveEmailAttachments(filePaths);

  // Convert image paths to attachments array
  const attachments = existingFilePaths.map((filePath) => ({
    filename: path.basename(filePath),
    path: filePath,
    cid: path.basename(filePath), // Content ID for embedding in HTML
    contentType: `image/${path.extname(filePath).substring(1)}`, // Automatically detect image type
  }));

  // Use the sender address if provided, otherwise fall back to the SMTP user
  const fromAddress = config.emailFrom || config.emailUser;

  let mailOptions = {
    from: fromAddress,
    to: config.emailTo,
    subject: formatEmailSubject(subject),
    text: text,
    attachments: attachments,
    html: options.html || buildReportEmailHtml(options.heading || "WeReadAssistant", text, attachments),
  };

  try {
    let info = await transporter.sendMail(mailOptions);
    console.info("Email sent successfully");
    console.info("Message ID: ", info.messageId);
    return true;
  } catch (error) {
    console.error("Error sending email: ", error);
    return false;
  }
}

module.exports = {
  buildLoginLinkEmailHtml,
  canSendEmail,
  sendMail,
};
