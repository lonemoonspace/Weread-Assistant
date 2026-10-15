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

// 端口只从 PANEL_PORT 读取，与镜像健康检查保持一致；0（随机端口）只供测试直接调用 startPanel 时使用
function parsePort(raw) {
  const port = parseIntegerValue(raw, "PANEL_PORT");
  if (port < 1 || port > 65535) {
    throw new Error(`PANEL_PORT 必须在 1–65535 之间：${raw}`);
  }
  return port;
}

// 面板自身的运行参数，来自 PANEL_* 环境变量；取值非法时抛出错误
function panelOptionsFromEnv(env = process.env) {
  return {
    port: parsePort(env.PANEL_PORT || DEFAULT_PANEL_PORT),
    host: env.PANEL_HOST || "0.0.0.0",
    basePath: normalizeBasePath(env.PANEL_BASE_PATH),
    trustProxy: parseTrustProxy(env.PANEL_TRUST_PROXY),
    publicUrl: env.PANEL_PUBLIC_URL || "",
    password: env.PANEL_PASSWORD || "",
    dataDir: env.PANEL_DATA_DIR || "data",
  };
}

module.exports = {
  DEFAULT_PANEL_PORT,
  normalizeBasePath,
  panelOptionsFromEnv,
  parseTrustProxy,
};
