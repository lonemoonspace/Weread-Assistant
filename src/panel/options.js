const net = require("net");
const { parseBooleanValue, parseIntegerValue } = require("../config/resolve");

const DEFAULT_PANEL_PORT = 26868;

// 规范为以 / 开头和结尾的路径，例如 "weread" -> "/weread/"
function normalizeBasePath(raw) {
  const value = String(raw || "/").trim();
  const trimmed = value.replace(/^\/+|\/+$/g, "").replace(/\/{2,}/g, "/");
  if (trimmed && !/^[A-Za-z0-9._~\-/]+$/.test(trimmed)) {
    throw new Error(`PANEL_BASE_PATH 含有不支持的字符: ${value}`);
  }
  return trimmed ? `/${trimmed}/` : "/";
}

// 面板的外网地址，用于推送中的跳转链接：http(s) 地址，末尾补齐斜杠；不设置时为空
function normalizePublicUrl(raw) {
  const value = String(raw || "").trim();
  if (!value) {
    return "";
  }
  let url;
  try {
    url = new URL(value);
  } catch (_) {
    throw new Error(`PANEL_PUBLIC_URL 不是有效的地址: ${value}`);
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new Error(`PANEL_PUBLIC_URL 应为不含用户名与密码的 http(s) 地址: ${value}`);
  }
  url.hash = "";
  url.search = "";
  return url.toString().replace(/\/*$/, "/");
}

// passkey（WebAuthn）的 RP ID 与 origin，只由 PANEL_PUBLIC_URL 推导：反向代理后面的面板看到的是内部地址，
// Host 请求头又可以伪造，不能从请求推断。RP ID 只是域名，与 PANEL_BASE_PATH、端口无关。
// 浏览器只在 HTTPS 页面（或 http://localhost）中提供 passkey，RP ID 也不能是 IP 地址；不满足时返回 null，面板不提供 passkey。
// 域名末尾的点（example.com.）去掉：带点的地址在浏览器中是另一个 origin，passkey 按不带点的地址提供
function passkeyRelyingParty(publicUrl) {
  if (!publicUrl) {
    return null;
  }
  const url = new URL(publicUrl);
  const host = url.hostname.replace(/\.$/, "");
  if (!host || net.isIP(host.replace(/^\[|\]$/g, "")) || (url.protocol !== "https:" && host !== "localhost")) {
    return null;
  }
  return { id: host, origin: `${url.protocol}//${host}${url.port ? `:${url.port}` : ""}` };
}

// false：不信任代理头；数字：信任的代理层数。"true" 视为 1 层
function parseTrustProxy(raw) {
  const value = String(raw === undefined ? "" : raw).trim();
  if (/^\d+$/.test(value)) {
    const hops = Number(value);
    return hops > 0 ? hops : false;
  }
  try {
    return parseBooleanValue(value, false, true) ? 1 : false;
  } catch (_) {
    throw new Error(`PANEL_TRUST_PROXY 只能是 true、false 或代理层数：${raw}`);
  }
}

// 应急恢复：在设置中关闭了密码登录、又用不了 passkey 时，设置为 true 后重启面板，临时允许用密码登录（不修改设置）
function parseForcePasswordLogin(raw) {
  try {
    return parseBooleanValue(raw, false, true);
  } catch (_) {
    throw new Error(`PANEL_FORCE_PASSWORD_LOGIN 只能是 true 或 false：${raw}`);
  }
}

// 端口只从 PANEL_PORT 读取，与镜像健康检查保持一致；0（随机端口）只供测试直接调用 startPanel 时使用
function parsePort(raw) {
  const port = parseIntegerValue(raw, "PANEL_PORT");
  if (port < 1 || port > 65535) {
    throw new Error(`PANEL_PORT 必须在 1–65535 之间：${raw}`);
  }
  return port;
}

// 面板数据目录。命令行按账号运行时只需要它，其他面板环境变量取值非法也不影响
function panelDataDirFromEnv(env = process.env) {
  return env.PANEL_DATA_DIR || "data";
}

// PANEL_PUBLIC_URL 与 PANEL_BASE_PATH 明显不一致时的提示：面板部署在子路径下，外网地址却不以该路径结尾，
// 推送中的面板链接多半打不开。反向代理去掉了前缀时（PANEL_BASE_PATH 为 /）外网地址带路径是正常的，不提示
function publicUrlWarning({ publicUrl, basePath }) {
  if (!publicUrl || basePath === "/" || new URL(publicUrl).pathname.endsWith(basePath)) {
    return "";
  }
  return `PANEL_PUBLIC_URL（${publicUrl}）的路径不以 PANEL_BASE_PATH（${basePath}）结尾，推送中的面板链接可能打不开`;
}

// 面板自身的运行参数，来自 PANEL_* 环境变量；取值非法时抛出错误
function panelOptionsFromEnv(env = process.env) {
  return {
    port: parsePort(env.PANEL_PORT || DEFAULT_PANEL_PORT),
    host: env.PANEL_HOST || "0.0.0.0",
    basePath: normalizeBasePath(env.PANEL_BASE_PATH),
    trustProxy: parseTrustProxy(env.PANEL_TRUST_PROXY),
    publicUrl: normalizePublicUrl(env.PANEL_PUBLIC_URL),
    password: env.PANEL_PASSWORD || "",
    forcePasswordLogin: parseForcePasswordLogin(env.PANEL_FORCE_PASSWORD_LOGIN),
    dataDir: panelDataDirFromEnv(env),
    // 首次启动时写入全局默认配置，之后以面板中的设置为准
    seleniumUrl: env.SELENIUM_URL || "",
  };
}

module.exports = {
  DEFAULT_PANEL_PORT,
  normalizeBasePath,
  panelDataDirFromEnv,
  panelOptionsFromEnv,
  parseTrustProxy,
  passkeyRelyingParty,
  publicUrlWarning,
};
