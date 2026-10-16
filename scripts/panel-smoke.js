#!/usr/bin/env node
/**
 * 面板 smoke 测试：在本机启动面板，用 HTTP 请求验证鉴权、会话、限速、反向代理、安全响应头、
 * 配置与账号，以及运行队列（排队、成功、失败、停止、强制结束、实时推送）。
 * 运行队列使用桩子进程 scripts/fixtures/stub-worker.js，不需要浏览器与 Selenium。
 * 用法: node scripts/panel-smoke.js
 */

const assert = require("assert");
const fs = require("fs");
const http = require("http");
const net = require("net");
const os = require("os");
const path = require("path");

const { startPanel } = require(path.resolve(__dirname, "..", "src", "panel", "server"));
const { hashPassword } = require(path.resolve(__dirname, "..", "src", "panel", "auth"));
const { SECRET_MASK, resolveAccountConfig } = require(path.resolve(__dirname, "..", "src", "panel", "config"));
const { CHILD_ENV_KEYS } = require(path.resolve(__dirname, "..", "src", "panel", "runner"));
const { describeSchedule, nextRuns, normalizeSchedules, schedulePatterns } = require(
  path.resolve(__dirname, "..", "src", "panel", "schedules")
);
const { challengeProgress, cleanupRuns, dateInZone } = require(path.resolve(__dirname, "..", "src", "panel", "history"));
const { minutesFrom, writeRun } = require("./fixtures/run-records");

const CSRF = { "X-WA-Request": "1" };
const STUB_WORKER = path.resolve(__dirname, "fixtures", "stub-worker.js");

const tempDirs = [];

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "panel-smoke-"));
  tempDirs.push(dir);
  return dir;
}

function panelOptions(overrides = {}) {
  return {
    port: 0,
    host: "127.0.0.1",
    basePath: "/",
    trustProxy: false,
    publicUrl: "",
    password: "",
    dataDir: tempDir(),
    seleniumUrl: "",
    runner: { workerPath: STUB_WORKER, killTimeoutMs: 500 },
    sseHeartbeatMs: 100,
    ...overrides,
  };
}

async function until(check, { timeoutMs = 10000, message = "等待条件成立超时" } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error(message);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

// 等待满足条件的运行状态推送；需在触发运行之前调用
function nextRun(panel, predicate, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error("等待运行状态超时"));
    }, timeoutMs);
    const unsubscribe = panel.runner.subscribe((type, run) => {
      if (type === "run" && predicate(run)) {
        clearTimeout(timer);
        unsubscribe();
        resolve(run);
      }
    });
  });
}

const ended = (accountId) => (run) => run.accountId === accountId && Boolean(run.endedAt);

function runFiles(panel, accountId, runId) {
  const dir = path.join(panel.options.dataDir, "runs", accountId, runId);
  return {
    dir,
    meta: () => JSON.parse(fs.readFileSync(path.join(dir, "meta.json"), "utf8")),
    // 运行结束后日志可能还在写入，等到最后一行出现再读取
    log: async () => {
      const file = path.join(dir, "output.log");
      await until(() => fs.existsSync(file) && fs.readFileSync(file, "utf8").includes("运行结束"));
      return fs.readFileSync(file, "utf8");
    },
  };
}

// 记录收到的请求，模拟 Selenium 删除会话的接口
function startSeleniumMock() {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end('{"value":null}');
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        requests,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

// 连接实时推送接口，持续解析收到的事件
async function openEvents(port, cookie) {
  const controller = new AbortController();
  const res = await fetch(`http://127.0.0.1:${port}/api/events`, { headers: { Cookie: cookie }, signal: controller.signal });
  const events = [];
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const closed = (async () => {
    let buffer = "";
    for (;;) {
      let chunk;
      try {
        chunk = await reader.read();
      } catch (_) {
        return;
      }
      if (chunk.done) {
        return;
      }
      buffer += decoder.decode(chunk.value, { stream: true });
      let index;
      while ((index = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        const event = { event: "", data: null, comment: false };
        for (const line of block.split("\n")) {
          if (line.startsWith(":")) {
            event.comment = true;
          } else if (line.startsWith("event: ")) {
            event.event = line.slice(7);
          } else if (line.startsWith("data: ")) {
            event.data = JSON.parse(line.slice(6));
          }
        }
        events.push(event);
      }
    }
  })();
  return { status: res.status, headers: res.headers, events, closed, close: () => controller.abort() };
}

// 简单的 HTTP 客户端：不跟随重定向，返回状态、响应头与解析后的 JSON
function client(port, basePath = "/") {
  return async function request(urlPath, { method = "GET", body, headers = {}, cookie } = {}) {
    const init = { method, redirect: "manual", headers: { ...headers } };
    if (cookie) {
      init.headers.Cookie = cookie;
    }
    if (body !== undefined) {
      init.headers["Content-Type"] = init.headers["Content-Type"] || "application/json";
      init.body = typeof body === "string" ? body : JSON.stringify(body);
    }
    const url = urlPath.startsWith("/") ? urlPath : `${basePath}${urlPath}`;
    const res = await fetch(`http://127.0.0.1:${port}${url}`, init);
    const bytes = Buffer.from(await res.arrayBuffer());
    const text = bytes.toString("utf8");
    let json = null;
    try {
      json = JSON.parse(text);
    } catch (_) {}
    return { status: res.status, headers: res.headers, text, json, bytes };
  };
}

function sessionCookie(res) {
  const header = res.headers.get("set-cookie") || "";
  const match = header.match(/wa_session=([^;]*)/);
  return match && match[1] ? `wa_session=${match[1]}` : "";
}

async function withQuietConsole(fn) {
  const original = { info: console.info, warn: console.warn, error: console.error, log: console.log };
  const logs = [];
  const capture = (...args) => logs.push(args.map(String).join(" "));
  Object.assign(console, { info: capture, warn: capture, error: capture, log: capture });
  try {
    return await fn(logs);
  } catch (error) {
    error.capturedLogs = logs;
    throw error;
  } finally {
    Object.assign(console, original);
  }
}

async function main() {
  const results = [];
  const panels = [];
  const start = async (overrides) => {
    const options = panelOptions(overrides);
    const panel = await startPanel(options);
    panels.push(panel);
    return { ...panel, options, request: client(panel.port, options.basePath) };
  };
  const login = async (panel, password, headers = {}) =>
    panel.request("api/auth/login", { method: "POST", body: { password }, headers: { ...CSRF, ...headers } });
  // 启动带固定密码的面板并登录，返回绑定了会话的接口调用函数
  const startAuthed = async (overrides = {}) => {
    const panel = await start({ password: "correct-horse", ...overrides });
    const cookie = sessionCookie(await login(panel, "correct-horse"));
    const call = (method, urlPath, body) =>
      panel.request(urlPath, {
        method,
        cookie,
        body: method === "GET" ? undefined : body || {},
        headers: method === "GET" ? {} : CSRF,
      });
    return { ...panel, cookie, call };
  };

  const scenario = async (name, fn) => {
    await withQuietConsole(fn);
    results.push(name);
    console.log(`✅ ${name}`);
  };

  try {
    await scenario("首次启动生成密码，哈希以 0600 保存；再次启动不再生成", async () => {
      const first = await start();
      assert.match(first.generatedPassword, /^[A-Za-z0-9]{16}$/);
      const file = path.join(first.options.dataDir, "panel.json");
      assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
      const stored = JSON.parse(fs.readFileSync(file, "utf8"));
      assert.match(stored.auth.passwordHash, /^scrypt\$/);
      assert.ok(!fs.readFileSync(file, "utf8").includes(first.generatedPassword), "不应保存明文密码");
      await first.close();

      const second = await start({ dataDir: first.options.dataDir });
      assert.strictEqual(second.generatedPassword, "");
      assert.strictEqual((await login(second, first.generatedPassword)).status, 204);
    });

    await scenario("已有 panel.json 权限过宽时，启动时收紧为 0600", async () => {
      const dataDir = tempDir();
      const file = path.join(dataDir, "panel.json");
      fs.writeFileSync(file, JSON.stringify({ version: 1, auth: { passwordHash: "" } }), { mode: 0o644 });
      fs.chmodSync(file, 0o644);
      await start({ dataDir, password: "correct-horse" });
      assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
    });

    await scenario("未登录：健康检查可访问，页面跳转到登录页，接口返回 401", async () => {
      const panel = await start();
      assert.deepStrictEqual((await panel.request("healthz")).json, { status: "ok" });
      const home = await panel.request("");
      assert.strictEqual(home.status, 302);
      assert.strictEqual(home.headers.get("location"), "login");
      const loginPage = await panel.request("login");
      assert.strictEqual(loginPage.status, 200);
      assert.match(loginPage.text, /面板密码/);
      assert.strictEqual((await panel.request("assets/panel.css")).status, 200);
      assert.strictEqual((await panel.request("assets/missing.js")).status, 404);
      assert.strictEqual((await panel.request("api/auth/session")).status, 401);
    });

    await scenario("登录：错误密码 401；正确密码下发 HttpOnly、SameSite=Strict 会话；退出后失效", async () => {
      const panel = await start({ password: "correct-horse" });
      assert.strictEqual((await login(panel, "wrong")).status, 401);
      const ok = await login(panel, "correct-horse");
      assert.strictEqual(ok.status, 204);
      const setCookie = ok.headers.get("set-cookie");
      assert.match(setCookie, /HttpOnly/i);
      assert.match(setCookie, /SameSite=Strict/i);
      assert.match(setCookie, /Path=\//);
      assert.doesNotMatch(setCookie, /Secure/i, "HTTP 下不应设置 Secure");
      const cookie = sessionCookie(ok);

      const session = await panel.request("api/auth/session", { cookie });
      assert.strictEqual(session.status, 200);
      assert.strictEqual(session.json.passwordFromEnv, true);
      const home = await panel.request("", { cookie });
      assert.strictEqual(home.status, 200);
      assert.match(home.text, /WeReadAssistant/);
      assert.strictEqual((await panel.request("login", { cookie })).headers.get("location"), "./");

      const logout = await panel.request("api/auth/logout", { method: "POST", headers: CSRF, cookie });
      assert.strictEqual(logout.status, 204);
      assert.strictEqual((await panel.request("api/auth/session", { cookie })).status, 401);
    });

    await scenario("修改类请求缺少自定义请求头返回 403，不是 JSON 返回 415", async () => {
      const panel = await start({ password: "correct-horse" });
      const noHeader = await panel.request("api/auth/login", { method: "POST", body: { password: "correct-horse" } });
      assert.strictEqual(noHeader.status, 403);
      const form = await panel.request("api/auth/login", {
        method: "POST",
        body: "password=correct-horse",
        headers: { ...CSRF, "Content-Type": "application/x-www-form-urlencoded" },
      });
      assert.strictEqual(form.status, 415);
      const badJson = await panel.request("api/auth/login", { method: "POST", body: "{oops", headers: CSRF });
      assert.strictEqual(badJson.status, 400);
    });

    await scenario("同一 IP 连续失败 5 次后锁定，锁定期间正确密码也返回 429，解锁后可登录", async () => {
      const panel = await start({ password: "correct-horse", limits: { lockoutBaseMs: 400 } });
      for (let i = 0; i < 4; i += 1) {
        assert.strictEqual((await login(panel, "wrong")).status, 401);
      }
      const fifth = await login(panel, "wrong");
      assert.strictEqual(fifth.status, 401);
      assert.ok(Number(fifth.headers.get("retry-after")) >= 1);
      const locked = await login(panel, "correct-horse");
      assert.strictEqual(locked.status, 429);
      assert.strictEqual(locked.json.error, "too_many_attempts");
      await new Promise((resolve) => setTimeout(resolve, 450));
      assert.strictEqual((await login(panel, "correct-horse")).status, 204);
    });

    await scenario("信任代理时按 X-Forwarded-For 区分 IP、HTTPS 下设置 Secure；不信任代理时忽略这些请求头", async () => {
      const trusted = await start({ password: "correct-horse", trustProxy: 1, limits: { lockoutBaseMs: 60000 } });
      for (let i = 0; i < 5; i += 1) {
        await login(trusted, "wrong", { "X-Forwarded-For": "203.0.113.1" });
      }
      assert.strictEqual((await login(trusted, "correct-horse", { "X-Forwarded-For": "203.0.113.1" })).status, 429);
      const other = await login(trusted, "correct-horse", { "X-Forwarded-For": "203.0.113.2", "X-Forwarded-Proto": "https" });
      assert.strictEqual(other.status, 204);
      assert.match(other.headers.get("set-cookie"), /Secure/i);

      const untrusted = await start({ password: "correct-horse", limits: { lockoutBaseMs: 60000 } });
      for (let i = 0; i < 5; i += 1) {
        await login(untrusted, "wrong", { "X-Forwarded-For": "203.0.113.1" });
      }
      // 不信任代理时伪造的 X-Forwarded-For 不起作用，仍按真实连接地址计数
      assert.strictEqual((await login(untrusted, "correct-horse", { "X-Forwarded-For": "203.0.113.9" })).status, 429);
      const plain = await start({ password: "correct-horse" });
      const ok = await login(plain, "correct-horse", { "X-Forwarded-Proto": "https" });
      assert.doesNotMatch(ok.headers.get("set-cookie"), /Secure/i);
    });

    await scenario("所有 IP 累计失败达到上限后暂停全部登录", async () => {
      const panel = await start({
        password: "correct-horse",
        trustProxy: 1,
        limits: { globalMaxFailures: 3, globalWindowMs: 500 },
      });
      for (let i = 1; i <= 3; i += 1) {
        await login(panel, "wrong", { "X-Forwarded-For": `198.51.100.${i}` });
      }
      assert.strictEqual((await login(panel, "correct-horse", { "X-Forwarded-For": "198.51.100.99" })).status, 429);
      await new Promise((resolve) => setTimeout(resolve, 550));
      assert.strictEqual((await login(panel, "correct-horse", { "X-Forwarded-For": "198.51.100.99" })).status, 204);
    });

    await scenario("部署在子路径：/weread 重定向到 /weread/，cookie 限定在该路径", async () => {
      const panel = await start({ password: "correct-horse", basePath: "/weread/" });
      const bare = await panel.request("/weread?x=1");
      assert.strictEqual(bare.status, 301);
      assert.strictEqual(bare.headers.get("location"), "/weread/?x=1");
      assert.strictEqual((await panel.request("/weread/healthz")).status, 200);
      assert.strictEqual((await panel.request("/healthz")).status, 404);
      assert.strictEqual((await panel.request("/weread/")).headers.get("location"), "login");
      const ok = await login(panel, "correct-horse");
      assert.match(ok.headers.get("set-cookie"), /Path=\/weread\//);
    });

    await scenario("修改密码后旧会话失效、旧密码不能登录；密码来自环境变量时拒绝修改", async () => {
      const panel = await start();
      const original = panel.generatedPassword;
      const cookieA = sessionCookie(await login(panel, original));
      const cookieB = sessionCookie(await login(panel, original));
      const change = (cookie, body) =>
        panel.request("api/auth/password", { method: "POST", body, headers: CSRF, cookie });

      assert.strictEqual((await change(cookieA, { current: "wrong", next: "new-password-1" })).json.error, "wrong_password");
      assert.strictEqual((await change(cookieA, { current: original, next: "short" })).json.error, "password_too_short");
      const changed = await change(cookieA, { current: original, next: "new-password-1" });
      assert.strictEqual(changed.status, 204);
      const cookieC = sessionCookie(changed);
      assert.strictEqual((await panel.request("api/auth/session", { cookie: cookieA })).status, 401);
      assert.strictEqual((await panel.request("api/auth/session", { cookie: cookieB })).status, 401);
      assert.strictEqual((await panel.request("api/auth/session", { cookie: cookieC })).status, 200);
      assert.strictEqual((await login(panel, original)).status, 401);
      assert.strictEqual((await login(panel, "new-password-1")).status, 204);

      const envPanel = await start({ password: "from-env-password" });
      const cookie = sessionCookie(await login(envPanel, "from-env-password"));
      const refused = await envPanel.request("api/auth/password", {
        method: "POST",
        body: { current: "from-env-password", next: "another-password" },
        headers: CSRF,
        cookie,
      });
      assert.strictEqual(refused.status, 409);
    });

    await scenario("并发修改密码依次处理：只有一个成功，成功者的新会话保持有效", async () => {
      const panel = await start();
      const original = panel.generatedPassword;
      const cookieA = sessionCookie(await login(panel, original));
      const cookieB = sessionCookie(await login(panel, original));
      const change = (cookie, next) =>
        panel.request("api/auth/password", { method: "POST", body: { current: original, next }, headers: CSRF, cookie });

      const [first, second] = await Promise.all([change(cookieA, "first-password-1"), change(cookieB, "second-password-2")]);
      const results = [first, second];
      const winners = results.filter((res) => res.status === 204);
      assert.strictEqual(winners.length, 1, `应只有一个请求成功，实际状态 ${results.map((res) => res.status)}`);
      const loser = results.find((res) => res.status !== 204);
      assert.strictEqual(loser.status, 400);
      assert.strictEqual(loser.json.error, "wrong_password");

      // 成功者拿到的新会话没有被另一个请求清除
      assert.strictEqual((await panel.request("api/auth/session", { cookie: sessionCookie(winners[0]) })).status, 200);
      const winningPassword = winners[0] === first ? "first-password-1" : "second-password-2";
      const losingPassword = winners[0] === first ? "second-password-2" : "first-password-1";
      assert.strictEqual((await login(panel, winningPassword)).status, 204);
      assert.strictEqual((await login(panel, losingPassword)).status, 401);
    });

    await scenario("页面与接口带安全响应头，接口禁止缓存；只有主页面允许 'unsafe-eval'", async () => {
      const panel = await start({ password: "correct-horse" });
      const page = await panel.request("login");
      const csp = page.headers.get("content-security-policy");
      assert.match(csp, /default-src 'self'/);
      assert.match(csp, /frame-ancestors 'none'/);
      assert.doesNotMatch(csp, /unsafe-inline/);
      assert.doesNotMatch(csp, /unsafe-eval/, "登录页不需要 'unsafe-eval'");
      // 主页面使用 Vue 免构建版在浏览器内编译模板
      const cookie = sessionCookie(await login(panel, "correct-horse"));
      const index = await panel.request("", { cookie });
      assert.strictEqual(index.status, 200);
      const indexCsp = index.headers.get("content-security-policy");
      assert.match(indexCsp, /script-src 'self' 'unsafe-eval'(;|$)/);
      assert.doesNotMatch(indexCsp, /unsafe-inline/);
      assert.ok(!/<script(?![^>]*\bsrc=)/i.test(index.text), "主页面不应有内联脚本");
      assert.ok(!/<style|\sstyle=/i.test(index.text), "主页面不应有内联样式");
      for (const asset of ["assets/app/main.js", "assets/vendor/vue.esm-browser.prod.js", "assets/vendor/pico.min.css", "assets/vendor/qrcode.mjs"]) {
        const res = await panel.request(asset);
        assert.strictEqual(res.status, 200, asset);
        assert.doesNotMatch(res.headers.get("content-security-policy"), /unsafe-eval/, asset);
      }
      assert.match((await panel.request("assets/app/main.js")).headers.get("content-type"), /javascript/);
      assert.match((await panel.request("assets/vendor/qrcode.mjs")).headers.get("content-type"), /javascript/, ".mjs 需要以 JavaScript 类型返回");
      assert.doesNotMatch((await panel.request("api/auth/session", { cookie })).headers.get("content-security-policy"), /unsafe-eval/);
      assert.strictEqual(page.headers.get("x-frame-options"), "DENY");
      assert.strictEqual(page.headers.get("referrer-policy"), "no-referrer");
      assert.strictEqual(page.headers.get("x-content-type-options"), "nosniff");
      assert.strictEqual(page.headers.get("x-powered-by"), null);
      assert.strictEqual((await panel.request("api/auth/session")).headers.get("cache-control"), "no-store");
    });

    await scenario("全局设置与默认配置：校验取值、整体生效或整体不生效、null 恢复默认", async () => {
      const panel = await startAuthed({ seleniumUrl: "http://selenium:4444" });
      const initial = await panel.call("GET", "api/settings");
      assert.strictEqual(initial.json.settings.timezone, "Asia/Shanghai");
      assert.strictEqual(initial.json.settings.maxConcurrentRuns, 1);
      assert.deepStrictEqual(initial.json.defaults, { seleniumUrl: "http://selenium:4444" });

      const updated = await panel.call("PATCH", "api/settings", {
        settings: { timezone: "Europe/Berlin", maxConcurrentRuns: "2" },
        defaults: { duration: 68, speed: "normal" },
      });
      assert.strictEqual(updated.status, 200);
      assert.strictEqual(updated.json.settings.timezone, "Europe/Berlin");
      assert.strictEqual(updated.json.settings.maxConcurrentRuns, 2);
      assert.strictEqual(updated.json.defaults.duration, 68);

      const invalid = [
        [{ settings: { timezone: "Mars/Base" } }, /时区不是有效的时区/],
        [{ settings: { maxConcurrentRuns: 0 } }, /同时运行的账号数 必须在 1–10 之间/],
        [{ settings: { vncUrl: "ftp://host" } }, /noVNC 地址只能是 http 或 https 地址/],
        [{ settings: { bogus: 1 } }, /未知的设置项：bogus/],
        [{ defaults: { duration: 0 } }, /阅读时长（分钟） 必须在 1–1440 之间/],
        [{ defaults: { duration: "9".repeat(400) } }, /阅读时长（分钟） 超出允许的范围/],
        [{ defaults: { selection: 9 } }, /选书方式 只能是/],
        [{ defaults: { dataDir: "/etc" } }, /未知的配置项：dataDir/],
      ];
      for (const [body, pattern] of invalid) {
        const res = await panel.call("PATCH", "api/settings", body);
        assert.strictEqual(res.status, 400, JSON.stringify(body));
        assert.match(res.json.message, pattern);
      }

      // 其中一项非法时整个请求都不生效
      const partial = await panel.call("PATCH", "api/settings", {
        settings: { timezone: "Asia/Tokyo" },
        defaults: { duration: 0 },
      });
      assert.strictEqual(partial.status, 400);
      assert.strictEqual((await panel.call("GET", "api/settings")).json.settings.timezone, "Europe/Berlin");

      const reset = await panel.call("PATCH", "api/settings", { settings: { timezone: null }, defaults: { speed: null } });
      assert.strictEqual(reset.json.settings.timezone, "Asia/Shanghai");
      assert.strictEqual(reset.json.defaults.speed, undefined);

      // SELENIUM_URL 只在首次初始化时写入，之后以面板中的设置为准
      await panel.call("PATCH", "api/settings", { defaults: { seleniumUrl: "http://custom:4444" } });
      await panel.close();
      const restarted = await startAuthed({ dataDir: panel.options.dataDir, seleniumUrl: "http://other:4444" });
      assert.strictEqual((await restarted.call("GET", "api/settings")).json.defaults.seleniumUrl, "http://custom:4444");
    });

    await scenario("账号增删改查：ID 校验、重复检测、删除时可选保留数据", async () => {
      const panel = await startAuthed();
      const accountsDir = path.join(panel.options.dataDir, "accounts");

      const created = await panel.call("POST", "api/accounts", { id: "me", name: "我" });
      assert.strictEqual(created.status, 201);
      assert.deepStrictEqual(
        { id: created.json.account.id, name: created.json.account.name, enabled: created.json.account.enabled },
        { id: "me", name: "我", enabled: true }
      );
      assert.strictEqual(created.json.account.hasCookies, false);
      assert.ok(fs.existsSync(path.join(accountsDir, "me")));

      assert.strictEqual((await panel.call("POST", "api/accounts", { id: "me" })).status, 409);
      for (const id of ["Bad_ID", "-x", "x-", "a".repeat(33), "../etc"]) {
        assert.strictEqual((await panel.call("POST", "api/accounts", { id })).status, 400, id);
      }
      assert.strictEqual((await panel.call("POST", "api/accounts", { id: "long", name: "名".repeat(33) })).status, 400);
      const defaultName = await panel.call("POST", "api/accounts", { id: "second" });
      assert.strictEqual(defaultName.json.account.name, "second");

      const list = await panel.call("GET", "api/accounts");
      assert.deepStrictEqual(list.json.accounts.map((account) => account.id), ["me", "second"]);

      const patched = await panel.call("PATCH", "api/accounts/me", { name: "小明", enabled: false });
      assert.strictEqual(patched.json.account.name, "小明");
      assert.strictEqual(patched.json.account.enabled, false);
      assert.strictEqual((await panel.call("PATCH", "api/accounts/me", { id: "other" })).status, 400);
      assert.strictEqual((await panel.call("PATCH", "api/accounts/me", { enabled: "yes" })).status, 400);
      assert.strictEqual((await panel.call("GET", "api/accounts/nobody")).status, 404);
      assert.strictEqual((await panel.call("PATCH", "api/accounts/nobody", { name: "x" })).status, 404);

      // 默认保留数据目录；重新添加同 ID 账号时沿用其中的 cookies
      fs.writeFileSync(path.join(accountsDir, "me", "cookies.json"), "[]");
      const noCsrf = await panel.request("api/accounts/me", { method: "DELETE", body: {}, cookie: panel.cookie });
      assert.strictEqual(noCsrf.status, 403);
      // deleteData 可选：不带请求体、只带自定义请求头也能删除
      const noBody = await panel.request("api/accounts/me", { method: "DELETE", headers: CSRF, cookie: panel.cookie });
      assert.strictEqual(noBody.status, 204);
      assert.strictEqual((await panel.call("GET", "api/accounts/me")).status, 404);
      assert.ok(fs.existsSync(path.join(accountsDir, "me", "cookies.json")));
      const readded = await panel.call("POST", "api/accounts", { id: "me" });
      assert.strictEqual(readded.json.account.hasCookies, true);

      assert.strictEqual((await panel.call("DELETE", "api/accounts/me", { deleteData: true })).status, 204);
      assert.ok(!fs.existsSync(path.join(accountsDir, "me")));
      assert.ok(fs.existsSync(path.join(accountsDir, "second")));
    });

    await scenario("配置合并：账号覆盖 > 全局默认 > 内置默认，数据目录等由面板按账号设置", async () => {
      const panel = await startAuthed();
      await panel.call("PATCH", "api/settings", { defaults: { duration: 68, speed: "normal" } });
      await panel.call("POST", "api/accounts", { id: "me", name: "小明" });
      await panel.call("PATCH", "api/accounts/me", { overrides: { speed: "fast", selection: "-1" } });

      const detail = await panel.call("GET", "api/accounts/me");
      assert.deepStrictEqual(detail.json.account.overrides, { speed: "fast", selection: -1 });
      const effective = detail.json.effective;
      assert.strictEqual(effective.duration, 68, "继承全局默认");
      assert.strictEqual(effective.speed, "fast", "账号覆盖优先");
      assert.strictEqual(effective.selection, -1);
      assert.strictEqual(effective.loginTimeout, 15, "内置默认");
      for (const key of ["dataDir", "profileName", "accountName"]) {
        assert.ok(!(key in effective), `${key} 不应出现在接口中`);
      }
      assert.strictEqual((await panel.call("PATCH", "api/accounts/me", { overrides: { duration: "abc" } })).status, 400);

      await panel.call("PATCH", "api/accounts/me", { overrides: { speed: null } });
      assert.strictEqual((await panel.call("GET", "api/accounts/me")).json.effective.speed, "normal");

      const data = JSON.parse(fs.readFileSync(path.join(panel.options.dataDir, "panel.json"), "utf8"));
      const config = resolveAccountConfig(data, data.accounts[0], panel.options.dataDir);
      assert.strictEqual(config.dataDir, path.join(path.resolve(panel.options.dataDir), "accounts", "me"));
      assert.strictEqual(config.profileName, "me");
      assert.strictEqual(config.accountName, "小明");
    });

    await scenario("密钥只写不读：接口只返回掩码，掩码或空字符串不修改，null 清除", async () => {
      const panel = await startAuthed();
      const responses = [];
      const call = async (...args) => {
        const res = await panel.call(...args);
        responses.push(res.text);
        return res;
      };
      const secrets = ["bark-secret-123", "ntfy-token-456", "mail-pass-789"];
      const file = path.join(panel.options.dataDir, "panel.json");
      const stored = () => JSON.parse(fs.readFileSync(file, "utf8"));

      const set = await call("PATCH", "api/settings", { defaults: { barkKey: secrets[0], ntfyToken: secrets[1], ntfyServer: "https://ntfy.example" } });
      assert.strictEqual(set.json.defaults.barkKey, SECRET_MASK);
      assert.strictEqual(set.json.defaults.ntfyServer, "https://ntfy.example", "非密钥字段原样返回");
      await call("POST", "api/accounts", { id: "me" });
      await call("PATCH", "api/accounts/me", { overrides: { emailPass: secrets[2] } });
      const detail = await call("GET", "api/accounts/me");
      assert.strictEqual(detail.json.account.overrides.emailPass, SECRET_MASK);
      assert.strictEqual(detail.json.effective.emailPass, SECRET_MASK);
      assert.strictEqual(detail.json.effective.barkKey, SECRET_MASK);
      assert.strictEqual(detail.json.effective.ntfyTopic, "", "未设置的密钥返回空字符串");
      await call("GET", "api/settings");
      await call("GET", "api/accounts");
      await call("GET", "api/schema");

      assert.strictEqual(stored().defaults.barkKey, secrets[0]);
      await call("PATCH", "api/settings", { defaults: { barkKey: SECRET_MASK, ntfyToken: "" } });
      assert.strictEqual(stored().defaults.barkKey, secrets[0], "提交掩码不修改");
      assert.strictEqual(stored().defaults.ntfyToken, secrets[1], "提交空字符串不修改");
      await call("PATCH", "api/settings", { defaults: { barkKey: null } });
      assert.ok(!("barkKey" in stored().defaults), "null 清除");

      for (const text of responses) {
        for (const secret of secrets) {
          assert.ok(!text.includes(secret), `接口响应中出现了密钥 ${secret}`);
        }
      }
    });

    await scenario("配置接口需要登录；schema 不包含面板管理的配置项", async () => {
      const panel = await startAuthed();
      for (const urlPath of ["api/schema", "api/settings", "api/accounts", "api/accounts/me"]) {
        assert.strictEqual((await panel.request(urlPath)).status, 401, urlPath);
      }
      const schema = (await panel.call("GET", "api/schema")).json;
      const keys = schema.fields.map((field) => field.key);
      assert.ok(keys.includes("duration") && keys.includes("barkKey"));
      for (const key of ["dataDir", "profileName", "accountName"]) {
        assert.ok(!keys.includes(key), key);
      }
      assert.strictEqual(schema.fields.find((field) => field.key === "barkKey").secret, true);
      assert.deepStrictEqual(
        schema.settingsFields.map((field) => field.key),
        ["timezone", "maxConcurrentRuns", "logRetentionDays", "screenshotRetentionRuns", "vncUrl"]
      );
    });

    await scenario("只有 auth 的旧 panel.json 启动时自动补齐结构并保留密码", async () => {
      const dataDir = tempDir();
      const file = path.join(dataDir, "panel.json");
      fs.writeFileSync(file, JSON.stringify({ version: 1, auth: { passwordHash: await hashPassword("old-password") } }), { mode: 0o600 });
      const panel = await start({ dataDir, seleniumUrl: "http://selenium:4444" });
      assert.strictEqual(panel.generatedPassword, "");
      assert.strictEqual((await login(panel, "old-password")).status, 204);
      const upgraded = JSON.parse(fs.readFileSync(file, "utf8"));
      assert.deepStrictEqual(Object.keys(upgraded), ["version", "auth", "settings", "defaults", "accounts"]);
      assert.deepStrictEqual(upgraded.defaults, { seleniumUrl: "http://selenium:4444" });
      assert.deepStrictEqual(upgraded.accounts, []);
    });

    await scenario("同一数据目录只能运行一个面板；关闭后释放", async () => {
      const first = await start();
      const lockFile = path.join(first.options.dataDir, "panel.lock");
      assert.ok(fs.existsSync(lockFile));
      await assert.rejects(start({ dataDir: first.options.dataDir }), /另一个面板实例.*正在使用数据目录/);
      await first.close();
      assert.ok(!fs.existsSync(lockFile), "关闭后应删除锁文件");
      const second = await start({ dataDir: first.options.dataDir });
      assert.strictEqual(second.generatedPassword, "");
    });

    await scenario("遗留的锁文件：进程已不存在或心跳过期时接管，其他主机心跳正常时拒绝", async () => {
      const lockAt = (dataDir) => path.join(dataDir, "panel.lock");
      const write = (dataDir, info) => fs.writeFileSync(lockAt(dataDir), JSON.stringify(info));

      const deadProcess = tempDir();
      write(deadProcess, { pid: 2 ** 22 + 12345, hostname: os.hostname(), startedAt: "2026-01-01T00:00:00.000Z" });
      await start({ dataDir: deadProcess });

      const otherHost = tempDir();
      write(otherHost, { pid: 1, hostname: "another-container", startedAt: "2026-01-01T00:00:00.000Z" });
      await assert.rejects(start({ dataDir: otherHost }), /主机 another-container，进程 1/);
      const old = new Date(Date.now() - 60000);
      fs.utimesSync(lockAt(otherHost), old, old);
      await start({ dataDir: otherHost });

      const corrupt = tempDir();
      fs.writeFileSync(lockAt(corrupt), "{broken");
      await start({ dataDir: corrupt });
    });

    await scenario("运行：子进程经 IPC 收到账号配置，按事件更新状态，日志与运行记录写入运行目录；子进程只继承白名单环境变量", async () => {
      // 面板所在环境中的密钥与运行配置变量都不应传给子进程
      const leaking = {
        PANEL_SMOKE_SECRET: "panel-secret",
        BARK_KEY: "env-bark-key",
        NTFY_TOKEN: "env-ntfy-token",
        EMAIL_PASS: "env-email-pass",
        WEREAD_DURATION: "5",
        SOME_API_TOKEN: "env-api-token",
      };
      Object.assign(process.env, leaking);
      try {
        const panel = await startAuthed();
        await panel.call("PATCH", "api/settings", { defaults: { barkKey: "secret-bark-key" } });
        await panel.call("POST", "api/accounts", { id: "ok-1", name: "测试" });
        const statuses = [];
        const unsubscribe = panel.runner.subscribe((type, run) => {
          if (type === "run" && statuses[statuses.length - 1] !== run.status) {
            statuses.push(run.status);
          }
        });
        const finished = nextRun(panel, ended("ok-1"));
        const res = await panel.call("POST", "api/accounts/ok-1/runs");
        assert.strictEqual(res.status, 202);
        assert.strictEqual(res.json.run.mode, "read");
        assert.strictEqual(res.json.run.trigger, "manual");
        assert.strictEqual(res.json.run.accountName, "测试");
        const run = await finished;
        unsubscribe();
        assert.deepStrictEqual(statuses, ["queued", "starting", "reading", "success"]);
        assert.strictEqual(run.minutes, 2);
        assert.strictEqual(run.book, "测试书");
        assert.strictEqual(run.screenshot, "screenshot-2.png");
        assert.match(run.id, /^\d{8}T\d{9}Z-[0-9a-f]{4}$/);

        const files = runFiles(panel, "ok-1", run.id);
        const log = await files.log();
        const meta = files.meta();
        assert.strictEqual(meta.status, "success");
        assert.strictEqual(meta.exitCode, 0);
        assert.strictEqual(meta.minutes, 2);
        assert.ok(!("loginUrl" in meta));
        assert.match(log, /\[PANEL\]\[[^\]]+\]: 加入队列：手动触发，阅读/);
        assert.match(log, /Reading minute: 2/);
        assert.ok(log.includes(`dataDir=${path.join(panel.options.dataDir, "accounts", "ok-1")}`), "子进程应收到账号的数据目录");
        const envKeys = JSON.parse(log.match(/环境变量: (\[.*\])/)[1]);
        assert.ok(envKeys.includes("PATH"), "子进程应保留 PATH");
        for (const key of Object.keys(leaking)) {
          assert.ok(!envKeys.includes(key), `子进程环境变量中不应有 ${key}`);
        }
        // NODE_CHANNEL_* 由 Node 为 IPC 添加
        const unexpected = envKeys.filter(
          (key) => !CHILD_ENV_KEYS.has(key) && !key.startsWith("LC_") && !key.startsWith("NODE_CHANNEL_")
        );
        assert.deepStrictEqual(unexpected, [], "子进程只继承白名单中的环境变量");
        for (const [key, value] of Object.entries(leaking)) {
          if (key !== "WEREAD_DURATION") {
            assert.ok(!log.includes(value), `日志中不应出现 ${key} 的值`);
          }
        }
        assert.match(log, /barkKey 已下发: true/, "密钥经 IPC 下发");
        assert.ok(!log.includes("secret-bark-key"));
        // 子进程打印的密钥值与登录链接中的 uid 在写入日志前替换为掩码
        assert.ok(
          log.includes(`模拟泄露: https://api.day.app/${SECRET_MASK} https://weread.qq.com/web/confirm?uid=${SECRET_MASK}&from=stub`),
          "日志中的密钥与登录链接应替换为掩码"
        );
        assert.ok(!log.includes("ok-1-uid"));

        const viewed = await panel.call("GET", `api/accounts/ok-1/runs/${run.id}/log`);
        assert.strictEqual(viewed.status, 200);
        assert.match(viewed.headers.get("content-type"), /^text\/plain; charset=utf-8/);
        assert.strictEqual(viewed.headers.get("content-disposition"), null);
        assert.ok(viewed.text.includes("运行结束：成功"));
        const download = await panel.call("GET", `api/accounts/ok-1/runs/${run.id}/log?download=1`);
        assert.match(download.headers.get("content-disposition"), new RegExp(`attachment; filename="ok-1-${run.id}.log"`));
        for (const bad of ["../../panel.json", "20261015T000000Z-zzzz", "nope"]) {
          assert.strictEqual((await panel.call("GET", `api/accounts/ok-1/runs/${encodeURIComponent(bad)}/log`)).status, 404, bad);
        }
        assert.strictEqual((await panel.request(`api/accounts/ok-1/runs/${run.id}/log`)).status, 401);
        assert.deepStrictEqual((await panel.call("GET", "api/runs")).json.runs, []);
      } finally {
        for (const key of Object.keys(leaking)) {
          delete process.env[key];
        }
      }
    });

    await scenario("队列：同一账号不能重复运行；按并发数依次启动，调大并发数后立即启动排队中的运行；可取消排队", async () => {
      const panel = await startAuthed();
      for (const id of ["slow-a", "slow-b", "slow-c", "off-1"]) {
        await panel.call("POST", "api/accounts", { id });
      }
      await panel.call("PATCH", "api/accounts/off-1", { enabled: false });

      const a = await panel.call("POST", "api/accounts/slow-a/runs");
      assert.strictEqual(a.json.run.status, "starting");
      const again = await panel.call("POST", "api/accounts/slow-a/runs", { mode: "login" });
      assert.strictEqual(again.status, 409);
      assert.strictEqual(again.json.error, "run_active");
      assert.strictEqual((await panel.call("POST", "api/accounts/slow-b/runs")).json.run.status, "queued");
      assert.strictEqual((await panel.call("POST", "api/accounts/slow-c/runs")).json.run.status, "queued");
      assert.strictEqual((await panel.call("POST", "api/accounts/off-1/runs")).json.error, "account_disabled");
      assert.strictEqual((await panel.call("POST", "api/accounts/nobody/runs")).status, 404);
      assert.strictEqual((await panel.call("POST", "api/accounts/off-1/runs", { mode: "fast" })).status, 400);
      assert.strictEqual((await panel.call("POST", "api/accounts/off-1/runs", { mode: "read", x: 1 })).status, 400);
      assert.strictEqual((await panel.request("api/accounts/slow-c/runs", { method: "POST", cookie: panel.cookie })).status, 403);

      const listed = (await panel.call("GET", "api/runs")).json.runs;
      assert.deepStrictEqual(listed.map((run) => [run.accountId, run.status]), [
        ["slow-a", "starting"],
        ["slow-b", "queued"],
        ["slow-c", "queued"],
      ]);
      assert.ok(listed[1].log.some((line) => line.includes("加入队列")));

      const cancelled = await panel.call("POST", "api/accounts/slow-c/stop");
      assert.strictEqual(cancelled.status, 202);
      assert.strictEqual(cancelled.json.run.status, "stopped");
      assert.match(await runFiles(panel, "slow-c", cancelled.json.run.id).log(), /已取消排队/);

      const bStarted = nextRun(panel, (run) => run.accountId === "slow-b" && run.status === "starting");
      await panel.call("PATCH", "api/settings", { settings: { maxConcurrentRuns: 2 } });
      await bStarted;

      const stopped = Promise.all([nextRun(panel, ended("slow-a")), nextRun(panel, ended("slow-b"))]);
      await panel.call("POST", "api/accounts/slow-a/stop");
      await panel.call("POST", "api/accounts/slow-b/stop");
      assert.deepStrictEqual((await stopped).map((run) => run.status), ["stopped", "stopped"]);
      assert.deepStrictEqual((await panel.call("GET", "api/runs")).json.runs, []);
    });

    await scenario("失败：上报错误、等待扫码超时、未上报结果就退出都记为失败；错误信息中的密钥替换为掩码", async () => {
      const panel = await startAuthed();
      // 桩子进程上报的错误信息中带有 Bark Key
      await panel.call("PATCH", "api/settings", { settings: { maxConcurrentRuns: 3 }, defaults: { barkKey: "fail-secret-key" } });
      const ids = ["fail-1", "timeout-1", "crash-1"];
      const finished = Promise.all(ids.map((id) => nextRun(panel, ended(id))));
      for (const id of ids) {
        await panel.call("POST", "api/accounts", { id });
        assert.strictEqual((await panel.call("POST", `api/accounts/${id}/runs`)).status, 202);
      }
      const [fail, timeout, crash] = await finished;
      assert.deepStrictEqual([fail.status, fail.error], ["failed", `模拟的页面错误 ${SECRET_MASK}`]);
      assert.strictEqual(runFiles(panel, "fail-1", fail.id).meta().error, `模拟的页面错误 ${SECRET_MASK}`);
      assert.deepStrictEqual([timeout.status, timeout.error], ["failed", "等待扫码超时"]);
      assert.deepStrictEqual([crash.status, crash.error], ["failed", "阅读子进程异常退出（退出码 3）"]);
      assert.strictEqual(runFiles(panel, "crash-1", crash.id).meta().exitCode, 3);
    });

    await scenario("停止：子进程收到 SIGTERM 后退出记为已停止；不响应时超时强制结束并删除 Selenium 会话", async () => {
      const selenium = await startSeleniumMock();
      try {
        const panel = await startAuthed();
        await panel.call("PATCH", "api/settings", {
          settings: { maxConcurrentRuns: 2 },
          defaults: { seleniumUrl: selenium.url },
        });
        const reading = Promise.all(
          ["slow-1", "stubborn-1"].map((id) => nextRun(panel, (run) => run.accountId === id && run.status === "reading"))
        );
        for (const id of ["slow-1", "stubborn-1"]) {
          await panel.call("POST", "api/accounts", { id });
          await panel.call("POST", `api/accounts/${id}/runs`);
        }
        await reading;

        const slowEnded = nextRun(panel, ended("slow-1"));
        const stopping = await panel.call("POST", "api/accounts/slow-1/stop");
        assert.strictEqual(stopping.status, 202);
        assert.strictEqual(stopping.json.run.stopRequested, true);
        const slow = await slowEnded;
        assert.strictEqual(slow.status, "stopped");
        assert.match(await runFiles(panel, "slow-1", slow.id).log(), /收到 SIGTERM，关闭浏览器/);

        const stubbornEnded = nextRun(panel, ended("stubborn-1"));
        await panel.call("POST", "api/accounts/stubborn-1/stop");
        const stubborn = await stubbornEnded;
        assert.strictEqual(stubborn.status, "stopped");
        const files = runFiles(panel, "stubborn-1", stubborn.id);
        assert.strictEqual(files.meta().exitSignal, "SIGKILL");
        const log = await files.log();
        assert.match(log, /忽略 SIGTERM/);
        assert.match(log, /秒内未退出，强制结束/);
        assert.match(log, /已请求 Selenium 删除会话 stub-session-stubborn-1/);
        // 正常退出的子进程自己关闭了浏览器，不需要删除会话
        assert.deepStrictEqual(selenium.requests, ["DELETE /session/stub-session-stubborn-1"]);

        const idle = await panel.call("POST", "api/accounts/slow-1/stop");
        assert.strictEqual(idle.status, 404);
        assert.strictEqual(idle.json.error, "run_not_active");
      } finally {
        await selenium.close();
      }
    });

    await scenario("仅登录：等待扫码时提供登录链接，登录后清除；运行记录不保存登录链接", async () => {
      const panel = await startAuthed();
      await panel.call("POST", "api/accounts", { id: "login-1" });
      const waiting = nextRun(panel, (run) => run.accountId === "login-1" && run.status === "waiting-login");
      const finished = nextRun(panel, ended("login-1"));
      const res = await panel.call("POST", "api/accounts/login-1/runs", { mode: "login" });
      assert.strictEqual(res.json.run.mode, "login");
      assert.strictEqual((await waiting).loginUrl, "https://weread.qq.com/web/confirm?uid=login-1");
      const run = await finished;
      assert.strictEqual(run.status, "success");
      assert.strictEqual(run.loginUrl, "");
      assert.strictEqual(run.plannedMinutes, 0);
      const files = runFiles(panel, "login-1", run.id);
      await files.log();
      assert.ok(!fs.readFileSync(path.join(files.dir, "meta.json"), "utf8").includes("confirm?uid"));
    });

    await scenario("超过运行时长上限时结束子进程并记为失败", async () => {
      const panel = await startAuthed({ runner: { workerPath: STUB_WORKER, killTimeoutMs: 500, runTimeoutMs: 300 } });
      await panel.call("POST", "api/accounts", { id: "hang-1" });
      const finished = nextRun(panel, ended("hang-1"));
      await panel.call("POST", "api/accounts/hang-1/runs");
      const run = await finished;
      assert.deepStrictEqual([run.status, run.error], ["failed", "运行超时，已强制结束"]);
    });

    await scenario("面板停止时进行中与排队中的运行记为中断；启动时把遗留的进行中记录标为中断", async () => {
      const panel = await startAuthed();
      const reading = nextRun(panel, (run) => run.accountId === "slow-1" && run.status === "reading");
      for (const id of ["slow-1", "slow-2"]) {
        await panel.call("POST", "api/accounts", { id });
      }
      const first = (await panel.call("POST", "api/accounts/slow-1/runs")).json.run;
      const second = (await panel.call("POST", "api/accounts/slow-2/runs")).json.run;
      await reading;
      await panel.close();
      const firstMeta = runFiles(panel, "slow-1", first.id).meta();
      assert.deepStrictEqual([firstMeta.status, firstMeta.error], ["interrupted", "面板停止时运行被中断"]);
      const secondMeta = runFiles(panel, "slow-2", second.id).meta();
      assert.deepStrictEqual([secondMeta.status, secondMeta.error], ["interrupted", "面板停止时仍在排队"]);

      // 断电等情况下面板来不及处理，记录停留在进行中
      const leftover = runFiles(panel, "slow-1", "20261001T000000Z-abcd");
      fs.mkdirSync(leftover.dir, { recursive: true });
      fs.writeFileSync(path.join(leftover.dir, "meta.json"), JSON.stringify({ id: "20261001T000000Z-abcd", status: "reading", minutes: 7 }));
      fs.writeFileSync(path.join(leftover.dir, "output.log"), "");
      await start({ dataDir: panel.options.dataDir, password: "correct-horse" });
      const meta = leftover.meta();
      assert.deepStrictEqual([meta.status, meta.minutes], ["interrupted", 7]);
      assert.ok(meta.endedAt);
      assert.match(fs.readFileSync(path.join(leftover.dir, "output.log"), "utf8"), /标记为中断/);
      assert.strictEqual(runFiles(panel, "slow-1", first.id).meta().error, "面板停止时运行被中断", "已结束的记录不应改动");
    });

    await scenario("实时推送：需要登录；连接后先收到完整状态，之后收到运行状态与日志；会话失效后断开", async () => {
      const panel = await startAuthed();
      assert.strictEqual((await panel.request("api/events")).status, 401);
      await panel.call("POST", "api/accounts", { id: "ok-1" });

      const stream = await openEvents(panel.port, panel.cookie);
      assert.strictEqual(stream.status, 200);
      assert.match(stream.headers.get("content-type"), /^text\/event-stream/);
      assert.strictEqual(stream.headers.get("cache-control"), "no-cache");
      assert.strictEqual(stream.headers.get("x-accel-buffering"), "no");
      await until(() => stream.events.some((event) => event.event === "snapshot"));
      assert.deepStrictEqual(stream.events.find((event) => event.event === "snapshot").data, { runs: [] });

      await panel.call("POST", "api/accounts/ok-1/runs");
      await until(() => stream.events.some((event) => event.event === "run" && event.data.status === "success"));
      await until(() => stream.events.some((event) => event.event === "log" && event.data.line.includes("Reading minute: 2")));
      const logEvent = stream.events.find((event) => event.event === "log");
      assert.strictEqual(logEvent.data.accountId, "ok-1");
      const leak = stream.events.find((event) => event.event === "log" && event.data.line.includes("模拟泄露"));
      assert.ok(leak && !leak.data.line.includes("ok-1-uid") && leak.data.line.includes(`uid=${SECRET_MASK}`), "推送的日志同样替换掩码");
      await until(() => stream.events.some((event) => event.comment), { message: "没有收到心跳" });

      // 进行中的运行带最近的日志，供中途连接时显示
      await panel.call("POST", "api/accounts", { id: "slow-1" });
      const reading = nextRun(panel, (run) => run.accountId === "slow-1" && run.status === "reading");
      await panel.call("POST", "api/accounts/slow-1/runs");
      await reading;
      const late = await openEvents(panel.port, panel.cookie);
      await until(() => late.events.some((event) => event.event === "snapshot"));
      const [snapshotRun] = late.events.find((event) => event.event === "snapshot").data.runs;
      assert.strictEqual(snapshotRun.status, "reading");
      assert.ok(snapshotRun.log.some((line) => line.includes("启动阅读子进程")));

      assert.strictEqual((await panel.call("POST", "api/auth/logout")).status, 204);
      await Promise.race([
        Promise.all([stream.closed, late.closed]),
        new Promise((_, reject) => setTimeout(() => reject(new Error("退出登录后推送连接没有断开")), 3000)),
      ]);
      const finished = nextRun(panel, ended("slow-1"));
      panel.runner.stop("slow-1");
      await finished;
    });

    await scenario("实时推送：退出登录、修改密码时立即断开，不等心跳；其他会话的连接不受退出登录影响", async () => {
      // 心跳间隔设得很长，确保断开来自会话结束而不是心跳检查
      // 密码来自环境变量时不能修改，这里使用首次启动生成的密码
      const panel = await start({ sseHeartbeatMs: 60000 });
      const password = panel.generatedPassword;
      const myCookie = sessionCookie(await login(panel, password));
      const other = sessionCookie(await login(panel, password));
      const mine = await openEvents(panel.port, myCookie);
      const theirs = await openEvents(panel.port, other);
      await until(() => mine.events.length > 0 && theirs.events.length > 0);
      const closedWithin = (stream, ms, message) =>
        Promise.race([
          stream.closed,
          new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms)),
        ]);
      let theirsClosed = false;
      theirs.closed.then(() => {
        theirsClosed = true;
      });

      const logout = await panel.request("api/auth/logout", { method: "POST", cookie: myCookie, headers: CSRF });
      assert.strictEqual(logout.status, 204);
      await closedWithin(mine, 1000, "退出登录后推送连接没有立即断开");
      await new Promise((resolve) => setTimeout(resolve, 200));
      assert.strictEqual(theirsClosed, false, "其他会话的连接不应断开");

      const changed = await panel.request("api/auth/password", {
        method: "POST",
        cookie: other,
        headers: CSRF,
        body: { current: password, next: "battery-staple" },
      });
      assert.strictEqual(changed.status, 204);
      await closedWithin(theirs, 1000, "修改密码后旧会话的推送连接没有立即断开");

      // 会话已失效时直接返回 401，不建立连接
      assert.strictEqual((await panel.request("api/events", { cookie: other })).status, 401);
    });

    await scenario("测试通知：按账号或全局默认配置向已配置的渠道发送，不受事件开关影响", async () => {
      const requests = [];
      const ntfy = http.createServer((req, res) => {
        let body = "";
        req.on("data", (chunk) => {
          body += chunk;
        });
        req.on("end", () => {
          requests.push(JSON.parse(body));
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end("{}");
        });
      });
      await new Promise((resolve) => ntfy.listen(0, "127.0.0.1", resolve));
      try {
        const panel = await startAuthed();
        await panel.call("POST", "api/accounts", { id: "me", name: "小明" });
        assert.deepStrictEqual((await panel.call("POST", "api/notifications/test")).json, { results: [] }, "没有配置渠道");

        const server = `http://127.0.0.1:${ntfy.address().port}`;
        await panel.call("PATCH", "api/accounts/me", {
          overrides: { ntfyTopic: "smoke_topic", ntfyServer: server, notifyOnDone: false, notifyOnFailure: false, emailEnabled: true },
        });
        const result = await panel.call("POST", "api/notifications/test", { accountId: "me" });
        assert.deepStrictEqual(result.json.results, [{ channel: "ntfy", ok: true }, { channel: "email", ok: false }], "邮件缺少 SMTP 配置时为失败");
        assert.strictEqual(requests.length, 1);
        assert.strictEqual(requests[0].title, "WeReadAssistant · 小明 · 测试通知");
        assert.match(requests[0].message, /测试通知/);

        await panel.call("PATCH", "api/settings", { defaults: { ntfyTopic: "global_topic", ntfyServer: server } });
        assert.deepStrictEqual((await panel.call("POST", "api/notifications/test")).json.results, [{ channel: "ntfy", ok: true }]);
        assert.strictEqual(requests[1].title, "WeReadAssistant · 测试通知", "全局默认配置没有账号名称");
        assert.strictEqual(requests[1].topic, "global_topic");

        assert.strictEqual((await panel.call("POST", "api/notifications/test", { accountId: "nobody" })).status, 404);
        assert.strictEqual((await panel.request("api/notifications/test", { method: "POST", cookie: panel.cookie })).status, 403);
      } finally {
        await new Promise((resolve) => ntfy.close(resolve));
      }
    });

    await scenario("删除账号：运行或排队时拒绝；同时删除数据时一并删除运行记录", async () => {
      const panel = await startAuthed();
      await panel.call("POST", "api/accounts", { id: "slow-1" });
      await panel.call("POST", "api/accounts/slow-1/runs");
      const busy = await panel.call("DELETE", "api/accounts/slow-1");
      assert.strictEqual(busy.status, 409);
      assert.strictEqual(busy.json.error, "account_busy");
      const finished = nextRun(panel, ended("slow-1"));
      await panel.call("POST", "api/accounts/slow-1/stop");
      await finished;
      const runsDir = path.join(panel.options.dataDir, "runs", "slow-1");
      assert.ok(fs.existsSync(runsDir));
      assert.strictEqual((await panel.call("DELETE", "api/accounts/slow-1", { deleteData: true })).status, 204);
      assert.ok(!fs.existsSync(runsDir));
      assert.ok(!fs.existsSync(path.join(panel.options.dataDir, "accounts", "slow-1")));
    });

    await scenario("调度规则：换算为 cron 表达式，按面板时区计算接下来的触发时间（含夏令时）", async () => {
      const from = new Date("2026-10-16T00:00:00Z");
      const [daily, interval, hourly, cron] = normalizeSchedules([
        { type: "daily", times: ["18:30", "06:00", "06:00"] },
        { type: "interval", hours: 6, minute: 30 },
        { type: "interval", hours: 1 },
        { type: "cron", expression: "  30 6 *  * 1-5 " },
      ]);
      assert.deepStrictEqual(daily.times, ["06:00", "18:30"], "时间去重并排序");
      assert.deepStrictEqual(schedulePatterns(daily), ["0 6 * * *", "30 18 * * *"]);
      assert.deepStrictEqual(schedulePatterns(interval), ["30 */6 * * *"]);
      assert.deepStrictEqual([hourly.minute, schedulePatterns(hourly)], [0, ["0 * * * *"]]);
      assert.deepStrictEqual(schedulePatterns(cron), ["30 6 * * 1-5"]);
      assert.ok([daily, interval, hourly, cron].every((rule) => /^[0-9a-f]{6}$/.test(rule.id) && rule.enabled));

      // 上海时间：每天 06:00、18:30 合并排序
      assert.deepStrictEqual(nextRuns(daily, { timezone: "Asia/Shanghai", from, count: 3 }), [
        "2026-10-16T10:30:00.000Z",
        "2026-10-16T22:00:00.000Z",
        "2026-10-17T10:30:00.000Z",
      ]);
      // 每 6 小时从 00:30 起：上海时间 12:30、18:30、00:30、06:30
      assert.deepStrictEqual(nextRuns(interval, { timezone: "Asia/Shanghai", from, count: 4 }), [
        "2026-10-16T04:30:00.000Z",
        "2026-10-16T10:30:00.000Z",
        "2026-10-16T16:30:00.000Z",
        "2026-10-16T22:30:00.000Z",
      ]);
      // 纽约 2026-03-08 开始夏令时：每天 06:00 对应的 UTC 时间从 11:00 变为 10:00
      const sixAm = normalizeSchedules([{ type: "daily", times: ["06:00"] }])[0];
      assert.deepStrictEqual(nextRuns(sixAm, { timezone: "America/New_York", from: new Date("2026-03-06T12:00:00Z"), count: 3 }), [
        "2026-03-07T11:00:00.000Z",
        "2026-03-08T10:00:00.000Z",
        "2026-03-09T10:00:00.000Z",
      ]);
      // 周一至周五：2026-10-17、18 是周末
      assert.deepStrictEqual(nextRuns(cron, { timezone: "Asia/Shanghai", from: new Date("2026-10-16T12:00:00Z"), count: 2 }), [
        "2026-10-18T22:30:00.000Z",
        "2026-10-19T22:30:00.000Z",
      ]);
      assert.strictEqual(describeSchedule(daily), "每天 06:00、18:30");
      assert.strictEqual(describeSchedule(interval), "每 6 小时（从 00:30 起）");
    });

    await scenario("调度接口：校验规则、保存后返回接下来的触发时间、预览不保存", async () => {
      const panel = await startAuthed();
      await panel.call("POST", "api/accounts", { id: "me" });
      const put = (schedules) => panel.call("PUT", "api/accounts/me/schedules", { schedules });

      const invalid = [
        [{ type: "weekly" }, /类型只能是 daily、interval、cron/],
        [{ type: "daily", times: [] }, /需要 1–24 个时间/],
        [{ type: "daily", times: ["6:00"] }, /时间格式应为 HH:MM/],
        [{ type: "daily", times: ["24:00"] }, /时间格式应为 HH:MM/],
        [{ type: "interval", hours: 5 }, /间隔小时数只能是 1、2、3、4、6、8、12：5/],
        [{ type: "interval", hours: 6, minute: 60 }, /分钟必须是 0–59 的整数/],
        [{ type: "cron", expression: "0 6 * *" }, /必须是 5 段/],
        [{ type: "cron", expression: "*/5 * * * * *" }, /必须是 5 段/],
        [{ type: "cron", expression: "@daily" }, /必须是 5 段/],
        [{ type: "cron", expression: "61 * * * *" }, /cron 表达式无效/],
        [{ type: "cron", expression: "0 0 30 2 *" }, /不会触发/],
        [{ type: "daily", times: ["06:00"], extra: 1 }, /不支持的字段：extra/],
        [{ type: "daily", times: ["06:00"], enabled: "yes" }, /enabled 必须是 true 或 false/],
        [{ type: "daily", times: ["06:00"], id: "Bad ID" }, /ID 只能包含小写字母与数字/],
      ];
      for (const [rule, pattern] of invalid) {
        const res = await put([{ type: "daily", times: ["07:00"] }, rule]);
        assert.strictEqual(res.status, 400, JSON.stringify(rule));
        assert.match(res.json.message, /^第 2 条规则/);
        assert.match(res.json.message, pattern);
      }
      assert.strictEqual((await put("daily")).status, 400);
      assert.match((await put(Array.from({ length: 11 }, () => ({ type: "interval", hours: 1 })))).json.message, /最多 10 条/);
      assert.strictEqual((await panel.call("PUT", "api/accounts/me/schedules", { schedules: [], x: 1 })).status, 400);
      assert.deepStrictEqual((await panel.call("GET", "api/accounts/me/schedules")).json.schedules, [], "校验失败时不保存");

      const saved = await put([
        { id: "morning", type: "daily", times: ["06:00"] },
        { type: "interval", hours: 8, minute: 15, enabled: false },
        { id: "morning", type: "cron", expression: "0 12 * * *" },
      ]);
      assert.strictEqual(saved.status, 200);
      assert.strictEqual(saved.json.timezone, "Asia/Shanghai");
      const [morning, off, noon] = saved.json.schedules;
      assert.strictEqual(morning.id, "morning", "保留提交的 ID");
      assert.ok(noon.id !== "morning" && /^[0-9a-f]{6}$/.test(noon.id), "重复的 ID 重新分配");
      assert.strictEqual(morning.description, "每天 06:00");
      assert.strictEqual(morning.nextRuns.length, 5);
      assert.ok(morning.nextRuns.every((time) => new Date(time).getUTCHours() === 22 && Date.parse(time) > Date.now()));
      assert.deepStrictEqual(off.nextRuns, [], "停用的规则没有触发时间");
      assert.strictEqual(saved.json.nextRunAt, [morning.nextRuns[0], noon.nextRuns[0]].sort()[0]);

      const account = (await panel.call("GET", "api/accounts/me")).json.account;
      assert.deepStrictEqual(account.schedules.map((rule) => rule.id), ["morning", off.id, noon.id]);
      assert.strictEqual(account.nextRunAt, saved.json.nextRunAt);
      await panel.call("PATCH", "api/accounts/me", { enabled: false });
      assert.strictEqual((await panel.call("GET", "api/accounts/me/schedules")).json.nextRunAt, null, "停用的账号没有下一次运行");

      const preview = await panel.call("POST", "api/schedules/preview", { schedules: [{ type: "daily", times: ["23:59"] }] });
      assert.strictEqual(preview.status, 200);
      assert.strictEqual(preview.json.schedules[0].nextRuns.length, 5);
      assert.strictEqual((await panel.call("POST", "api/schedules/preview", { schedules: [{ type: "interval", hours: 7 }] })).status, 400);
      assert.strictEqual((await panel.call("GET", "api/accounts/me/schedules")).json.schedules.length, 3, "预览不保存");

      assert.strictEqual((await panel.call("PUT", "api/accounts/nobody/schedules", { schedules: [] })).status, 404);
      assert.strictEqual((await panel.request("api/accounts/me/schedules")).status, 401);
      const noCsrf = await panel.request("api/accounts/me/schedules", { method: "PUT", cookie: panel.cookie, body: { schedules: [] } });
      assert.strictEqual(noCsrf.status, 403);
    });

    await scenario("调度器：规则、账号启用状态与时区变化后立即重建定时任务；删除账号后移除", async () => {
      const panel = await startAuthed();
      const jobs = () => panel.scheduler.jobs().map((job) => `${job.accountId}/${job.ruleId}/${job.pattern}`).sort();
      await panel.call("POST", "api/accounts", { id: "me" });
      await panel.call("POST", "api/accounts", { id: "other" });
      const rules = [
        { id: "daily", type: "daily", times: ["06:00", "18:00"] },
        { id: "every6", type: "interval", hours: 6 },
      ];
      await panel.call("PUT", "api/accounts/me/schedules", { schedules: rules });
      await panel.call("PUT", "api/accounts/other/schedules", { schedules: [{ id: "noon", type: "cron", expression: "0 12 * * *" }] });
      assert.deepStrictEqual(jobs(), ["me/daily/0 18 * * *", "me/daily/0 6 * * *", "me/every6/0 */6 * * *", "other/noon/0 12 * * *"]);
      const sixAm = () => panel.scheduler.jobs().find((job) => job.pattern === "0 6 * * *").nextRun;
      assert.strictEqual(new Date(sixAm()).getUTCHours(), 22, "上海时间 06:00 为 UTC 22:00");

      await panel.call("PUT", "api/accounts/me/schedules", { schedules: [rules[0], { ...rules[1], enabled: false }] });
      assert.deepStrictEqual(jobs(), ["me/daily/0 18 * * *", "me/daily/0 6 * * *", "other/noon/0 12 * * *"], "停用的规则不调度");

      await panel.call("PATCH", "api/accounts/me", { enabled: false });
      assert.deepStrictEqual(jobs(), ["other/noon/0 12 * * *"], "停用的账号不调度");
      await panel.call("PATCH", "api/accounts/me", { enabled: true });
      assert.strictEqual(jobs().length, 3);

      await panel.call("PATCH", "api/settings", { settings: { timezone: "Europe/London" } });
      assert.ok([5, 6].includes(new Date(sixAm()).getUTCHours()), "改为伦敦时区后 06:00 对应 UTC 05:00 或 06:00");

      await panel.call("DELETE", "api/accounts/other");
      assert.deepStrictEqual(jobs(), ["me/daily/0 18 * * *", "me/daily/0 6 * * *"]);
      await panel.close();
      assert.deepStrictEqual(panel.scheduler.jobs(), [], "面板停止后不再调度");
    });

    await scenario("定时触发：到点后以定时方式加入队列；账号已在运行或排队时跳过并记录日志；无效规则跳过", async (logs) => {
      // 直接写入 panel.json：每秒触发一次（6 段 cron 只能手工写入，接口只接受 5 段），以及一条无效规则
      const dataDir = tempDir();
      fs.writeFileSync(
        path.join(dataDir, "panel.json"),
        JSON.stringify({
          version: 1,
          auth: { passwordHash: "" },
          accounts: [
            {
              id: "slow-1",
              name: "定时",
              enabled: true,
              createdAt: new Date().toISOString(),
              overrides: {},
              schedules: [
                { id: "tick", type: "cron", expression: "* * * * * *", enabled: true },
                { id: "broken", type: "cron", expression: "not a cron", enabled: true },
              ],
            },
          ],
        }),
        { mode: 0o600 }
      );
      const panel = await start({ dataDir, password: "correct-horse" });
      const cookie = sessionCookie(await login(panel, "correct-horse"));
      assert.ok(logs.some((line) => line.includes("跳过无效的调度规则：账号 slow-1，规则 broken")));

      const started = await nextRun(panel, (run) => run.accountId === "slow-1" && run.status === "reading", 5000);
      assert.deepStrictEqual([started.trigger, started.scheduleId], ["schedule", "tick"]);
      await until(() => logs.some((line) => /定时触发跳过：账号 slow-1，规则 tick（cron \* \* \* \* \* \*）：账号已在运行或排队/.test(line)), {
        timeoutMs: 5000,
        message: "运行中再次触发时应跳过并记录日志",
      });
      assert.ok(logs.some((line) => line.startsWith(`定时触发：账号 slow-1，规则 tick（cron * * * * * *），运行 ${started.id}`)));
      assert.strictEqual(panel.runner.list().length, 1, "同一账号只有一个运行");

      // 无效规则在接口中没有触发时间，不影响读取
      const account = await panel.request("api/accounts/slow-1", { cookie });
      assert.deepStrictEqual(account.json.account.schedules.find((rule) => rule.id === "broken").nextRuns, []);

      const ended = nextRun(panel, (run) => run.id === started.id && Boolean(run.endedAt));
      await panel.request("api/accounts/slow-1/schedules", { method: "PUT", cookie, headers: CSRF, body: { schedules: [] } });
      panel.runner.stop("slow-1");
      await ended;
      const files = runFiles(panel, "slow-1", started.id);
      assert.deepStrictEqual([files.meta().trigger, files.meta().scheduleId], ["schedule", "tick"]);
      assert.match(await files.log(), /加入队列：定时触发（规则 tick），阅读/);
      await new Promise((resolve) => setTimeout(resolve, 1500));
      assert.deepStrictEqual(panel.runner.list(), [], "规则删除后不再触发");
    });

    await scenario("运行历史：最新的在前、分页；详情含截图与按天分钟数；截图与日志可读取；账号带今日分钟数与最近一次运行", async () => {
      const panel = await startAuthed();
      await panel.call("POST", "api/accounts", { id: "ok-1" });
      const ids = [];
      for (let i = 0; i < 3; i += 1) {
        const finished = nextRun(panel, ended("ok-1"));
        await panel.call("POST", "api/accounts/ok-1/runs");
        ids.push((await finished).id);
      }
      const [first, second, third] = ids;

      const page1 = await panel.call("GET", "api/accounts/ok-1/runs?limit=2");
      assert.strictEqual(page1.status, 200);
      assert.deepStrictEqual(page1.json.runs.map((run) => run.id), [third, second]);
      assert.strictEqual(page1.json.nextBefore, second);
      const latest = page1.json.runs[0];
      assert.deepStrictEqual(
        [latest.status, latest.minutes, latest.trigger, latest.hasLog, latest.screenshots],
        ["success", 2, "manual", true, ["screenshot-1.png", "screenshot-2.png"]]
      );
      assert.ok(!("minuteMarks" in latest), "列表不返回逐分钟时间");
      const page2 = await panel.call("GET", `api/accounts/ok-1/runs?limit=2&before=${second}`);
      assert.deepStrictEqual([page2.json.runs.map((run) => run.id), page2.json.nextBefore], [[first], null]);
      for (const query of ["limit=0", "limit=101", "limit=x", "before=bad"]) {
        assert.strictEqual((await panel.call("GET", `api/accounts/ok-1/runs?${query}`)).status, 400, query);
      }
      assert.strictEqual((await panel.call("GET", "api/accounts/nobody/runs")).status, 404);

      const today = dateInZone(new Date(), "Asia/Shanghai");
      const detail = await panel.call("GET", `api/accounts/ok-1/runs/${third}`);
      assert.deepStrictEqual(detail.json.run.minutesByDate, { [today]: 2 });
      assert.strictEqual(JSON.parse(fs.readFileSync(path.join(panel.options.dataDir, "runs", "ok-1", third, "meta.json"), "utf8")).minuteMarks.length, 2);
      assert.strictEqual((await panel.call("GET", "api/accounts/ok-1/runs/20260101T000000Z-0000")).status, 404);

      const shot = await panel.call("GET", `api/accounts/ok-1/runs/${third}/screenshots/screenshot-2.png`);
      assert.strictEqual(shot.status, 200);
      assert.strictEqual(shot.headers.get("content-type"), "image/png");
      assert.strictEqual(shot.bytes.length, fs.statSync(path.join(panel.options.dataDir, "runs", "ok-1", third, "screenshot-2.png")).size);
      assert.deepStrictEqual([...shot.bytes.subarray(1, 4)], [0x50, 0x4e, 0x47], "PNG 文件头");
      for (const name of ["screenshot-9.png", "meta.json", "output.log", encodeURIComponent("../../panel.json"), "screenshot-1.jpg"]) {
        assert.strictEqual((await panel.call("GET", `api/accounts/ok-1/runs/${third}/screenshots/${name}`)).status, 404, name);
      }
      assert.ok(!fs.existsSync(path.join(panel.options.dataDir, "accounts", "ok-1", "screenshot-1.png")), "截图写入运行目录而不是账号目录");

      const account = (await panel.call("GET", "api/accounts")).json.accounts[0];
      assert.deepStrictEqual(account.today, { date: today, minutes: 6, checkedIn: true });
      assert.deepStrictEqual([account.lastRun.id, account.lastRun.status, account.lastRun.minutes], [third, "success", 2]);
      assert.strictEqual(account.challenge, null);

      // 阅读中途停止：已读的分钟数来自每分钟的进度，同样计入当天
      await panel.call("POST", "api/accounts", { id: "slow-1" });
      const progressed = nextRun(panel, (run) => run.accountId === "slow-1" && run.minutes >= 3);
      await panel.call("POST", "api/accounts/slow-1/runs");
      await progressed;
      const stopped = nextRun(panel, ended("slow-1"));
      panel.runner.stop("slow-1");
      const slow = await stopped;
      const slowMeta = JSON.parse(fs.readFileSync(path.join(panel.options.dataDir, "runs", "slow-1", slow.id, "meta.json"), "utf8"));
      assert.strictEqual(slowMeta.status, "stopped");
      assert.ok(slowMeta.minutes >= 3 && slowMeta.minuteMarks.length === slowMeta.minutes, "每分钟进度都有对应的时间");
      const slowAccount = (await panel.call("GET", "api/accounts/slow-1")).json.account;
      assert.deepStrictEqual([slowAccount.today.minutes, slowAccount.lastRun.status], [slowMeta.minutes, "stopped"]);
    });

    await scenario("按天统计：跨午夜的运行按面板时区拆到两天，改时区后重新归属；失败与停止的运行计入已读部分；旧记录按开始阅读时间估算", async () => {
      const panel = await startAuthed();
      await panel.call("POST", "api/accounts", { id: "me" });
      const dataDir = panel.options.dataDir;
      // 上海时间 3 月 31 日 23:51 至 4 月 1 日 00:10，共 20 分钟，运行失败
      const crossing = writeRun(dataDir, "me", {
        queuedAt: "2026-03-31T15:45:00.000Z",
        marks: minutesFrom("2026-03-31T15:50:00.000Z", 20),
        status: "failed",
      });
      // 第 7 步之前的记录：只有 minutes 与开始阅读时间
      writeRun(dataDir, "me", { queuedAt: "2026-04-02T00:58:00.000Z", minutes: 6, readingStartedAt: "2026-04-02T01:00:00.000Z" });
      // 已停止，只读了 3 分钟，不够打卡
      writeRun(dataDir, "me", { queuedAt: "2026-04-03T02:00:00.000Z", marks: minutesFrom("2026-04-03T02:00:00.000Z", 3), status: "stopped" });
      // 恰好 5 分钟：算作打卡
      writeRun(dataDir, "me", { queuedAt: "2026-04-04T02:00:00.000Z", marks: minutesFrom("2026-04-04T02:00:00.000Z", 5) });

      const month = async (value) => (await panel.call("GET", `api/accounts/me/calendar?month=${value}`)).json;
      const dayOf = (cal, date) => cal.days.find((day) => day.date === date);
      const march = await month("2026-03");
      assert.strictEqual(march.days.length, 31);
      assert.deepStrictEqual(dayOf(march, "2026-03-31"), { date: "2026-03-31", minutes: 9, checkedIn: true, future: false });
      const april = await month("2026-04");
      assert.strictEqual(april.days.length, 30);
      assert.deepStrictEqual(
        ["2026-04-01", "2026-04-02", "2026-04-03", "2026-04-04"].map((date) => [dayOf(april, date).minutes, dayOf(april, date).checkedIn]),
        [[11, true], [6, true], [3, false], [5, true]]
      );
      assert.deepStrictEqual([april.monthMinutes, april.monthCheckedDays, april.checkInMinutes], [25, 3, 5]);
      assert.strictEqual(april.note, "按本工具运行记录统计，非微信读书官方数据");
      assert.deepStrictEqual(
        (await panel.call("GET", `api/accounts/me/runs/${crossing}`)).json.run.minutesByDate,
        { "2026-03-31": 9, "2026-04-01": 11 }
      );

      await panel.call("PATCH", "api/settings", { settings: { timezone: "UTC" } });
      const utcMarch = await month("2026-03");
      const utcApril = await month("2026-04");
      assert.strictEqual(utcMarch.timezone, "UTC");
      assert.strictEqual(dayOf(utcMarch, "2026-03-31").minutes, 20, "UTC 下整段都在 3 月 31 日");
      assert.deepStrictEqual(
        ["2026-04-01", "2026-04-02", "2026-04-03"].map((date) => dayOf(utcApril, date).minutes),
        [0, 6, 3]
      );

      const current = await panel.call("GET", "api/accounts/me/calendar");
      assert.strictEqual(current.json.month, dateInZone(new Date(), "UTC").slice(0, 7), "默认本月");
      assert.strictEqual(current.json.today.date, dateInZone(new Date(), "UTC"));
      assert.ok(current.json.days.some((day) => day.future) || current.json.days[current.json.days.length - 1].date === current.json.today.date);
      for (const bad of ["2026-13", "2026-4", "abc"]) {
        assert.strictEqual((await panel.call("GET", `api/accounts/me/calendar?month=${bad}`)).status, 400, bad);
      }
      assert.strictEqual((await panel.call("GET", "api/accounts/nobody/calendar")).status, 404);
    });

    await scenario("挑战进度：第几天、已打卡天数、累计分钟、漏打卡天数与是否达成；挑战设置的校验", async () => {
      const dataDir = tempDir();
      const timezone = "Asia/Shanghai";
      // 4 月 1 日至 10 日每天上海时间 09:00 起阅读 30 分钟，5 日只读了 3 分钟
      for (let day = 1; day <= 10; day += 1) {
        const start = `2026-04-${String(day).padStart(2, "0")}T01:00:00.000Z`;
        writeRun(dataDir, "ch", { queuedAt: start, marks: minutesFrom(start, day === 5 ? 3 : 30) });
      }
      const account = { id: "ch", challenge: { type: "month", startDate: "2026-04-01" } };
      const at = (iso) => challengeProgress(dataDir, account, { timezone, now: new Date(iso) });

      assert.deepStrictEqual(at("2026-04-10T04:00:00.000Z"), {
        type: "month",
        label: "月卡",
        startDate: "2026-04-01",
        endDate: "2026-04-30",
        status: "active",
        dayNumber: 10,
        totalDays: 30,
        checkedDays: 9,
        requiredDays: 29,
        totalMinutes: 273,
        requiredMinutes: 1800,
        missedDays: 1,
        allowedMissedDays: 1,
        achieved: false,
      });
      const before = at("2026-03-20T00:00:00.000Z");
      assert.deepStrictEqual([before.status, before.dayNumber, before.checkedDays, before.totalMinutes, before.missedDays], ["not-started", 0, 0, 0, 0]);
      const after = at("2026-05-15T00:00:00.000Z");
      assert.deepStrictEqual([after.status, after.dayNumber, after.checkedDays, after.missedDays], ["ended", 30, 9, 21]);
      // 上海时间 4 月 1 日 00:30 只算第 1 天，前一天（UTC 3 月 31 日）的数据不计入
      assert.strictEqual(at("2026-03-31T16:30:00.000Z").dayNumber, 1);

      // 29 天、每天 63 分钟：天数与时长都达标；每天 62 分钟时时长差 2 分钟
      for (const [id, minutes, achieved] of [["full", 63, true], ["short", 62, false]]) {
        for (let day = 1; day <= 29; day += 1) {
          const start = `2026-06-${String(day).padStart(2, "0")}T01:00:00.000Z`;
          writeRun(dataDir, id, { queuedAt: start, marks: minutesFrom(start, minutes) });
        }
        const result = challengeProgress(dataDir, { id, challenge: { type: "month", startDate: "2026-06-01" } }, { timezone, now: new Date("2026-07-05T00:00:00.000Z") });
        assert.deepStrictEqual([result.checkedDays, result.totalMinutes, result.missedDays, result.achieved], [29, 29 * minutes, 1, achieved], id);
      }
      const year = challengeProgress(dataDir, { id: "ch", challenge: { type: "year", startDate: "2026-04-01" } }, { timezone, now: new Date("2026-04-10T04:00:00.000Z") });
      assert.deepStrictEqual([year.label, year.totalDays, year.requiredDays, year.requiredMinutes, year.allowedMissedDays, year.endDate], ["年卡", 365, 360, 18000, 5, "2027-03-31"]);

      const panel = await startAuthed();
      await panel.call("POST", "api/accounts", { id: "me" });
      for (const challenge of [{ type: "week", startDate: "2026-04-01" }, { type: "month", startDate: "2026-02-30" }, { type: "month", startDate: "2026/04/01" }, { type: "month", startDate: "2026-04-01", x: 1 }, "month"]) {
        assert.strictEqual((await panel.call("PATCH", "api/accounts/me", { challenge })).status, 400, JSON.stringify(challenge));
      }
      const today = dateInZone(new Date(), "Asia/Shanghai");
      const saved = await panel.call("PATCH", "api/accounts/me", { challenge: { type: "month", startDate: today } });
      assert.deepStrictEqual(saved.json.account.challenge, { type: "month", startDate: today });
      const detail = (await panel.call("GET", "api/accounts/me")).json;
      assert.deepStrictEqual([detail.challengeProgress.status, detail.challengeProgress.dayNumber, detail.challengeProgress.missedDays], ["active", 1, 0]);
      assert.strictEqual((await panel.call("GET", "api/accounts/me/calendar")).json.challenge.startDate, today);
      await panel.call("PATCH", "api/accounts/me", { challenge: null });
      assert.strictEqual((await panel.call("GET", "api/accounts/me")).json.challengeProgress, null);
    });

    await scenario("保留策略：截图只保留最近 N 次有截图的运行，日志超过天数后删除，运行记录永久保留；进行中的运行不清理；运行结束后自动清理", async () => {
      const panel = await startAuthed();
      const dataDir = panel.options.dataDir;
      await panel.call("POST", "api/accounts", { id: "keep" });
      const daysAgo = (days) => new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
      const shots = { "screenshot-1.png": "a", "screenshot-2.png": "b", "output.log": "log\n" };
      // 从旧到新：5 次有截图的运行（最早两次在 3 天前结束），最新一次是仅登录、没有截图
      const runIds = [5, 4, 3, 2, 1].map((age, index) =>
        writeRun(dataDir, "keep", { queuedAt: daysAgo(index < 2 ? 3 : 0.5 - index * 0.01), endedAt: daysAgo(index < 2 ? 3 : 0.4), files: shots })
      );
      const loginOnly = writeRun(dataDir, "keep", { queuedAt: daysAgo(0.1), mode: "login", files: { "output.log": "log\n" } });
      const dirOf = (id) => path.join(dataDir, "runs", "keep", id);

      await panel.call("PATCH", "api/settings", { settings: { screenshotRetentionRuns: 2, logRetentionDays: 1 } });
      await until(() => !fs.existsSync(path.join(dirOf(runIds[0]), "screenshot-1.png")), { message: "修改保留设置后应清理" });
      const list = (await panel.call("GET", "api/accounts/keep/runs?limit=10")).json.runs;
      const byId = Object.fromEntries(list.map((run) => [run.id, run]));
      assert.strictEqual(list.length, 6, "运行记录全部保留");
      assert.deepStrictEqual(runIds.map((id) => byId[id].screenshots.length), [0, 0, 0, 2, 2], "只保留最近 2 次有截图的运行");
      assert.deepStrictEqual(runIds.map((id) => byId[id].hasLog), [false, false, true, true, true], "超过 1 天的日志被删除");
      assert.strictEqual(byId[loginOnly].hasLog, true);
      assert.strictEqual((await panel.call("GET", `api/accounts/keep/runs/${runIds[0]}/log`)).status, 404);

      // 进行中的运行即使超出保留数也不清理
      const removed = cleanupRuns(dataDir, { screenshotRetentionRuns: 0, logRetentionDays: 1 }, { activeRunIds: new Set([runIds[4]]) });
      assert.deepStrictEqual(removed, { screenshots: 2, logs: 0 });
      assert.ok(fs.existsSync(path.join(dirOf(runIds[4]), "screenshot-2.png")));
      assert.ok(!fs.existsSync(path.join(dirOf(runIds[3]), "screenshot-2.png")));

      // 运行结束后自动清理：只保留最近 1 次
      await panel.call("PATCH", "api/settings", { settings: { screenshotRetentionRuns: 1 } });
      await panel.call("POST", "api/accounts", { id: "ok-1" });
      const done = [];
      for (let i = 0; i < 2; i += 1) {
        const finished = nextRun(panel, ended("ok-1"));
        await panel.call("POST", "api/accounts/ok-1/runs");
        done.push((await finished).id);
      }
      await until(() => !fs.existsSync(path.join(dataDir, "runs", "ok-1", done[0], "screenshot-1.png")), { message: "运行结束后应清理上一次的截图" });
      assert.ok(fs.existsSync(path.join(dataDir, "runs", "ok-1", done[1], "screenshot-2.png")));
      assert.ok(fs.existsSync(path.join(dataDir, "runs", "ok-1", done[0], "meta.json")));
    });

    await scenario("端口被占用时给出明确错误", async () => {
      const blocker = net.createServer();
      await new Promise((resolve) => blocker.listen(0, "127.0.0.1", resolve));
      const { port } = blocker.address();
      try {
        await assert.rejects(startPanel(panelOptions({ port })), /端口 \d+ 已被占用，请通过 PANEL_PORT 更换端口/);
      } finally {
        await new Promise((resolve) => blocker.close(resolve));
      }
    });

    console.log(`\n面板 smoke 全部通过（${results.length} 个场景）`);
  } finally {
    await Promise.all(panels.map((panel) => panel.close()));
    for (const dir of tempDirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
}

main().catch((error) => {
  console.error(`面板 smoke 失败: ${error.message}`);
  if (error.capturedLogs) {
    console.error("捕获的日志:");
    console.error(error.capturedLogs.join("\n"));
  }
  process.exit(1);
});
