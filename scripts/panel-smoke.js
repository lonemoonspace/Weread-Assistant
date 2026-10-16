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

const CSRF = { "X-WA-Request": "1" };
const STUB_WORKER = path.resolve(__dirname, "fixtures", "stub-worker.js");

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "panel-smoke-"));
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
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch (_) {}
    return { status: res.status, headers: res.headers, text, json };
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

    await scenario("页面与接口带安全响应头，接口禁止缓存", async () => {
      const panel = await start();
      const page = await panel.request("login");
      const csp = page.headers.get("content-security-policy");
      assert.match(csp, /default-src 'self'/);
      assert.match(csp, /frame-ancestors 'none'/);
      assert.doesNotMatch(csp, /unsafe-inline/);
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

    await scenario("运行：子进程经 IPC 收到账号配置，按事件更新状态，日志与运行记录写入运行目录", async () => {
      process.env.PANEL_SMOKE_SECRET = "should-not-leak";
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
        assert.match(run.id, /^\d{8}T\d{6}Z-[0-9a-f]{4}$/);

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
        assert.match(log, /PANEL_\* 环境变量: \[\]/, "子进程环境变量中不应有 PANEL_*");
        assert.match(log, /barkKey 已下发: true/, "密钥经 IPC 下发");
        assert.ok(!log.includes("secret-bark-key"));

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
        delete process.env.PANEL_SMOKE_SECRET;
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

    await scenario("失败：上报错误、等待扫码超时、未上报结果就退出都记为失败", async () => {
      const panel = await startAuthed();
      await panel.call("PATCH", "api/settings", { settings: { maxConcurrentRuns: 3 } });
      const ids = ["fail-1", "timeout-1", "crash-1"];
      const finished = Promise.all(ids.map((id) => nextRun(panel, ended(id))));
      for (const id of ids) {
        await panel.call("POST", "api/accounts", { id });
        assert.strictEqual((await panel.call("POST", `api/accounts/${id}/runs`)).status, 202);
      }
      const [fail, timeout, crash] = await finished;
      assert.deepStrictEqual([fail.status, fail.error], ["failed", "模拟的页面错误"]);
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
