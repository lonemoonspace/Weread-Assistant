const { isHttpUrl } = require("../../shared/http");
const { VERSION } = require("../../shared/version");
const { CHANNEL_TIMEOUT_MS, failure, plainText, redact, success, truncate } = require("./common");

const DEFAULT_API_BASE = "https://api.telegram.org";
// sendMessage 正文与 sendPhoto 说明文字的长度上限
const MAX_TEXT = 4096;
const MAX_CAPTION = 1024;

function isTelegramConfigured(config) {
  return Boolean(config.telegramBotToken && config.telegramChatId);
}

function apiBase(config) {
  // 留空（含只有空白）时用默认地址
  return (String(config.telegramApiBase || "").trim() || DEFAULT_API_BASE).replace(/\/+$/, "");
}

function limit(text, max) {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

// 消息中的按钮：Telegram 只接受 http(s) 地址
function inlineKeyboard(actions = []) {
  const buttons = actions
    .filter((action) => action && action.url && /^https?:\/\//i.test(action.url))
    .map((action) => [{ text: action.label, url: action.url }]);
  return buttons.length ? { inline_keyboard: buttons } : null;
}

// 调用 Bot API；令牌在请求路径中，返回的错误信息一律去掉令牌，日志中也不记录请求地址
async function callApi(config, method, body, timeoutMs) {
  if (timeoutMs <= 0) {
    return { ok: false, network: true, error: "超过发送时限，不再重试" };
  }
  const url = `${apiBase(config)}/bot${config.telegramBotToken}/${method}`;
  const isForm = body instanceof FormData;
  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "User-Agent": `WeReadAssistant/${VERSION}`, ...(isForm ? {} : { "Content-Type": "application/json" }) },
      body: isForm ? body : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    const reason = e.name === "TimeoutError" ? `请求超时（${Math.round(timeoutMs / 1000)} 秒）` : `请求出错：${e.cause?.message || e.message}`;
    return { ok: false, network: true, error: redact(config, reason) };
  }
  const text = await response.text().catch(() => "");
  let data = null;
  try {
    data = JSON.parse(text);
  } catch (_) {
    // 反向代理等返回的非 JSON 响应
  }
  if (response.ok && data && data.ok === true) {
    return { ok: true, error: "" };
  }
  // 先脱敏再截断，见 redact
  const detail = truncate(redact(config, data && data.description ? data.description : text));
  return { ok: false, network: false, error: `HTTP ${response.status}${detail ? `：${detail}` : ""}` };
}

async function sendText(config, text, keyboard, remaining) {
  const body = { chat_id: config.telegramChatId, text: limit(text, MAX_TEXT), disable_web_page_preview: true };
  if (keyboard) {
    body.reply_markup = keyboard;
  }
  let result = await callApi(config, "sendMessage", body, remaining());
  // 按钮地址不被接受（例如局域网地址）时去掉按钮再发一次，链接已在正文中
  if (!result.ok && !result.network && keyboard) {
    console.warn("Telegram 推送带按钮发送失败，去掉按钮重试:", result.error);
    delete body.reply_markup;
    result = await callApi(config, "sendMessage", body, remaining());
  }
  return result;
}

async function sendPhoto(config, text, keyboard, photo, remaining) {
  const form = new FormData();
  form.append("chat_id", config.telegramChatId);
  form.append("caption", limit(text, MAX_CAPTION));
  if (keyboard) {
    form.append("reply_markup", JSON.stringify(keyboard));
  }
  form.append("photo", new Blob([photo.content], { type: "image/png" }), photo.filename || "login-qr.png");
  return await callApi(config, "sendPhoto", form, remaining());
}

// 发送一条 Telegram 消息，返回 { ok, error }。带图片（扫码时的二维码）时用 sendPhoto，失败时改发纯文本
async function pushTelegram(config, message, { timeoutMs = CHANNEL_TIMEOUT_MS } = {}) {
  if (!isTelegramConfigured(config)) {
    return failure("没有填写 Telegram 机器人令牌或会话 ID");
  }
  if (!isHttpUrl(apiBase(config))) {
    console.error("Telegram 接口地址无效（需以 http:// 或 https:// 开头）");
    return failure("Telegram 接口地址无效（需以 http:// 或 https:// 开头）");
  }
  // 去掉按钮或改发文字的重试也在同一个时限内，时限已到就不再发
  const deadline = Date.now() + timeoutMs;
  const remaining = () => deadline - Date.now();
  const text = plainText(message);
  const keyboard = inlineKeyboard(message.actions);
  console.info(message.photo ? "发送 Telegram 推送（附二维码图片）" : "发送 Telegram 推送");
  let result;
  if (message.photo && message.photo.content) {
    result = await sendPhoto(config, text, keyboard, message.photo, remaining);
    if (!result.ok && !result.network) {
      console.warn("Telegram 发送图片失败，改发文字:", result.error);
      result = await sendText(config, text, keyboard, remaining);
    }
  } else {
    result = await sendText(config, text, keyboard, remaining);
  }
  if (result.ok) {
    console.info("Telegram 推送发送成功");
    return success();
  }
  console.error("Telegram 推送失败:", result.error);
  return failure(result.error);
}

const telegramChannel = {
  id: "telegram",
  label: "Telegram",
  toggle: "telegramEnabled",
  isConfigured: isTelegramConfigured,
  send: (config, message) => pushTelegram(config, message),
};

module.exports = {
  apiBase,
  inlineKeyboard,
  isTelegramConfigured,
  pushTelegram,
  telegramChannel,
};
