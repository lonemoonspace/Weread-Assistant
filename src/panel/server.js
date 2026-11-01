const fs = require("fs");
const http = require("http");
const path = require("path");
const express = require("express");
const { resolveConfig } = require("../config/resolve");
const { sendTestNotification } = require("../notify");
const { createLocalBrowserChecker } = require("../shared/local-browser");
const { createSeleniumChecker, displaySeleniumUrl, normalizeSeleniumUrl } = require("../shared/selenium");
const { VERSION } = require("../shared/version");
const { createAccount, deleteAccount, findAccount, publicAccount, updateAccount } = require("./accounts");
const { MIN_PASSWORD_LENGTH, SESSION_TTL_MS, createAuth } = require("./auth");
const {
  applyConfigPatch,
  maskValues,
  publicEffectiveConfig,
  publicSchema,
  resolveAccountConfig,
} = require("./config");
const { PanelError, badRequest } = require("./errors");
const {
  calendar,
  challengeProgress,
  cleanupRuns,
  getRun,
  lastRun,
  listRuns,
  screenshotPath,
  todayStats,
} = require("./history");
const { acquirePanelLock } = require("./lock");
const { passkeyRelyingParty } = require("./options");
const { createPasskeys } = require("./passkeys");
const { createRunner } = require("./runner");
const { markInterruptedRuns, restrictRunDirs, runDir } = require("./runs");
const { createScheduler } = require("./scheduler");
const { nextRunAt, normalizeSchedules, publicSchedule } = require("./schedules");
const { applySettingsPatch } = require("./settings");
const { createStore } = require("./store");

const SESSION_COOKIE = "wa_session";
// 修改类请求必须带这个请求头。跨站页面无法在不触发 CORS 预检的情况下设置自定义请求头，
// 配合 SameSite=Strict 的会话 cookie 防止跨站请求伪造
const CSRF_HEADER = "X-WA-Request";
const PUBLIC_DIR = path.join(__dirname, "public");
// 实时推送的心跳间隔，同时定期检查会话是否仍然有效
const SSE_HEARTBEAT_MS = 15000;
// 除每次运行结束与修改保留设置时之外，定期按保留策略清理运行数据
const CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000;

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

// HSTS：只在经 HTTPS 访问时下发（经 HTTP 下发会被浏览器忽略）。不带 includeSubDomains，同一域名下的其他站点可能仍是 HTTP
const HSTS_HEADER = "max-age=15552000";

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

function requireObject(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw badRequest("请求体必须是 JSON 对象");
  }
  return body;
}

function createPanelApp(options, { auth, store, runner, passkeys }) {
  const panelDataDir = path.resolve(options.dataDir);
  const settingsView = (data) => ({ settings: data.settings, defaults: maskValues(data.defaults) });
  // passkey 是否可用，以及可用时面板的地址（origin）：页面不在这个地址打开时不能使用 passkey
  const passkeyView = () => (passkeys.available ? { available: true, origin: passkeys.relyingParty.origin } : { available: false });
  const passwordLogin = () => passwordLoginState(store, passkeys, options.forcePasswordLogin);
  const passwordLoginDisabled = (res, status) =>
    res.status(status).json({ error: "password_login_disabled", message: "密码登录已关闭，请用 passkey 登录" });
  // 账号信息附带今天的阅读分钟数与最近一次运行，供总览使用
  const accountView = (account, timezone = store.get().settings.timezone) => ({
    ...publicAccount(account, panelDataDir, timezone),
    today: todayStats(panelDataDir, account.id, { timezone }),
    lastRun: lastRun(panelDataDir, account.id),
  });
  const schedulesView = (account, timezone) => ({
    timezone,
    enabled: account.enabled,
    nextRunAt: nextRunAt(account, timezone),
    schedules: account.schedules.map((rule) => publicSchedule(rule, timezone)),
  });
  const schedulesFromBody = (body) => {
    const unknown = Object.keys(requireObject(body)).filter((key) => key !== "schedules");
    if (unknown.length > 0) {
      throw badRequest(`未知的字段：${unknown.join(", ")}`);
    }
    return normalizeSchedules(body.schedules);
  };
  const checkSelenium = createSeleniumChecker({ timeoutMs: options.seleniumTimeoutMs });
  const checkLocalBrowser = createLocalBrowserChecker();

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

  // 经 HTTPS 访问：req.secure（直连或信任代理时），或请求的主机名就是 https 的 PANEL_PUBLIC_URL 的主机名。
  // 后者让没有设置 PANEL_TRUST_PROXY 时（面板看到的是 http）会话 cookie 也带 Secure；用内网 IP 等其他地址经 HTTP 打开时不加，
  // 否则浏览器不保存 cookie，无法用密码登录
  const normalizeHost = (host) => String(host || "").toLowerCase().replace(/\.$/, "");
  const publicHttpsHost =
    options.publicUrl && new URL(options.publicUrl).protocol === "https:" ? normalizeHost(new URL(options.publicUrl).hostname) : "";
  const isHttps = (req) => req.secure || (publicHttpsHost !== "" && normalizeHost(req.hostname) === publicHttpsHost);
  const cookieOptions = (req) => ({
    httpOnly: true,
    sameSite: "strict",
    secure: isHttps(req),
    path: options.basePath,
  });
  const setSessionCookie = (req, res, token) => {
    res.cookie(SESSION_COOKIE, token, { ...cookieOptions(req), maxAge: SESSION_TTL_MS });
  };

  const router = express.Router();

  // 识别会话（有多个同名 cookie 时取第一个有效的）；有效时按需续期 cookie
  router.use((req, res, next) => {
    if (isHttps(req)) {
      res.set("Strict-Transport-Security", HSTS_HEADER);
    }
    req.sessionToken = "";
    for (const token of cookieValues(req.headers.cookie, SESSION_COOKIE)) {
      const session = auth.touchSession(token);
      if (session) {
        req.sessionToken = token;
        if (session.refreshCookie) {
          setSessionCookie(req, res, token);
        }
        break;
      }
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
    res.set("Content-Security-Policy", contentSecurityPolicy({ allowEval: true }));
    // 页面是否可见取决于会话，不让浏览器或代理缓存
    res.set("Cache-Control", "no-store");
    res.sendFile(path.join(PUBLIC_DIR, "index.html"), { cacheControl: false });
  });

  router.get("/login", (req, res) => {
    if (req.sessionToken) {
      res.redirect(302, "./");
      return;
    }
    res.set("Cache-Control", "no-store");
    res.sendFile(path.join(PUBLIC_DIR, "login.html"), { cacheControl: false });
  });

  const api = express.Router();
  api.use((req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });
  api.use(csrfGuard);
  // 面板前端不发送压缩的请求体；不解压可以避免未登录的请求进入 gzip/Brotli 解码（Node.js 的解码器漏洞，如 CVE-2026-111497）
  api.use(express.json({ limit: "10kb", inflate: false }));

  // 登录或二次验证失败：被限速时 429，否则按 status 返回 error。这次失败触发了锁定时同样带上 retryAfter（秒），页面可以直接提示等待
  const sendAuthFailure = (res, result, status, error) => {
    const retryAfter = Math.ceil(result.retryAfterMs / 1000);
    if (retryAfter > 0) {
      res.set("Retry-After", String(retryAfter));
    }
    if (result.locked) {
      res.status(429).json({ error: "too_many_attempts", retryAfter });
      return;
    }
    res.status(status).json(retryAfter > 0 ? { error, retryAfter } : { error });
  };

  // 密码登录关闭时直接拒绝，不校验密码，也不计入限速
  api.post("/auth/login", async (req, res) => {
    if (!passwordLogin().active) {
      passwordLoginDisabled(res, 403);
      return;
    }
    const result = await auth.login(req.ip, req.body && req.body.password);
    if (result.ok) {
      setSessionCookie(req, res, result.token);
      console.info("面板登录成功:", req.ip);
      res.status(204).end();
      return;
    }
    if (!result.locked) {
      console.warn("面板登录失败:", req.ip);
    }
    sendAuthFailure(res, result, 401, "wrong_password");
  });

  // 登录页据此决定显示哪些登录方式：是否允许密码登录、是否提供 passkey 与它所在的地址，不透露添加了哪些 passkey
  api.get("/auth/methods", (req, res) => {
    res.json({ password: passwordLogin().active, passkey: passkeyView() });
  });

  // { purpose: "login" | "reauth" }：passkey 登录或二次验证的参数。登录不需要会话，被限速时 429；二次验证需要已登录
  api.post("/auth/passkey/options", async (req, res) => {
    const purpose = req.body && req.body.purpose;
    if (purpose === "reauth") {
      if (!req.sessionToken) {
        res.status(401).json({ error: "unauthorized" });
        return;
      }
      res.json(await passkeys.reauthOptions(req.sessionToken));
      return;
    }
    if (purpose !== "login") {
      throw badRequest("purpose 只能是 login 或 reauth");
    }
    const wait = auth.passkeyRetryAfterMs(req.ip);
    if (wait > 0) {
      sendAuthFailure(res, { locked: true, retryAfterMs: wait });
      return;
    }
    res.json(await passkeys.loginOptions());
  });

  let unknownPasskeyLoggedAt = 0;
  // { response }：浏览器返回的 passkey 登录结果。成功 204 并下发会话 cookie，失败 401（计入限速）。
  // 不是已添加的 passkey 时同样 401，但不计入限速
  api.post("/auth/passkey/login", async (req, res) => {
    const response = req.body && req.body.response;
    if (!passkeys.isKnownCredential(response)) {
      const wait = auth.passkeyRetryAfterMs(req.ip);
      if (wait > 0) {
        sendAuthFailure(res, { locked: true, retryAfterMs: wait });
        return;
      }
      // 这类请求不限速，日志每分钟最多记一条，避免被刷满磁盘
      if (Date.now() - unknownPasskeyLoggedAt >= 60 * 1000) {
        unknownPasskeyLoggedAt = Date.now();
        console.warn("面板 passkey 登录失败（不是当前域名下已添加的 passkey，1 分钟内不再记录同类失败）:", req.ip);
      }
      res.status(401).json({ error: "passkey_failed" });
      return;
    }
    const result = await auth.loginWithPasskey(req.ip, () => passkeys.verifyLogin(response));
    if (result.ok) {
      setSessionCookie(req, res, result.token);
      console.info(`面板登录成功（passkey「${result.passkey.name}」）:`, req.ip);
      res.status(204).end();
      return;
    }
    if (!result.locked) {
      console.warn("面板 passkey 登录失败:", req.ip);
    }
    sendAuthFailure(res, result, 401, "passkey_failed");
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
      passkey: passkeyView(),
      passwordLogin: passwordLogin(),
      ...auth.sessionInfo(req.sessionToken),
    });
  });

  // 二次验证：{ password } 或 { passkey }（浏览器返回的 passkey 结果）。成功后 5 分钟内可以添加、删除 passkey。
  // 失败返回 400（不是 401，避免页面当作会话失效），计入登录限速
  api.post("/auth/reauth", async (req, res) => {
    const body = requireObject(req.body);
    const usePasskey = body.passkey !== undefined;
    if (!usePasskey && !passwordLogin().active) {
      passwordLoginDisabled(res, 403);
      return;
    }
    const result = usePasskey
      ? await auth.reauthWithPasskey(req.ip, req.sessionToken, () => passkeys.verifyReauth(body.passkey, req.sessionToken))
      : await auth.reauthWithPassword(req.ip, req.sessionToken, body.password);
    if (result.ok) {
      res.status(204).end();
      return;
    }
    if (!result.locked) {
      console.warn("面板二次验证失败:", req.ip);
    }
    sendAuthFailure(res, result, 400, usePasskey ? "passkey_failed" : "wrong_password");
  });

  // 敏感操作要求会话在 5 分钟内登录或二次验证过，否则 403 reauth_required，页面据此弹出验证对话框后重试；
  // method 为 passkey 时还要求那一次用的是 passkey（响应中带 method，对话框只提供 passkey 验证）
  const reauthRequired = (res, method) =>
    res.status(403).json({ error: "reauth_required", ...(method ? { method } : {}), message: "需要再验证一次身份" });
  const requireRecentAuth = (req, res, next) => {
    if (!auth.isRecentlyVerified(req.sessionToken)) {
      reauthRequired(res);
      return;
    }
    next();
  };

  api.get("/auth/passkeys", (req, res) => {
    res.json({ passkey: passkeyView(), passkeys: passkeys.list() });
  });

  api.post("/auth/passkeys/options", requireRecentAuth, async (req, res) => {
    res.json(await passkeys.registrationOptions(req.sessionToken));
  });

  // { name?, response }：校验浏览器返回的结果并保存
  api.post("/auth/passkeys", requireRecentAuth, async (req, res) => {
    const body = requireObject(req.body);
    const passkey = await passkeys.register(body.response, body.name, req.sessionToken);
    console.info(`已添加 passkey「${passkey.name}」`);
    res.status(201).json({ passkey });
  });

  api.patch("/auth/passkeys/:id", requireRecentAuth, async (req, res) => {
    const passkey = await passkeys.rename(req.params.id, requireObject(req.body).name);
    res.json({ passkey });
  });

  // 删除后，用这个 passkey 登录的其他会话立即失效（当前会话保留）
  api.delete("/auth/passkeys/:id", requireRecentAuth, async (req, res) => {
    const passkey = await passkeys.remove(req.params.id);
    const ended = auth.endPasskeySessions(passkey.id, req.sessionToken);
    console.info(`已删除 passkey「${passkey.name}」${ended > 0 ? `，结束了用它登录的 ${ended} 个会话` : ""}`);
    res.status(204).end();
  });

  // { enabled }：在设置中打开或关闭密码登录。关闭要求 5 分钟内用 passkey 验证过（确认它在当前域名下能用），
  // 并且当前域名下至少有一个可用的 passkey；关闭后其他用密码登录的会话立即失效。打开只要求 5 分钟内验证过
  api.patch("/auth/password-login", async (req, res) => {
    const body = requireObject(req.body);
    const unknown = Object.keys(body).filter((key) => key !== "enabled");
    if (typeof body.enabled !== "boolean" || unknown.length > 0) {
      throw badRequest("只能提交 { enabled: true | false }");
    }
    if (!body.enabled) {
      if (passkeys.usableCount() === 0) {
        throw new PanelError(409, "no_usable_passkey", "当前域名下没有可用的 passkey，添加后才能关闭密码登录");
      }
      if (!auth.isRecentlyVerified(req.sessionToken, "passkey")) {
        reauthRequired(res, "passkey");
        return;
      }
    } else if (!auth.isRecentlyVerified(req.sessionToken)) {
      reauthRequired(res);
      return;
    }
    await store.update((data) => {
      data.auth.passwordLogin = body.enabled;
    });
    const state = passwordLogin();
    if (body.enabled) {
      console.info("已打开密码登录");
    } else {
      const ended = state.active ? 0 : auth.endPasswordSessions(req.sessionToken);
      console.info(`已关闭密码登录${ended > 0 ? `，结束了用密码登录的 ${ended} 个会话` : ""}${state.forced ? "（PANEL_FORCE_PASSWORD_LOGIN 生效期间仍可用密码登录）" : ""}`);
    }
    res.json({ passwordLogin: state });
  });

  api.post("/auth/logout", (req, res) => {
    auth.destroySession(req.sessionToken);
    res.clearCookie(SESSION_COOKIE, cookieOptions(req));
    res.status(204).end();
  });

  api.post("/auth/password", async (req, res) => {
    if (!passwordLogin().active) {
      passwordLoginDisabled(res, 409);
      return;
    }
    const body = req.body || {};
    const result = await auth.changePassword(req.ip, body.current, body.next);
    if (result.ok) {
      setSessionCookie(req, res, result.token);
      console.info("面板密码已修改，其他会话已失效");
      res.status(204).end();
      return;
    }
    if (result.error === "too_many_attempts") {
      sendAuthFailure(res, { locked: true, retryAfterMs: result.retryAfterMs });
      return;
    }
    if (result.error === "wrong_password") {
      console.warn("修改面板密码：当前密码不正确:", req.ip);
    }
    const status = result.error === "password_from_env" ? 409 : 400;
    res.status(status).json({ error: result.error, minPasswordLength: MIN_PASSWORD_LENGTH });
  });

  api.get("/schema", (req, res) => {
    res.json(publicSchema());
  });

  api.get("/settings", (req, res) => {
    res.json(settingsView(store.get()));
  });

  // { settings?, defaults? }：settings 为面板设置，defaults 为全局默认运行配置
  api.patch("/settings", async (req, res) => {
    const body = requireObject(req.body);
    const data = await store.update((draft) => {
      if (body.settings !== undefined) {
        draft.settings = applySettingsPatch(draft.settings, body.settings);
      }
      if (body.defaults !== undefined) {
        draft.defaults = applyConfigPatch(draft.defaults, body.defaults);
      }
    });
    // 调大并发数后立即启动排队中的运行
    runner.pump();
    res.json(settingsView(data));
  });

  api.get("/accounts", (req, res) => {
    const data = store.get();
    res.json({ accounts: data.accounts.map((account) => accountView(account, data.settings.timezone)) });
  });

  api.post("/accounts", async (req, res) => {
    const account = await createAccount(store, panelDataDir, requireObject(req.body));
    console.info("新建账号:", account.id);
    res.status(201).json({ account: accountView(account) });
  });

  // 账号详情与实际生效的配置（账号覆盖 > 全局默认 > 内置默认）
  api.get("/accounts/:id", (req, res) => {
    const data = store.get();
    const account = findAccount(data, req.params.id);
    res.json({
      account: accountView(account, data.settings.timezone),
      challengeProgress: challengeProgress(panelDataDir, account, { timezone: data.settings.timezone }),
      effective: publicEffectiveConfig(resolveAccountConfig(data, account, panelDataDir)),
    });
  });

  api.patch("/accounts/:id", async (req, res) => {
    const account = await updateAccount(store, req.params.id, requireObject(req.body));
    res.json({ account: accountView(account) });
  });

  // { deleteData?: boolean }：默认保留账号数据目录；账号正在运行或排队时拒绝删除
  api.delete("/accounts/:id", async (req, res) => {
    const body = req.body === undefined ? {} : requireObject(req.body);
    await deleteAccount(store, panelDataDir, req.params.id, {
      deleteData: body.deleteData === true,
      isBusy: (id) => runner.isActive(id),
    });
    console.info("删除账号:", req.params.id, body.deleteData === true ? "（同时删除数据）" : "");
    res.status(204).end();
  });

  // 账号的调度规则、每条规则接下来的触发时间与账号下一次定时运行的时间
  api.get("/accounts/:id/schedules", (req, res) => {
    const data = store.get();
    res.json(schedulesView(findAccount(data, req.params.id), data.settings.timezone));
  });

  // { schedules: [...] }：整体替换账号的调度规则，保存后立即生效
  api.put("/accounts/:id/schedules", async (req, res) => {
    const schedules = schedulesFromBody(req.body);
    const data = await store.update((draft) => {
      findAccount(draft, req.params.id).schedules = schedules;
    });
    console.info(`调度规则已更新：账号 ${req.params.id}，${schedules.length} 条`);
    res.json(schedulesView(findAccount(data, req.params.id), data.settings.timezone));
  });

  // { schedules: [...] }：校验规则并预览接下来的触发时间，不保存
  api.post("/schedules/preview", (req, res) => {
    const { timezone } = store.get().settings;
    res.json({ timezone, schedules: schedulesFromBody(req.body).map((rule) => publicSchedule(rule, timezone)) });
  });

  // 运行历史，最新的在前；?limit=（1–100，默认 20）&before=<上一页最后一个运行 ID>
  api.get("/accounts/:id/runs", (req, res) => {
    findAccount(store.get(), req.params.id);
    res.json(listRuns(panelDataDir, req.params.id, { limit: req.query.limit || 20, before: req.query.before || "" }));
  });

  // 单次运行的记录、截图列表与按天拆分的阅读分钟数
  api.get("/accounts/:id/runs/:runId", (req, res) => {
    findAccount(store.get(), req.params.id);
    res.json({ run: getRun(panelDataDir, req.params.id, req.params.runId, store.get().settings.timezone) });
  });

  api.get("/accounts/:id/runs/:runId/screenshots/:name", (req, res) => {
    findAccount(store.get(), req.params.id);
    const { dir, name } = screenshotPath(panelDataDir, req.params.id, req.params.runId, req.params.name);
    res.set("Content-Type", "image/png");
    res.sendFile(name, { root: dir });
  });

  // 等待扫码时的二维码截图，二维码解析不出登录链接时页面用它代替本地生成的二维码
  api.get("/accounts/:id/login-qr", (req, res) => {
    findAccount(store.get(), req.params.id);
    const image = runner.loginQrImage(req.params.id);
    if (!image) {
      throw new PanelError(404, "login_qr_not_found", "当前没有等待扫码的二维码截图");
    }
    res.set("Content-Type", "image/png");
    res.sendFile(image.name, { root: image.dir });
  });

  // 打卡日历：?month=YYYY-MM（默认本月，按面板时区）
  api.get("/accounts/:id/calendar", (req, res) => {
    const data = store.get();
    const account = findAccount(data, req.params.id);
    res.json(calendar(panelDataDir, account, { timezone: data.settings.timezone, month: req.query.month }));
  });

  // { accountId? }：按账号的实际配置（不提供时按全局默认配置）向已配置的渠道各发送一条测试通知
  api.post("/notifications/test", async (req, res) => {
    const body = req.body === undefined ? {} : requireObject(req.body);
    const data = store.get();
    let config;
    try {
      config = body.accountId
        ? resolveAccountConfig(data, findAccount(data, String(body.accountId)), panelDataDir)
        : resolveConfig(data.defaults);
    } catch (e) {
      if (e instanceof PanelError) {
        throw e;
      }
      throw badRequest(`配置无效：${e.message}`);
    }
    res.json({ results: await sendTestNotification(config) });
  });

  // Selenium 的状态与会话数：全局默认配置与各账号实际使用的 Selenium 地址各查询一次；地址为空表示内置浏览器（builtin）。
  // accounts 为使用该地址的账号，panelRuns 为面板在该地址上已启动的运行数（每个占用一个会话）
  api.get("/selenium/status", async (req, res) => {
    const data = store.get();
    const servers = new Map();
    const serverFor = (url) => {
      const key = url ? normalizeSeleniumUrl(url) : "";
      if (!servers.has(key)) {
        servers.set(key, { key, url: key && displaySeleniumUrl(key), builtin: !key, isDefault: false, accounts: [], panelRuns: 0 });
      }
      return servers.get(key);
    };
    try {
      serverFor(resolveConfig(data.defaults).seleniumUrl).isDefault = true;
    } catch (_) {
      // 全局默认配置无效时只列出各账号使用的地址
    }
    for (const account of data.accounts) {
      let config;
      try {
        config = resolveAccountConfig(data, account, panelDataDir);
      } catch (_) {
        // 配置无效的账号无法运行，不列出
        continue;
      }
      serverFor(config.seleniumUrl).accounts.push({ id: account.id, name: account.name });
    }
    for (const url of runner.seleniumUrls()) {
      serverFor(url).panelRuns += 1;
    }
    const results = await Promise.all(
      [...servers.values()].map(async ({ key, ...server }) => ({
        ...server,
        ...(await (key ? checkSelenium(key) : checkLocalBrowser())),
      }))
    );
    res.json({
      checkedAt: new Date().toISOString(),
      maxConcurrentRuns: data.settings.maxConcurrentRuns,
      servers: results,
    });
  });

  // 排队中与进行中的运行，带最近的日志
  api.get("/runs", (req, res) => {
    res.json({ runs: runner.list({ withLog: true }) });
  });

  // { mode?: "read" | "login" }：立即运行（默认阅读）或仅登录；加入队列后返回 202
  api.post("/accounts/:id/runs", (req, res) => {
    const body = req.body === undefined ? {} : requireObject(req.body);
    const unknown = Object.keys(body).filter((key) => key !== "mode");
    if (unknown.length > 0) {
      throw badRequest(`未知的字段：${unknown.join(", ")}`);
    }
    const run = runner.enqueue(req.params.id, { mode: body.mode === undefined ? "read" : body.mode });
    res.status(202).json({ run });
  });

  // 停止账号当前的运行：排队中的直接取消，进行中的先关闭浏览器再结束
  api.post("/accounts/:id/stop", (req, res) => {
    res.status(202).json({ run: runner.stop(req.params.id) });
  });

  // 运行日志；?download=1 时作为附件下载
  api.get("/accounts/:id/runs/:runId/log", (req, res) => {
    findAccount(store.get(), req.params.id);
    let dir;
    try {
      dir = runDir(panelDataDir, req.params.id, req.params.runId);
    } catch (_) {
      throw new PanelError(404, "run_not_found", "运行记录不存在");
    }
    if (!fs.existsSync(path.join(dir, "output.log"))) {
      throw new PanelError(404, "run_not_found", "运行记录不存在");
    }
    res.set("Content-Type", "text/plain; charset=utf-8");
    if (req.query.download === "1") {
      res.set("Content-Disposition", `attachment; filename="${req.params.id}-${req.params.runId}.log"`);
    }
    // 以运行目录为 root：数据目录位于以点开头的目录下（如 ~/.weread）时也能读取
    res.sendFile("output.log", { root: dir });
  });

  // 实时推送（SSE）：连接后先发送一次完整状态 snapshot，之后推送运行状态变化 run 与新的日志行 log。
  // 退出登录、修改密码时立即断开；定期发送心跳事件 ping，同时检查会话是否过期
  api.get("/events", (req, res) => {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      "X-Accel-Buffering": "no",
    });
    // 连接关闭后不再写入：在已结束的响应上写入会触发 error 事件
    let open = true;
    const send = (event, data) => {
      if (open) {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      }
    };
    let heartbeat = null;
    let unsubscribe = () => {};
    let unwatch = () => {};
    const disconnect = () => {
      if (open) {
        cleanup();
        res.end();
      }
    };
    res.write("retry: 3000\n\n");
    send("snapshot", { runs: runner.list({ withLog: true }) });
    unsubscribe = runner.subscribe(send);
    unwatch = auth.watchSession(req.sessionToken, disconnect);
    if (!open) {
      return;
    }
    heartbeat = setInterval(() => {
      if (!auth.isSessionValid(req.sessionToken)) {
        disconnect();
        return;
      }
      // 以事件而不是注释发送：页面据此发现半开的连接（EventSource 收不到注释）
      send("ping", {});
    }, options.sseHeartbeatMs || SSE_HEARTBEAT_MS);
    function cleanup() {
      if (!open) {
        return;
      }
      open = false;
      clearInterval(heartbeat);
      unsubscribe();
      unwatch();
    }
    res.on("close", cleanup);
    res.on("error", cleanup);
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
    if (err instanceof PanelError) {
      if (err.status >= 500) {
        console.error("面板请求出错:", err);
      }
      res.status(err.status).json({ error: err.code, message: err.message });
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

// 0.1.x 的 docker-compose.yml 经 SELENIUM_URL 把这个地址写入了全局默认配置。新版改用内置浏览器、去掉了 selenium 服务，
// 第一次在没有设置 SELENIUM_URL 的情况下启动时，把全局默认配置与账号配置中的这个地址清空，改用内置浏览器。
// 迁移只做一次（记录在 panel.json 的 migrations 中）：之后在面板中主动填写的同一地址不会再被清空
const LEGACY_SELENIUM_URL = "http://selenium:4444";
const LEGACY_SELENIUM_MIGRATION = "legacy-selenium-url";

async function migrateLegacySeleniumUrl(store) {
  if (store.get().migrations.includes(LEGACY_SELENIUM_MIGRATION)) {
    return;
  }
  const isLegacy = (config) => Boolean(config && config.seleniumUrl) && normalizeSeleniumUrl(config.seleniumUrl) === LEGACY_SELENIUM_URL;
  let cleared = 0;
  await store.update((next) => {
    for (const config of [next.defaults, ...next.accounts.map((account) => account.overrides)]) {
      if (isLegacy(config)) {
        delete config.seleniumUrl;
        cleared += 1;
      }
    }
    next.migrations.push(LEGACY_SELENIUM_MIGRATION);
  });
  if (cleared > 0) {
    console.warn(
      `没有设置 SELENIUM_URL，已把配置中的 Selenium 地址 ${LEGACY_SELENIUM_URL} 清空（${cleared} 处），改用内置浏览器。` +
        "这一步只在升级后执行一次；仍要使用该地址的 Selenium 时在面板设置中重新填写，之后不会再被清空"
    );
  }
}

// 密码登录的状态。enabled：设置中是否打开；active：实际是否允许。设置中关闭后，以下情况仍然允许，避免把自己锁在外面：
// 设置了 PANEL_FORCE_PASSWORD_LOGIN（forced），或当前域名下没有可用的 passkey（换了域名、去掉了 PANEL_PUBLIC_URL）。
// reason 为设置中关闭、实际仍允许的原因（forced / no_usable_passkey），其他情况为 null
function passwordLoginState(store, passkeys, forced = false) {
  const enabled = store.get().auth.passwordLogin !== false;
  const noPasskey = passkeys.usableCount() === 0;
  const active = enabled || Boolean(forced) || noPasskey;
  let reason = null;
  if (!enabled && active) {
    reason = forced ? "forced" : "no_usable_passkey";
  }
  return { enabled, active, forced: Boolean(forced), reason };
}

// 设置中关闭了密码登录、实际仍然允许时提示原因；PANEL_FORCE_PASSWORD_LOGIN 用完后应删掉
function warnPasswordLogin(store, passkeys, forced) {
  const state = passwordLoginState(store, passkeys, forced);
  if (state.reason === "forced") {
    console.warn("PANEL_FORCE_PASSWORD_LOGIN 已生效：密码登录在设置中已关闭，现在临时允许用密码登录。处理完后删掉这个变量并重启面板");
  } else if (state.reason === "no_usable_passkey") {
    console.warn("密码登录在设置中已关闭，但当前域名下没有可用的 passkey，暂时允许用密码登录；用密码登录后重新添加 passkey 即可恢复");
  } else if (forced) {
    console.warn("设置了 PANEL_FORCE_PASSWORD_LOGIN，但密码登录本来就是打开的，可以删掉这个变量");
  }
}

// 已添加的 passkey 在当前地址下都用不了（PANEL_PUBLIC_URL 未设置、不是 HTTPS 或换了域名）时提示，密码登录不受影响
function warnUnusablePasskeys(store, passkeys) {
  const total = store.get().auth.passkeys.length;
  if (total === 0 || passkeys.usableCount() > 0) {
    return;
  }
  console.warn(
    passkeys.available
      ? `已添加的 ${total} 个 passkey 都不是在 ${passkeys.relyingParty.id} 下添加的（更换了域名？），需要用密码登录后重新添加`
      : `已添加了 ${total} 个 passkey，但 PANEL_PUBLIC_URL 没有设置为 HTTPS 地址，暂时不能用 passkey 登录`
  );
}

// 启动面板。返回 { server, port, generatedPassword, close }；generatedPassword 只在首次生成密码时非空
async function startPanel(options) {
  // 先拿到数据目录的锁，再读写 panel.json
  const lock = acquirePanelLock(options.dataDir);
  let server;
  let runner;
  let scheduler;
  let cleanupTimer;
  try {
    const store = createStore(path.resolve(options.dataDir), {
      seedDefaults: options.seleniumUrl ? { seleniumUrl: options.seleniumUrl } : {},
    });
    if (!options.seleniumUrl) {
      await migrateLegacySeleniumUrl(store);
    }
    const auth = createAuth({ store, envPassword: options.password, limits: options.limits });
    const generatedPassword = await auth.init();
    const passkeys = createPasskeys({ store, relyingParty: passkeyRelyingParty(options.publicUrl) });
    warnUnusablePasskeys(store, passkeys);
    warnPasswordLogin(store, passkeys, options.forcePasswordLogin);
    restrictRunDirs(options.dataDir);
    markInterruptedRuns(options.dataDir);
    // 按保留策略清理截图与日志；进行中的运行不清理
    const cleanup = () => {
      try {
        const activeRunIds = new Set(runner.list().map((run) => run.id));
        cleanupRuns(options.dataDir, store.get().settings, { activeRunIds });
      } catch (e) {
        console.error("清理运行数据失败:", e);
      }
    };
    // options.runner：测试时替换阅读子进程、缩短超时
    runner = createRunner({
      dataDir: options.dataDir,
      store,
      publicUrl: options.publicUrl,
      onFinish: () => setImmediate(cleanup),
      ...options.runner,
    });
    cleanup();
    cleanupTimer = setInterval(cleanup, CLEANUP_INTERVAL_MS);
    cleanupTimer.unref();
    const retentionOf = (settings) => `${settings.screenshotRetentionRuns}/${settings.logRetentionDays}`;
    let retention = retentionOf(store.get().settings);
    store.subscribe(() => {
      const next = retentionOf(store.get().settings);
      if (next !== retention) {
        retention = next;
        setImmediate(cleanup);
      }
    });
    const app = createPanelApp(options, { auth, store, runner, passkeys });
    scheduler = createScheduler({ store, runner });
    server = http.createServer(app);

    await new Promise((resolve, reject) => {
      server.once("error", (error) => {
        if (error.code === "EADDRINUSE") {
          reject(new Error(`端口 ${options.port} 已被占用，请通过 PANEL_PORT 更换端口`));
          return;
        }
        reject(error);
      });
      server.listen(options.port, options.host, resolve);
    });

    // 停止：不再接受新连接；结束进行中的运行（期间实时推送仍可送达）；断开剩余连接后释放锁
    let closing = null;
    const close = async () => {
      const serverClosed = new Promise((resolve) => server.close(resolve));
      clearInterval(cleanupTimer);
      scheduler.close();
      await runner.close();
      server.closeAllConnections();
      await serverClosed;
      lock.release();
    };

    return {
      server,
      runner,
      scheduler,
      port: server.address().port,
      generatedPassword,
      close: () => {
        closing = closing || close();
        return closing;
      },
    };
  } catch (error) {
    clearInterval(cleanupTimer);
    if (scheduler) {
      scheduler.close();
    }
    lock.release();
    throw error;
  }
}

module.exports = {
  CSRF_HEADER,
  SESSION_COOKIE,
  createPanelApp,
  startPanel,
};
