const http = require("http");
const path = require("path");
const express = require("express");
const { VERSION } = require("../shared/version");
const { MIN_PASSWORD_LENGTH, SESSION_TTL_MS, createAuth } = require("./auth");
const { createStore } = require("./store");

const SESSION_COOKIE = "wa_session";
// 修改类请求必须带这个请求头。跨站页面无法在不触发 CORS 预检的情况下设置自定义请求头，
// 配合 SameSite=Strict 的会话 cookie 防止跨站请求伪造
const CSRF_HEADER = "X-WA-Request";
const PUBLIC_DIR = path.join(__dirname, "public");

const SECURITY_HEADERS = {
  "Content-Security-Policy": [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data: blob:",
    "connect-src 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join("; "),
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
};

function parseCookies(header = "") {
  const cookies = {};
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index > 0) {
      try {
        cookies[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
      } catch (_) {
        // 忽略无法解码的 cookie
      }
    }
  }
  return cookies;
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
  if (!req.is("application/json")) {
    res.status(415).json({ error: "json_required" });
    return;
  }
  next();
}

function createPanelApp(options, { auth }) {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", options.trustProxy);
  app.use((req, res, next) => {
    res.set(SECURITY_HEADERS);
    next();
  });

  // /weread 重定向到 /weread/，保证页面里的相对路径正确
  if (options.basePath !== "/") {
    const withoutSlash = options.basePath.slice(0, -1);
    app.use((req, res, next) => {
      if (req.path === withoutSlash) {
        const queryIndex = req.originalUrl.indexOf("?");
        const query = queryIndex >= 0 ? req.originalUrl.slice(queryIndex) : "";
        res.redirect(301, options.basePath + query);
        return;
      }
      next();
    });
  }

  const cookieOptions = (req) => ({
    httpOnly: true,
    sameSite: "strict",
    secure: req.secure,
    path: options.basePath,
  });
  const setSessionCookie = (req, res, token) => {
    res.cookie(SESSION_COOKIE, token, { ...cookieOptions(req), maxAge: SESSION_TTL_MS });
  };

  const router = express.Router();

  // 识别会话；有效时按需续期 cookie
  router.use((req, res, next) => {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE] || "";
    const session = auth.touchSession(token);
    req.sessionToken = session ? token : "";
    if (session && session.refreshCookie) {
      setSessionCookie(req, res, token);
    }
    next();
  });

  router.get("/healthz", (req, res) => {
    res.json({ status: "ok" });
  });

  router.use(
    "/assets",
    express.static(path.join(PUBLIC_DIR, "assets"), { index: false, fallthrough: false })
  );

  router.get("/", (req, res) => {
    if (!req.sessionToken) {
      res.redirect(302, "login");
      return;
    }
    res.sendFile(path.join(PUBLIC_DIR, "index.html"));
  });

  router.get("/login", (req, res) => {
    if (req.sessionToken) {
      res.redirect(302, "./");
      return;
    }
    res.sendFile(path.join(PUBLIC_DIR, "login.html"));
  });

  const api = express.Router();
  api.use((req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });
  api.use(csrfGuard);
  api.use(express.json({ limit: "10kb" }));

  api.post("/auth/login", async (req, res) => {
    const result = await auth.login(req.ip, req.body && req.body.password);
    if (result.ok) {
      setSessionCookie(req, res, result.token);
      console.info("面板登录成功:", req.ip);
      res.status(204).end();
      return;
    }
    const retryAfter = Math.ceil(result.retryAfterMs / 1000);
    if (retryAfter > 0) {
      res.set("Retry-After", String(retryAfter));
    }
    if (result.locked) {
      res.status(429).json({ error: "too_many_attempts", retryAfter });
      return;
    }
    console.warn("面板登录失败:", req.ip);
    res.status(401).json({ error: "wrong_password" });
  });

  api.use((req, res, next) => {
    if (!req.sessionToken) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    next();
  });

  api.get("/auth/session", (req, res) => {
    res.json({
      authenticated: true,
      version: VERSION,
      passwordFromEnv: auth.passwordFromEnv,
      minPasswordLength: MIN_PASSWORD_LENGTH,
    });
  });

  api.post("/auth/logout", (req, res) => {
    auth.destroySession(req.sessionToken);
    res.clearCookie(SESSION_COOKIE, cookieOptions(req));
    res.status(204).end();
  });

  api.post("/auth/password", async (req, res) => {
    const body = req.body || {};
    const result = await auth.changePassword(body.current, body.next);
    if (result.ok) {
      setSessionCookie(req, res, result.token);
      console.info("面板密码已修改，其他会话已失效");
      res.status(204).end();
      return;
    }
    const status = result.error === "password_from_env" ? 409 : 400;
    res.status(status).json({ error: result.error, minPasswordLength: MIN_PASSWORD_LENGTH });
  });

  api.use((req, res) => {
    res.status(404).json({ error: "not_found" });
  });

  router.use("/api", api);
  app.use(options.basePath, router);

  // 请求体不是合法 JSON 等错误
  app.use((err, req, res, next) => {
    if (res.headersSent) {
      next(err);
      return;
    }
    const status = err.status || err.statusCode || 500;
    if (status >= 500) {
      console.error("面板请求出错:", err);
    }
    res.status(status).json({ error: status >= 500 ? "internal_error" : "bad_request" });
  });

  return app;
}

// 启动面板。返回 { server, port, generatedPassword, close }；generatedPassword 只在首次生成密码时非空
async function startPanel(options) {
  const store = createStore(path.resolve(options.dataDir));
  const auth = createAuth({ store, envPassword: options.password, limits: options.limits });
  const generatedPassword = await auth.init();
  const app = createPanelApp(options, { auth });
  const server = http.createServer(app);

  await new Promise((resolve, reject) => {
    server.once("error", (error) => {
      if (error.code === "EADDRINUSE") {
        reject(new Error(`端口 ${options.port} 已被占用，请通过 PANEL_PORT 或 --port 更换端口`));
        return;
      }
      reject(error);
    });
    server.listen(options.port, options.host, resolve);
  });

  return {
    server,
    port: server.address().port,
    generatedPassword,
    close: () =>
      new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      }),
  };
}

module.exports = {
  CSRF_HEADER,
  SESSION_COOKIE,
  createPanelApp,
  startPanel,
};
