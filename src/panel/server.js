const http = require("http");
const path = require("path");
const express = require("express");
const { createLocalBrowserChecker } = require("../shared/local-browser");
const { createAuth } = require("./auth");
const { PanelError } = require("./errors");
const { cleanupRuns } = require("./history");
const { CSRF_HEADER, SESSION_COOKIE, createSessionCookies, csrfGuard, securityHeaders } = require("./http/security");
const { identifySession, passwordLoginState, requireSession } = require("./http/session");
const { accountRoutes } = require("./http/routes/accounts");
const { authRoutes, publicAuthRoutes } = require("./http/routes/auth");
const { BACKUP_IMPORT_PATH, backupRoutes } = require("./http/routes/backup");
const { eventRoutes } = require("./http/routes/events");
const { pageRoutes } = require("./http/routes/pages");
const { runRoutes } = require("./http/routes/runs");
const { settingsRoutes } = require("./http/routes/settings");
const { statsRoutes } = require("./http/routes/stats");
const { acquirePanelLock } = require("./lock");
const { passkeyRelyingParty } = require("./options");
const { createPasskeys } = require("./passkeys");
const { createPlanner } = require("./planner");
const { createRunner } = require("./runner");
const { cleanupRunTempDirs } = require("./runner/process");
const { markInterruptedRuns, restrictRunDirs } = require("./runs");
const { createScheduler } = require("./scheduler");
const { dropProfileName, migrateLegacySeleniumUrl, warnPasswordLogin, warnUnusablePasskeys } = require("./startup");
const { createStore } = require("./store");

// 除每次运行结束与修改保留设置时之外，定期按保留策略清理运行数据
const CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000;
// 空闲连接的保持时间，见 startPanel
const KEEP_ALIVE_TIMEOUT_MS = 95000;

// 组装面板应用。各组接口见 http/routes/：中间件的先后决定哪些接口需要登录，挂载顺序不能随意调整
function createPanelApp(
  options,
  { auth, store, runner, passkeys, planner = null, checkLocalBrowser = createLocalBrowserChecker(process.env, { timeoutMs: options.browserVersionTimeoutMs }) }
) {
  const cookies = createSessionCookies(options);
  // 各组接口共用的依赖
  const ctx = { options, dataDir: path.resolve(options.dataDir), auth, store, runner, passkeys, planner, checkLocalBrowser, cookies };

  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", options.trustProxy);
  app.use(securityHeaders);

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

  const router = express.Router();
  router.use(identifySession(ctx));
  router.use(pageRoutes());

  const api = express.Router();
  api.use((req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });
  api.use(csrfGuard);
  // 面板前端不发送压缩的请求体；不解压可以避免未登录的请求进入 gzip/Brotli 解码（Node.js 的解码器漏洞，如 CVE-2026-111497）
  // 导入备份的接口在确认已登录并近期验证过之后，才按更大的上限解析请求体（见 routes/backup.js）
  const smallJson = express.json({ limit: "10kb", inflate: false });
  api.use((req, res, next) => (req.method === "POST" && req.path === BACKUP_IMPORT_PATH ? next() : smallJson(req, res, next)));
  api.use(publicAuthRoutes(ctx));
  api.use(requireSession);
  api.use(authRoutes(ctx));
  api.use(settingsRoutes(ctx));
  api.use(accountRoutes(ctx));
  api.use(runRoutes(ctx));
  api.use(statsRoutes(ctx));
  api.use(eventRoutes(ctx));
  api.use(backupRoutes(ctx));
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
  let planner;
  let cleanupTimer;
  let auth;
  try {
    const store = createStore(path.resolve(options.dataDir), {
      seedDefaults: options.seleniumUrl ? { seleniumUrl: options.seleniumUrl } : {},
    });
    if (!options.seleniumUrl) {
      await migrateLegacySeleniumUrl(store);
    }
    await dropProfileName(store);
    // 会话保存在 sessions.json 中，面板重启后已登录的设备不必重新登录
    auth = createAuth({
      store,
      envPassword: options.password,
      limits: options.limits,
      sessionFile: path.join(options.dataDir, "sessions.json"),
    });
    const generatedPassword = await auth.init();
    const passkeys = createPasskeys({ store, relyingParty: passkeyRelyingParty(options.publicUrl) });
    warnUnusablePasskeys(store, passkeys);
    warnPasswordLogin(store, passkeys, options.forcePasswordLogin);
    auth.restoreSessions({
      // 只恢复当前域名下仍可用的 passkey 的会话，与登录时一致
      passkeyIds: new Set(
        store
          .get()
          .auth.passkeys.filter((passkey) => passkeys.isUsable(passkey))
          .map((passkey) => passkey.id)
      ),
      passwordLoginActive: passwordLoginState(store, passkeys, options.forcePasswordLogin).active,
    });
    restrictRunDirs(options.dataDir);
    const interrupted = markInterruptedRuns(options.dataDir);
    cleanupRunTempDirs(options.dataDir);
    // 按保留策略清理截图与日志；进行中的运行不清理
    const cleanup = () => {
      try {
        const activeRunIds = new Set(runner.list().map((run) => run.id));
        cleanupRuns(options.dataDir, store.get().settings, { activeRunIds });
      } catch (e) {
        console.error("清理运行数据失败:", e);
      }
    };
    // 内置浏览器的版本检查由面板与运行共用：面板检查过的结果随运行配置下发，子进程不必每次执行 --version
    const checkLocalBrowser = createLocalBrowserChecker(process.env, { timeoutMs: options.browserVersionTimeoutMs });
    // options.runner：测试时替换阅读子进程、缩短超时
    runner = createRunner({
      dataDir: options.dataDir,
      store,
      publicUrl: options.publicUrl,
      localBrowserStatus: checkLocalBrowser.cached,
      onFinish: (run, extra) => {
        setImmediate(cleanup);
        planner.handleFinished(run, extra);
      },
      ...options.runner,
    });
    // options.planner：测试时缩短启动等待与重试间隔
    planner = createPlanner({ dataDir: options.dataDir, store, runner, interrupted, ...options.planner });
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
    const app = createPanelApp(options, { auth, store, runner, passkeys, planner, checkLocalBrowser });
    scheduler = createScheduler({ store, runner, onFire: (accountId, rule) => planner.fireSchedule(accountId, rule) });
    server = http.createServer(app);
    // 面板通常在 cloudflared、nginx 等反向代理之后：空闲连接的保持时间要长于代理的（常见为 60–90 秒），
    // 否则代理复用一个刚被面板关闭的连接时会偶发 502。headersTimeout 须大于 keepAliveTimeout
    server.keepAliveTimeout = KEEP_ALIVE_TIMEOUT_MS;
    server.headersTimeout = KEEP_ALIVE_TIMEOUT_MS + 5000;

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
    // 启动后在后台检查一次内置浏览器，之后的运行直接使用这次的结果
    checkLocalBrowser().catch(() => {});
    planner.start();

    // 停止：不再接受新连接；结束进行中的运行（期间实时推送仍可送达）；断开剩余连接后释放锁
    let closing = null;
    const close = async () => {
      const serverClosed = new Promise((resolve) => server.close(resolve));
      clearInterval(cleanupTimer);
      scheduler.close();
      // 先停止安排新的重试与补跑；运行队列结束进行中的运行时，计划器记下被中断的运行，下次启动时恢复
      planner.beginClose();
      await runner.close();
      planner.close();
      server.closeAllConnections();
      await serverClosed;
      auth.close();
      lock.release();
    };

    return {
      server,
      runner,
      scheduler,
      planner,
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
    if (planner) {
      planner.close();
    }
    if (auth) {
      auth.close();
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
