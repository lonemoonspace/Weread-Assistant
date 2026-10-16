const fs = require("fs");
const http = require("http");
const path = require("path");
const express = require("express");
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
const { createRunner } = require("./runner");
const { markInterruptedRuns, runDir } = require("./runs");
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

function createPanelApp(options, { auth, store, runner }) {
  const panelDataDir = path.resolve(options.dataDir);
  const settingsView = (data) => ({ settings: data.settings, defaults: maskValues(data.defaults) });
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
    res.json({ run: getRun(panelDataDir, req.params.id, req.params.runId, store.get().settings.timezone) });
  });

  api.get("/accounts/:id/runs/:runId/screenshots/:name", (req, res) => {
    const { dir, name } = screenshotPath(panelDataDir, req.params.id, req.params.runId, req.params.name);
    res.set("Content-Type", "image/png");
    res.sendFile(name, { root: dir });
  });

  // 打卡日历：?month=YYYY-MM（默认本月，按面板时区）
  api.get("/accounts/:id/calendar", (req, res) => {
    const data = store.get();
    const account = findAccount(data, req.params.id);
    res.json(calendar(panelDataDir, account, { timezone: data.settings.timezone, month: req.query.month }));
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
  // 退出登录、修改密码时立即断开；定期发送心跳注释，同时检查会话是否过期
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
      res.write(": ping\n\n");
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
    const auth = createAuth({ store, envPassword: options.password, limits: options.limits });
    const generatedPassword = await auth.init();
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
    const app = createPanelApp(options, { auth, store, runner });
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
