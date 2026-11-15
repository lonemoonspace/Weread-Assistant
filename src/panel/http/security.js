const { SESSION_TTL_MS } = require("../auth");

const SESSION_COOKIE = "wa_session";
// 修改类请求必须带这个请求头。跨站页面无法在不触发 CORS 预检的情况下设置自定义请求头，
// 配合 SameSite=Strict 的会话 cookie 防止跨站请求伪造
const CSRF_HEADER = "X-WA-Request";

const CSP_DIRECTIVES = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data: blob:",
  "connect-src 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
];

// 只允许同源资源，不允许内联脚本与样式。面板主页面使用 Vue 免构建版，在浏览器内编译模板需要 'unsafe-eval'，
// 只对该页面放开；模板都写在仓库内的脚本文件中，不把服务端内容当作模板
function contentSecurityPolicy({ allowEval = false } = {}) {
  return CSP_DIRECTIVES.map((directive) =>
    allowEval && directive.startsWith("script-src ") ? `${directive} 'unsafe-eval'` : directive
  ).join("; ");
}

const SECURITY_HEADERS = {
  "Content-Security-Policy": contentSecurityPolicy(),
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  // 面板用不到这些浏览器能力
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
};

// HSTS：只在经 HTTPS 访问时下发（经 HTTP 下发会被浏览器忽略）。不带 includeSubDomains，同一域名下的其他站点可能仍是 HTTP
const HSTS_HEADER = "max-age=15552000";

function securityHeaders(req, res, next) {
  res.set(SECURITY_HEADERS);
  next();
}

// 请求中名为 name 的全部 cookie 值，按浏览器发送的顺序。同名 cookie 可能有多个（同主机的其他应用可以设置
// Path 或 Domain 不同的同名 cookie），只取其中一个会让别人用无效的值顶掉真实会话
function cookieValues(header = "", name) {
  const values = [];
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index > 0 && part.slice(0, index).trim() === name) {
      try {
        values.push(decodeURIComponent(part.slice(index + 1).trim()));
      } catch (_) {
        // 忽略无法解码的 cookie
      }
    }
  }
  return values;
}

// 经 HTTPS 访问：req.secure（直连或信任代理时），或请求的主机名就是 https 的 PANEL_PUBLIC_URL 的主机名。
// 后者让没有设置 PANEL_TRUST_PROXY 时（面板看到的是 http）会话 cookie 也带 Secure；用内网 IP 等其他地址经 HTTP 打开时不加，
// 否则浏览器不保存 cookie，无法用密码登录
function createSessionCookies({ publicUrl, basePath }) {
  const normalizeHost = (host) => String(host || "").toLowerCase().replace(/\.$/, "");
  const publicHttpsHost =
    publicUrl && new URL(publicUrl).protocol === "https:" ? normalizeHost(new URL(publicUrl).hostname) : "";
  const isHttps = (req) => req.secure || (publicHttpsHost !== "" && normalizeHost(req.hostname) === publicHttpsHost);
  const cookieOptions = (req) => ({
    httpOnly: true,
    sameSite: "strict",
    secure: isHttps(req),
    path: basePath,
  });
  const setSessionCookie = (req, res, token) => {
    res.cookie(SESSION_COOKIE, token, { ...cookieOptions(req), maxAge: SESSION_TTL_MS });
  };
  const clearSessionCookie = (req, res) => {
    res.clearCookie(SESSION_COOKIE, cookieOptions(req));
  };
  return { isHttps, setSessionCookie, clearSessionCookie };
}

function csrfGuard(req, res, next) {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) {
    next();
    return;
  }
  if (req.get(CSRF_HEADER) !== "1") {
    res.status(403).json({ error: "csrf_header_required" });
    return;
  }
  // 没有请求体的请求（例如 DELETE、退出登录）只需要自定义请求头；带请求体时必须是 JSON。
  // POST 不带请求体时客户端通常仍会发送 Content-Length: 0，这里按实际内容长度判断
  const hasBody = Number(req.get("Content-Length") || 0) > 0 || req.get("Transfer-Encoding") !== undefined;
  if (hasBody && !req.is("application/json")) {
    res.status(415).json({ error: "json_required" });
    return;
  }
  next();
}

module.exports = {
  CSRF_HEADER,
  HSTS_HEADER,
  SESSION_COOKIE,
  contentSecurityPolicy,
  cookieValues,
  createSessionCookies,
  csrfGuard,
  securityHeaders,
};
