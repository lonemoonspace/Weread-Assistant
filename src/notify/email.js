const fs = require("fs");
const path = require("path");
const { VERSION } = require("../shared/version");

// 发送邮件所需的配置项，缺失时按环境变量名提示
const REQUIRED_EMAIL_FIELDS = [
  ["emailSmtp", "EMAIL_SMTP"],
  ["emailUser", "EMAIL_USER"],
  ["emailPass", "EMAIL_PASS"],
  ["emailTo", "EMAIL_TO"],
];

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

function buildReportEmailHtml(text, attachments = [], options = {}) {
  const safeText = escapeHtml(text);
  const versionText = escapeHtml(VERSION);
  const reportDate = escapeHtml(new Date().toLocaleDateString());
  const extraHtml = options.extraHtml || "";
  const imageGallery = attachments.length
    ? `
            <div class="image-gallery">
                ${attachments
                  .map(
                    (att) => `
                    <img src="cid:${att.cid}" alt="${escapeHtml(att.filename)}" style="display: block; margin: 10px auto; max-width: 100%;"/>
                `
                  )
                  .join("")}
            </div>
      `
    : "";

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
            <div style="text-align: center; margin-bottom: 20px;">
                <h2 style="color: #2c3e50;">WeRead Challenge Daily Report</h2>
                <p style="color: #7f8c8d; margin-bottom: 4px;">${reportDate}</p>
                <p style="color: #7f8c8d; margin-top: 0;">Version ${versionText}</p>
            </div>

            <div style="background: #f9f9f9; border-left: 4px solid #2980b9; padding: 15px; margin: 20px 0;">
                <p>Dear User,</p>
                <p>${safeText}</p>
                <p>Here are your reading statistics and achievements for today.</p>
            </div>

            ${extraHtml}

            ${imageGallery}

            <div style="margin: 20px 0;">
                <p>Best regards,</p>
                <p style="color: #2980b9;">WeRead Challenge Team</p>
            </div>

            <hr style="border: none; border-top: 1px solid #eee; margin: 20px 0;">

            <div style="font-size: 12px; color: #7f8c8d; text-align: center;">
                <p>This is an automated message, please do not reply.</p>
                <p>Version ${versionText}</p>
            </div>
        </div>
    </body>
    </html>
`;
}

function buildLoginLinkEmailHtml(loginUrl) {
  const safeUrl = escapeHtml(loginUrl);
  const qrImageUrl = `https://api.qrserver.com/v1/create-qr-code/?size=360x360&data=${encodeURIComponent(loginUrl)}`;
  const safeQrImageUrl = escapeHtml(qrImageUrl);
  const versionText = escapeHtml(VERSION);
  return `
  <!DOCTYPE html>
  <html>
  <head>
      <meta charset="utf-8">
      <style>
          body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
          .card { max-width: 680px; margin: 0 auto; padding: 20px; }
          .qr-box { background: #f9f9f9; border-left: 4px solid #2d8cf0; padding: 16px; text-align: center; }
          .qr-img { width: 280px; height: 280px; display: block; margin: 8px auto 12px auto; }
          .open-link { display: inline-block; background: #2d8cf0; color: #fff !important; text-decoration: none; padding: 8px 14px; border-radius: 6px; }
      </style>
  </head>
  <body>
      <div class="card">
          <h2 style="color: #2c3e50;">微信读书登录二维码</h2>
          <p style="color: #7f8c8d;">Version ${versionText}</p>
          <p>检测到新的扫码登录链接，请尽快在手机端完成登录。</p>
          <div class="qr-box">
            <img class="qr-img" src="${safeQrImageUrl}" alt="微信读书登录二维码" />
            <a class="open-link" href="${safeUrl}" target="_blank" rel="noopener noreferrer">点击打开登录链接</a>
          </div>
          <p style="font-size: 12px; color: #7f8c8d; margin-top: 16px;">
            该链接由 weread-challenge 自动发送。Version ${versionText}
          </p>
      </div>
  </body>
  </html>
`;
}

function canSendLoginLinkEmail(config) {
  if (!config.emailEnabled) {
    return false;
  }
  const missed = REQUIRED_EMAIL_FIELDS
    .filter(([key]) => !config[key])
    .map(([, envName]) => envName);
  if (missed.length) {
    console.warn("邮件推送登录链接失败：缺少配置", missed.join(", "));
    return false;
  }
  return true;
}

async function sendMail(config, subject, text, filePaths = [], options = {}) {
  const nodemailer = require("nodemailer");

  // 根据端口自动判断是否使用SSL
  // 通常 465 使用 SSL，587 和 25 不使用
  const secure = config.emailPort === 465;

  let transporter = nodemailer.createTransport({
    host: config.emailSmtp,
    port: config.emailPort,
    secure: secure, // true for 465, false for other ports
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

  const defaultHtml = buildReportEmailHtml(text, attachments, options);

  let mailOptions = {
    from: fromAddress,
    to: config.emailTo,
    subject: formatEmailSubject(subject),
    text: text,
    attachments: attachments,
    html: options.html || defaultHtml,
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
  canSendLoginLinkEmail,
  sendMail,
};
