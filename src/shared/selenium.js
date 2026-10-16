const { fetchJson } = require("./http");

// 查询 Selenium 状态：先 /status，兼容旧版的 /wd/hub/status
const STATUS_ENDPOINTS = ["/status", "/wd/hub/status"];
const STATUS_TIMEOUT_MS = 3000;
const MAX_MESSAGE_LENGTH = 200;
const STATE_LABELS = { ready: "就绪", busy: "会话已满", "not-ready": "未就绪", unreachable: "无法连接" };
// 这些错误说明连不上主机：查询状态时不再尝试下一个端点，连接浏览器失败时换成说明地址与原因的错误
const CONNECTION_ERRORS = {
  ECONNREFUSED: "连接被拒绝",
  ENOTFOUND: "找不到主机",
  EAI_AGAIN: "找不到主机",
  EHOSTUNREACH: "主机不可达",
  ENETUNREACH: "网络不可达",
  ECONNRESET: "连接被重置",
  ETIMEDOUT: "连接超时",
};

// 没有协议时按 http 处理，协议改为小写，去掉末尾的斜杠
function normalizeSeleniumUrl(url) {
  const value = String(url || "").trim();
  const withProtocol = /^https?:\/\//i.test(value) ? value.replace(/^https?:/i, (scheme) => scheme.toLowerCase()) : `http://${value}`;
  return withProtocol.replace(/\/+$/, "");
}

// 展示用的地址：去掉其中的用户名与密码
function displaySeleniumUrl(url) {
  try {
    const parsed = new URL(url);
    parsed.username = "";
    parsed.password = "";
    return parsed.toString().replace(/\/+$/, "");
  } catch (_) {
    return String(url).replace(/\/\/[^/@]*@/, "//");
  }
}

/**
 * 解析 /status 的响应。Selenium Grid（含 standalone 镜像）返回 nodes 与其中的会话槽位，
 * 由此得到已用/总会话数；chromedriver 等只返回 ready，会话数为 null。
 * Grid 在会话全部占用时 ready 为 false，此时状态为 busy 而不是 not-ready
 */
function parseSeleniumStatus(body) {
  const value = body && typeof body === "object" && body.value && typeof body.value === "object" ? body.value : body;
  if (!value || typeof value !== "object" || typeof value.ready !== "boolean") {
    return null;
  }
  let sessions = null;
  if (Array.isArray(value.nodes)) {
    sessions = { used: 0, total: 0 };
    for (const node of value.nodes) {
      const slots = node && Array.isArray(node.slots) ? node.slots : [];
      sessions.used += slots.filter((slot) => slot && slot.session).length;
      if (node && node.availability === "UP") {
        // 节点有多种浏览器时槽位数 = 浏览器种类 × maxSessions，同时运行的会话数仍以 maxSessions 为上限
        sessions.total += Number.isInteger(node.maxSessions) ? Math.min(node.maxSessions, slots.length) : slots.length;
      }
    }
  }
  let state = value.ready ? "ready" : "not-ready";
  if (!value.ready && sessions && sessions.total > 0 && sessions.used >= sessions.total) {
    state = "busy";
  }
  return {
    state,
    ready: value.ready,
    message: typeof value.message === "string" ? value.message.slice(0, MAX_MESSAGE_LENGTH) : "",
    sessions,
    nodes: Array.isArray(value.nodes) ? value.nodes.length : null,
  };
}

function describeError(error, timeoutMs) {
  if (CONNECTION_ERRORS[error.code]) {
    return `${CONNECTION_ERRORS[error.code]}（${error.code}）`;
  }
  if (/timeout/i.test(error.message)) {
    return `${timeoutMs / 1000} 秒内没有响应`;
  }
  return error.message || String(error);
}

// 查询一个 Selenium 地址的状态，不会抛出异常：连不上时 state 为 unreachable 并附带原因
async function checkSelenium(url, { timeoutMs = STATUS_TIMEOUT_MS } = {}) {
  const base = normalizeSeleniumUrl(url);
  let error = "";
  for (const endpoint of STATUS_ENDPOINTS) {
    let response;
    try {
      response = await fetchJson(`${base}${endpoint}`, timeoutMs);
    } catch (e) {
      error = describeError(e, timeoutMs);
      if (CONNECTION_ERRORS[e.code] || /timeout/i.test(e.message)) {
        break;
      }
      continue;
    }
    const status = parseSeleniumStatus(response.body);
    if (status) {
      return { ...status, error: "" };
    }
    error =
      response.statusCode >= 200 && response.statusCode < 300
        ? `${endpoint} 返回的不是 Selenium 状态`
        : `${endpoint} 返回 HTTP ${response.statusCode}`;
  }
  return { state: "unreachable", ready: false, message: "", sessions: null, nodes: null, error };
}

// 一行状态摘要，写入运行日志
function describeSeleniumStatus(status) {
  if (status.state === "unreachable") {
    return `${STATE_LABELS.unreachable}，${status.error}`;
  }
  const sessions = status.sessions ? `，已用 ${status.sessions.used}/${status.sessions.total} 个会话` : "";
  return `${STATE_LABELS[status.state]}${sessions}${status.message ? `：${status.message}` : ""}`;
}

// 同一地址同时只发一个查询：多个页面同时刷新时共用结果
function createSeleniumChecker(options = {}) {
  const pending = new Map();
  return (url) => {
    const key = normalizeSeleniumUrl(url);
    if (!pending.has(key)) {
      pending.set(key, checkSelenium(key, options).finally(() => pending.delete(key)));
    }
    return pending.get(key);
  };
}

module.exports = {
  CONNECTION_ERRORS,
  checkSelenium,
  createSeleniumChecker,
  describeSeleniumStatus,
  displaySeleniumUrl,
  normalizeSeleniumUrl,
};
