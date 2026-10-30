#!/usr/bin/env node
/**
 * 面板 smoke 测试：在本机启动面板，用 HTTP 请求验证鉴权、会话、限速、反向代理、安全响应头、
 * passkey（软件认证器 scripts/fixtures/soft-authenticator.js）、配置与账号，以及运行队列（排队、成功、失败、停止、强制结束、实时推送）。
 * 运行队列使用桩子进程 scripts/fixtures/stub-worker.js，不需要浏览器与 Selenium。
 * 用法: node scripts/panel-smoke.js
 */

const assert = require("assert");
const fs = require("fs");
const http = require("http");
const net = require("net");
const os = require("os");
const path = require("path");
const zlib = require("zlib");

const { startPanel } = require(path.resolve(__dirname, "..", "src", "panel", "server"));
const { SESSION_TTL_MS, createAuth, hashPassword } = require(path.resolve(__dirname, "..", "src", "panel", "auth"));
const { SECRET_MASK, resolveAccountConfig } = require(path.resolve(__dirname, "..", "src", "panel", "config"));
const { CHILD_ENV_KEYS } = require(path.resolve(__dirname, "..", "src", "panel", "runner"));
const { describeSchedule, nextRuns, normalizeSchedules, schedulePatterns } = require(
  path.resolve(__dirname, "..", "src", "panel", "schedules")
);
const { challengeProgress, cleanupRuns, dateInZone } = require(path.resolve(__dirname, "..", "src", "panel", "history"));
const { createPasskeys } = require(path.resolve(__dirname, "..", "src", "panel", "passkeys"));
const { createStore } = require(path.resolve(__dirname, "..", "src", "panel", "store"));
const { startMockSelenium } = require("./fixtures/mock-selenium");
const { FLAG_UP, createSoftAuthenticator } = require("./fixtures/soft-authenticator");
const { minutesFrom, writeRun } = require("./fixtures/run-records");

const CSRF = { "X-WA-Request": "1" };
// passkey 场景使用的外网地址：RP ID 为 example.com，origin 为 https://example.com
const PASSKEY_URL = "https://example.com/weread/";
const PASSKEY_RP = { rpId: "example.com", origin: "https://example.com" };
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
      init.body = typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body);
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

  // 已登录的面板添加一个软件认证器的 passkey，返回该认证器
  const addPasskey = async (panel, name = "测试设备", authenticator = createSoftAuthenticator(PASSKEY_RP)) => {
    const options = await panel.call("POST", "api/auth/passkeys/options");
    assert.strictEqual(options.status, 200, JSON.stringify(options.json));
    const added = await panel.call("POST", "api/auth/passkeys", { name, response: authenticator.register(options.json) });
    assert.strictEqual(added.status, 201, JSON.stringify(added.json));
    return authenticator;
  };
  // 未登录申请 passkey 登录参数并用 authenticator 登录；tamper 篡改认证器的结果
  const passkeyLogin = async (panel, authenticator, tamper = {}) => {
    const options = await panel.request("api/auth/passkey/options", { method: "POST", body: { purpose: "login" }, headers: CSRF });
    assert.strictEqual(options.status, 200, JSON.stringify(options.json));
    return panel.request("api/auth/passkey/login", {
      method: "POST",
      body: { response: authenticator.assert(options.json, tamper) },
      headers: CSRF,
    });
  };
  // 用某个会话 cookie 调用接口
  const callAs = (panel, cookie, method, urlPath, body) =>
    panel.request(urlPath, { method, cookie, body: method === "GET" ? undefined : body || {}, headers: method === "GET" ? {} : CSRF });

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
      for (const [encoding, compress] of [["br", zlib.brotliCompressSync], ["gzip", zlib.gzipSync]]) {
        const compressed = await panel.request("api/auth/login", {
          method: "POST",
          body: compress(Buffer.from(JSON.stringify({ password: "correct-horse" }))),
          headers: { ...CSRF, "Content-Encoding": encoding },
        });
        assert.strictEqual(compressed.status, 415, `${encoding} 压缩的请求体应被拒绝`);
      }
    });

    await scenario("同一 IP 连续失败 5 次后锁定，锁定期间正确密码也返回 429，解锁后可登录", async () => {
      const panel = await start({ password: "correct-horse", limits: { lockoutBaseMs: 400 } });
      for (let i = 0; i < 4; i += 1) {
        assert.strictEqual((await login(panel, "wrong")).status, 401);
      }
      const fifth = await login(panel, "wrong");
      assert.strictEqual(fifth.status, 401);
      assert.ok(Number(fifth.headers.get("retry-after")) >= 1);
      assert.strictEqual(fifth.json.retryAfter, Number(fifth.headers.get("retry-after")), "触发锁定的这次失败同样带上等待秒数");
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

    await scenario("登录时回收已过期的会话", async () => {
      let t = Date.now();
      const auth = createAuth({ store: { get: () => ({ auth: { passwordHash: "" } }) }, envPassword: "correct-horse", now: () => t });
      await auth.init();
      const first = await auth.login("127.0.0.1", "correct-horse");
      let ended = false;
      auth.watchSession(first.token, () => {
        ended = true;
      });
      t += SESSION_TTL_MS + 1;
      assert.ok((await auth.login("127.0.0.1", "correct-horse")).ok);
      assert.ok(ended, "过期的会话应在下次登录时回收");
    });

    await scenario("环境变量中的密码少于 8 位时拒绝启动", async () => {
      await assert.rejects(start({ password: "short" }), /PANEL_PASSWORD 至少 8 位/);
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

    await scenario("passkey：只在 PANEL_PUBLIC_URL 为 HTTPS 域名（或 http://localhost）时提供，RP ID 只取域名", async () => {
      const cases = [
        ["", null],
        ["http://example.com/", null],
        ["https://192.168.1.2:26868/", null],
        ["https://[::1]/", null],
        ["http://localhost:26868/", "http://localhost:26868"],
        ["https://example.com:8443/weread/", "https://example.com:8443"],
        // 域名末尾的点去掉
        ["https://example.com.:8443/", "https://example.com:8443"],
      ];
      for (const [publicUrl, origin] of cases) {
        const panel = await startAuthed({ publicUrl });
        const methods = await panel.request("api/auth/methods");
        assert.strictEqual(methods.status, 200);
        assert.deepStrictEqual(methods.json, { password: true, passkey: origin ? { available: true, origin } : { available: false } }, publicUrl);
        const session = await panel.call("GET", "api/auth/session");
        assert.deepStrictEqual(session.json.passkey, methods.json.passkey);
        if (!origin) {
          const options = await panel.request("api/auth/passkey/options", { method: "POST", body: { purpose: "login" }, headers: CSRF });
          assert.strictEqual(options.status, 409);
          assert.strictEqual(options.json.error, "passkey_unavailable");
          assert.strictEqual((await panel.call("POST", "api/auth/passkeys/options")).status, 409);
          assert.deepStrictEqual((await panel.call("GET", "api/auth/passkeys")).json, { passkey: { available: false }, passkeys: [] });
        }
      }
      const dotted = await startAuthed({ publicUrl: "https://example.com./" });
      assert.strictEqual((await dotted.call("POST", "api/auth/passkeys/options")).json.rp.id, "example.com");
      const panel = await startAuthed({ publicUrl: "https://example.com:8443/weread/" });
      const options = await panel.call("POST", "api/auth/passkeys/options");
      assert.strictEqual(options.json.rp.id, "example.com");
      assert.deepStrictEqual(options.json.authenticatorSelection, { residentKey: "required", userVerification: "required", requireResidentKey: true });
      assert.strictEqual(options.json.attestation, "none");
      assert.deepStrictEqual(options.json.pubKeyCredParams.map((item) => item.alg), [-8, -7, -257]);
      // purpose 不对时 400；接口同样要求自定义请求头
      assert.strictEqual((await panel.request("api/auth/passkey/options", { method: "POST", body: { purpose: "x" }, headers: CSRF })).status, 400);
      assert.strictEqual((await panel.request("api/auth/passkey/options", { method: "POST", body: { purpose: "login" } })).status, 403);
    });

    await scenario("passkey：添加后可以登录，会话记录登录方式；只保存公钥，记录签名计数与最近使用时间；可以改名", async () => {
      const panel = await startAuthed({ publicUrl: PASSKEY_URL });
      assert.strictEqual((await panel.call("GET", "api/auth/session")).json.method, "password");
      const authenticator = await addPasskey(panel, "我的手机");
      const listed = (await panel.call("GET", "api/auth/passkeys")).json;
      assert.deepStrictEqual(listed.passkey, { available: true, origin: "https://example.com" });
      assert.strictEqual(listed.passkeys.length, 1);
      const [item] = listed.passkeys;
      assert.strictEqual(item.id, authenticator.id);
      assert.strictEqual(item.name, "我的手机");
      assert.strictEqual(item.usable, true);
      assert.strictEqual(item.backedUp, true);
      assert.strictEqual(item.lastUsedAt, null);
      assert.ok(!("publicKey" in item), "接口不应返回公钥");

      const ok = await passkeyLogin(panel, authenticator);
      assert.strictEqual(ok.status, 204);
      const cookie = sessionCookie(ok);
      assert.match(ok.headers.get("set-cookie"), /HttpOnly/i);
      const session = await callAs(panel, cookie, "GET", "api/auth/session");
      assert.strictEqual(session.status, 200);
      assert.strictEqual(session.json.method, "passkey");
      assert.ok(Date.parse(session.json.verifiedUntil) > Date.now());

      const stored = JSON.parse(fs.readFileSync(path.join(panel.options.dataDir, "panel.json"), "utf8")).auth;
      assert.match(stored.webauthnUserId, /^[A-Za-z0-9_-]{22}$/);
      assert.strictEqual(stored.passkeys.length, 1);
      assert.strictEqual(stored.passkeys[0].rpId, "example.com");
      assert.strictEqual(stored.passkeys[0].counter, 1);
      assert.ok(stored.passkeys[0].lastUsedAt);
      assert.deepStrictEqual(Object.keys(stored.passkeys[0]).sort(), [
        "backedUp", "counter", "createdAt", "id", "lastUsedAt", "name", "publicKey", "rpId", "transports",
      ]);

      // 同一个 passkey 不能重复添加：参数中排除已有的，强行提交时 409
      const again = await panel.call("POST", "api/auth/passkeys/options");
      assert.deepStrictEqual(again.json.excludeCredentials.map((entry) => entry.id), [authenticator.id]);
      const duplicate = await panel.call("POST", "api/auth/passkeys", { name: "再来", response: authenticator.register(again.json) });
      assert.strictEqual(duplicate.status, 409);
      assert.strictEqual(duplicate.json.error, "passkey_exists");

      // 不填名称时按日期命名；改名校验长度；不存在时 404
      const second = createSoftAuthenticator(PASSKEY_RP);
      const unnamedOptions = await panel.call("POST", "api/auth/passkeys/options");
      const unnamed = await panel.call("POST", "api/auth/passkeys", { response: second.register(unnamedOptions.json) });
      assert.match(unnamed.json.passkey.name, /^passkey \d{4}-\d{2}-\d{2}$/);
      const renamed = await panel.call("PATCH", `api/auth/passkeys/${second.id}`, { name: "  笔记本  " });
      assert.strictEqual(renamed.status, 200);
      assert.strictEqual(renamed.json.passkey.name, "笔记本");
      assert.strictEqual((await panel.call("PATCH", `api/auth/passkeys/${second.id}`, { name: " " })).status, 400);
      assert.strictEqual((await panel.call("PATCH", `api/auth/passkeys/${second.id}`, { name: "x".repeat(65) })).status, 400);
      // 换行、控制字符与文字方向控制符会伪造日志行或打乱显示，添加与改名都拒绝
      for (const name of ["名字\n[ERROR] 伪造的日志", "a\u0000b", "a\u0085b", "a\u2028b", "abc\u202Efdp.exe", "a\u2066b"]) {
        const bad = await panel.call("PATCH", `api/auth/passkeys/${second.id}`, { name });
        assert.strictEqual(bad.status, 400, JSON.stringify(name));
        assert.match(bad.json.message, /不能包含换行、控制字符或文字方向控制符/);
      }
      const third = createSoftAuthenticator(PASSKEY_RP);
      const badNameOptions = await panel.call("POST", "api/auth/passkeys/options");
      assert.strictEqual((await panel.call("POST", "api/auth/passkeys", { name: "x\ty", response: third.register(badNameOptions.json) })).status, 400);
      assert.strictEqual((await panel.call("PATCH", `api/auth/passkeys/${second.id}`, { name: "我的 iPhone 🔑" })).status, 200);
      assert.strictEqual((await panel.call("PATCH", "api/auth/passkeys/missing", { name: "x" })).status, 404);
      assert.strictEqual((await panel.call("DELETE", "api/auth/passkeys/missing")).status, 404);
      // 需要登录
      assert.strictEqual((await panel.request("api/auth/passkeys")).status, 401);
    });

    await scenario("passkey 校验：origin、RP ID、类型、用户验证、签名、计数器、未知凭据与用过或用途不对的 challenge 都拒绝", async () => {
      const panel = await startAuthed({ publicUrl: PASSKEY_URL, limits: { maxFailures: 1000, globalMaxFailures: 1000 } });
      const authenticator = await addPasskey(panel);
      const rejects = async (tamper, label) => {
        const res = await passkeyLogin(panel, authenticator, tamper);
        assert.strictEqual(res.status, 401, label);
        assert.strictEqual(res.json.error, "passkey_failed", label);
        assert.strictEqual(sessionCookie(res), "", label);
      };
      await rejects({ origin: "https://evil.example" }, "origin 不对");
      await rejects({ origin: "https://example.com:8443" }, "端口不同的 origin");
      await rejects({ rpId: "evil.example" }, "RP ID 不对");
      await rejects({ type: "webauthn.create" }, "类型不对");
      await rejects({ flags: FLAG_UP }, "没有用户验证");
      await rejects({ badSignature: true }, "签名被改");
      assert.strictEqual((await passkeyLogin(panel, createSoftAuthenticator(PASSKEY_RP))).status, 401, "未登记的认证器");

      // 计数器：登录成功后，不大于已记录值的计数被拒绝
      assert.strictEqual((await passkeyLogin(panel, authenticator, { counter: 10 })).status, 204);
      await rejects({ counter: 10 }, "计数器没有增加");
      await rejects({ counter: 3 }, "计数器回退");
      assert.strictEqual((await passkeyLogin(panel, authenticator, { counter: 11 })).status, 204);

      // challenge 只能用一次
      const options = await panel.request("api/auth/passkey/options", { method: "POST", body: { purpose: "login" }, headers: CSRF });
      const loginWith = (response) => panel.request("api/auth/passkey/login", { method: "POST", body: { response }, headers: CSRF });
      assert.strictEqual((await loginWith(authenticator.assert(options.json))).status, 204);
      assert.strictEqual((await loginWith(authenticator.assert(options.json))).status, 401, "重放 challenge");
      // 二次验证、添加用的 challenge 不能用于登录
      const reauthOptions = await panel.call("POST", "api/auth/passkey/options", { purpose: "reauth" });
      assert.strictEqual((await loginWith(authenticator.assert(reauthOptions.json))).status, 401, "二次验证的 challenge");
      const registerOptions = await panel.call("POST", "api/auth/passkeys/options");
      assert.strictEqual((await loginWith(authenticator.assert(registerOptions.json))).status, 401, "添加用的 challenge");
      // 格式不对的请求体
      for (const response of [undefined, "x", {}, { id: authenticator.id }, { id: authenticator.id, response: {} }]) {
        assert.strictEqual((await loginWith(response)).status, 401, JSON.stringify(response));
      }

      // 添加：origin、RP ID、用户验证、challenge 不对时 400 passkey_failed，不保存
      const addRejects = async (tamper, label, optionsFor = () => panel.call("POST", "api/auth/passkeys/options")) => {
        const added = await panel.call("POST", "api/auth/passkeys", {
          name: "x",
          response: createSoftAuthenticator(PASSKEY_RP).register((await optionsFor()).json, tamper),
        });
        assert.strictEqual(added.status, 400, label);
        assert.strictEqual(added.json.error, "passkey_failed", label);
      };
      await addRejects({ origin: "https://evil.example" }, "添加时 origin 不对");
      await addRejects({ rpId: "evil.example" }, "添加时 RP ID 不对");
      await addRejects({ flags: FLAG_UP }, "添加时没有用户验证");
      await addRejects({}, "添加时用登录的 challenge", () =>
        panel.request("api/auth/passkey/options", { method: "POST", body: { purpose: "login" }, headers: CSRF })
      );
      assert.strictEqual((await panel.call("GET", "api/auth/passkeys")).json.passkeys.length, 1);
    });

    await scenario("passkey 登录失败计入登录限速：锁定后 passkey 与密码都返回 429，也拿不到登录参数", async () => {
      const panel = await startAuthed({ publicUrl: PASSKEY_URL, limits: { lockoutBaseMs: 60000 } });
      const authenticator = await addPasskey(panel);
      for (let i = 0; i < 5; i += 1) {
        assert.strictEqual((await passkeyLogin(panel, authenticator, { badSignature: true })).status, 401);
      }
      const options = await panel.request("api/auth/passkey/options", { method: "POST", body: { purpose: "login" }, headers: CSRF });
      assert.strictEqual(options.status, 429);
      assert.ok(Number(options.headers.get("retry-after")) >= 1);
      assert.strictEqual((await login(panel, "correct-horse")).status, 429);
    });

    await scenario("二次验证：添加、删除 passkey 要求会话在有效期内登录或验证过；可用密码或 passkey 验证，失败计入限速", async () => {
      const panel = await startAuthed({ publicUrl: PASSKEY_URL, limits: { reauthWindowMs: 300 } });
      const authenticator = await addPasskey(panel);
      await new Promise((resolve) => setTimeout(resolve, 350));
      assert.strictEqual((await panel.call("GET", "api/auth/session")).json.verifiedUntil, null);
      const expired = await panel.call("POST", "api/auth/passkeys/options");
      assert.strictEqual(expired.status, 403);
      assert.strictEqual(expired.json.error, "reauth_required");
      assert.strictEqual((await panel.call("DELETE", `api/auth/passkeys/${authenticator.id}`)).status, 403);
      // 改名不需要二次验证
      assert.strictEqual((await panel.call("PATCH", `api/auth/passkeys/${authenticator.id}`, { name: "新名字" })).status, 200);

      // 密码：错误时 400（不是 401，页面不会当作会话失效），正确后可以添加
      const wrong = await panel.call("POST", "api/auth/reauth", { password: "wrong" });
      assert.strictEqual(wrong.status, 400);
      assert.strictEqual(wrong.json.error, "wrong_password");
      assert.strictEqual((await panel.call("POST", "api/auth/reauth", { password: "correct-horse" })).status, 204);
      assert.ok(Date.parse((await panel.call("GET", "api/auth/session")).json.verifiedUntil) > Date.now());
      assert.strictEqual((await panel.call("POST", "api/auth/passkeys/options")).status, 200);

      // passkey：参数只列出可用的 passkey，challenge 绑定申请它的会话
      await new Promise((resolve) => setTimeout(resolve, 350));
      const options = await panel.call("POST", "api/auth/passkey/options", { purpose: "reauth" });
      assert.deepStrictEqual(options.json.allowCredentials.map((entry) => entry.id), [authenticator.id]);
      const other = sessionCookie(await login(panel, "correct-horse"));
      const stolen = await callAs(panel, other, "POST", "api/auth/reauth", { passkey: authenticator.assert(options.json) });
      assert.strictEqual(stolen.status, 400, "其他会话申请的 challenge");
      assert.strictEqual(stolen.json.error, "passkey_failed");
      const fresh = await panel.call("POST", "api/auth/passkey/options", { purpose: "reauth" });
      assert.strictEqual((await panel.call("POST", "api/auth/reauth", { passkey: authenticator.assert(fresh.json) })).status, 204);
      assert.strictEqual((await panel.call("DELETE", `api/auth/passkeys/${authenticator.id}`)).status, 204);

      // 未登录不能申请二次验证参数，也不能二次验证
      assert.strictEqual((await panel.request("api/auth/passkey/options", { method: "POST", body: { purpose: "reauth" }, headers: CSRF })).status, 401);
      assert.strictEqual((await panel.request("api/auth/reauth", { method: "POST", body: { password: "correct-horse" }, headers: CSRF })).status, 401);

      // 二次验证失败计入登录限速
      const limited = await startAuthed({ publicUrl: PASSKEY_URL, limits: { lockoutBaseMs: 60000 } });
      for (let i = 0; i < 5; i += 1) {
        const failed = await limited.call("POST", "api/auth/reauth", { password: "wrong" });
        assert.strictEqual(failed.status, 400);
        assert.strictEqual(failed.json.retryAfter, i < 4 ? undefined : 60, "第 5 次失败触发锁定，带上等待秒数");
      }
      assert.strictEqual((await limited.call("POST", "api/auth/reauth", { password: "correct-horse" })).status, 429);
      assert.strictEqual((await login(limited, "correct-horse")).status, 429);
    });

    await scenario("删除 passkey：用它登录的其他会话立即失效（含实时推送），当前会话与其他方式登录的会话保留", async () => {
      const panel = await startAuthed({ publicUrl: PASSKEY_URL, sseHeartbeatMs: 60000 });
      const authenticator = await addPasskey(panel);
      const keep = createSoftAuthenticator(PASSKEY_RP);
      await addPasskey(panel, "另一个", keep);
      const mine = sessionCookie(await passkeyLogin(panel, authenticator));
      const theirs = sessionCookie(await passkeyLogin(panel, authenticator));
      const viaOther = sessionCookie(await passkeyLogin(panel, keep));
      const events = await openEvents(panel.port, theirs);
      await until(() => events.events.length > 0);

      assert.strictEqual((await callAs(panel, mine, "DELETE", `api/auth/passkeys/${authenticator.id}`)).status, 204);
      await Promise.race([events.closed, new Promise((_, reject) => setTimeout(() => reject(new Error("推送连接没有立即断开")), 1000))]);
      assert.strictEqual((await callAs(panel, mine, "GET", "api/auth/session")).status, 200, "当前会话保留");
      assert.strictEqual((await callAs(panel, theirs, "GET", "api/auth/session")).status, 401, "用它登录的其他会话失效");
      assert.strictEqual((await callAs(panel, viaOther, "GET", "api/auth/session")).status, 200);
      assert.strictEqual((await panel.call("GET", "api/auth/session")).status, 200, "密码会话保留");
      assert.strictEqual((await passkeyLogin(panel, authenticator)).status, 401, "删除后不能再登录");
      assert.strictEqual((await passkeyLogin(panel, keep)).status, 204);
    });

    await scenario("passkey 与域名绑定：PANEL_PUBLIC_URL 去掉或换了域名后不能用，启动时提示；改回后恢复", async (logs) => {
      const panel = await startAuthed({ publicUrl: PASSKEY_URL });
      const authenticator = await addPasskey(panel);
      const { dataDir } = panel.options;
      await panel.close();

      const withoutUrl = await startAuthed({ dataDir, publicUrl: "" });
      assert.ok(logs.some((line) => /已添加了 1 个 passkey，但 PANEL_PUBLIC_URL 没有设置为 HTTPS 地址/.test(line)));
      assert.strictEqual((await withoutUrl.call("GET", "api/auth/passkeys")).json.passkeys[0].usable, false);
      await withoutUrl.close();

      const moved = await startAuthed({ dataDir, publicUrl: "https://other.example/" });
      assert.ok(logs.some((line) => /已添加的 1 个 passkey 都不是在 other\.example 下添加的/.test(line)));
      assert.strictEqual((await moved.call("GET", "api/auth/passkeys")).json.passkeys[0].usable, false);
      assert.deepStrictEqual((await moved.call("POST", "api/auth/passkey/options", { purpose: "reauth" })).json.allowCredentials, []);
      const movedLogin = await passkeyLogin(moved, createSoftAuthenticator({ rpId: "other.example", origin: "https://other.example" }));
      assert.strictEqual(movedLogin.status, 401);
      // 不能用的 passkey 仍可删除
      assert.strictEqual((await moved.call("DELETE", `api/auth/passkeys/${authenticator.id}`)).status, 204);
      await moved.close();

      const panel2 = await startAuthed({ publicUrl: PASSKEY_URL });
      const authenticator2 = await addPasskey(panel2);
      const dataDir2 = panel2.options.dataDir;
      await panel2.close();
      const back = await start({ dataDir: dataDir2, password: "correct-horse", publicUrl: "https://example.com:9443/other-path/" });
      // 换端口与路径不影响：RP ID 仍是 example.com，origin 随外网地址变化
      const res = await passkeyLogin(back, authenticator2, { origin: "https://example.com:9443" });
      assert.strictEqual(res.status, 204);
    });

    await scenario("passkey 的 challenge：5 分钟后过期；登录用的数量有上限（同一 IP 另有上限），超出时丢弃最早的，挤不掉二次验证与添加用的", async () => {
      let t = Date.parse("2026-01-01T00:00:00Z");
      const dataDir = tempDir();
      const store = createStore(dataDir);
      const passkeys = createPasskeys({ store, relyingParty: { id: "example.com", origin: "https://example.com" }, now: () => t });
      const authenticator = createSoftAuthenticator(PASSKEY_RP);
      const token = "session-token";
      const registered = await passkeys.register(authenticator.register(await passkeys.registrationOptions(token)), "测试", token);
      assert.strictEqual(registered.name, "测试");
      await assert.rejects(
        passkeys.register(createSoftAuthenticator(PASSKEY_RP).register(await passkeys.registrationOptions(token)), "测试", "other-token"),
        /passkey 校验失败/,
        "添加用的 challenge 绑定会话"
      );

      const stale = await passkeys.loginOptions();
      t += 5 * 60 * 1000;
      assert.strictEqual(await passkeys.verifyLogin(authenticator.assert(stale)), null, "过期的 challenge");
      const fresh = await passkeys.loginOptions();
      assert.ok(await passkeys.verifyLogin(authenticator.assert(fresh)));

      const first = await passkeys.loginOptions();
      for (let i = 0; i < 100; i += 1) {
        await passkeys.loginOptions();
      }
      assert.strictEqual(await passkeys.verifyLogin(authenticator.assert(first)), null, "最早的 challenge 被丢弃");
      const latest = await passkeys.loginOptions();
      assert.ok(await passkeys.verifyLogin(authenticator.assert(latest)));

      // 未登录的请求再多，也挤不掉二次验证与添加用的 challenge
      const reauth = await passkeys.reauthOptions(token);
      const registration = await passkeys.registrationOptions(token);
      for (let i = 0; i < 110; i += 1) {
        await passkeys.loginOptions(`10.0.${i}.1`);
      }
      assert.ok(await passkeys.verifyReauth(authenticator.assert(reauth), token), "二次验证用的 challenge 保留");
      const added = await passkeys.register(createSoftAuthenticator(PASSKEY_RP).register(registration), "后加的", token);
      assert.strictEqual(added.name, "后加的", "添加用的 challenge 保留");

      // 同一 IP 同时有效的最多 5 个，超出时丢弃它自己最早的，其他 IP 的不受影响
      const own = await passkeys.loginOptions("192.0.2.1");
      const flood = [];
      for (let i = 0; i < 6; i += 1) {
        flood.push(await passkeys.loginOptions("192.0.2.2"));
      }
      assert.strictEqual(await passkeys.verifyLogin(authenticator.assert(flood[0])), null, "同一 IP 最早的被丢弃");
      assert.ok(await passkeys.verifyLogin(authenticator.assert(flood[1])));
      assert.ok(await passkeys.verifyLogin(authenticator.assert(own)), "其他 IP 的保留");
    });

    await scenario("panel.json 中 auth.passkeys、auth.passwordLogin 格式不对时视为损坏，不会被清空", async () => {
      const dataDir = tempDir();
      const file = path.join(dataDir, "panel.json");
      for (const passkeys of [{}, "x", [null], [{ id: "a" }]]) {
        fs.writeFileSync(file, JSON.stringify({ version: 1, auth: { passwordHash: "", passkeys } }), { mode: 0o600 });
        await assert.rejects(start({ dataDir, password: "correct-horse" }), /auth\.passkeys 必须是/);
      }
      for (const passwordLogin of ["false", 0, null]) {
        fs.writeFileSync(file, JSON.stringify({ version: 1, auth: { passwordHash: "", passwordLogin } }), { mode: 0o600 });
        await assert.rejects(start({ dataDir, password: "correct-horse" }), /auth\.passwordLogin 必须是 true 或 false/);
      }
    });

    await scenario("关闭密码登录：要求有可用的 passkey 并在 5 分钟内用它验证过；关闭后密码登录、密码二次验证与修改密码都被拒绝，其他密码会话立即失效", async () => {
      const panel = await startAuthed({ publicUrl: PASSKEY_URL, sseHeartbeatMs: 60000 });
      const toggle = (enabled, cookie = panel.cookie) => callAs(panel, cookie, "PATCH", "api/auth/password-login", { enabled });
      assert.deepStrictEqual((await panel.call("GET", "api/auth/session")).json.passwordLogin, {
        enabled: true,
        active: true,
        forced: false,
        reason: null,
      });
      const none = await toggle(false);
      assert.strictEqual(none.status, 409);
      assert.strictEqual(none.json.error, "no_usable_passkey");
      const authenticator = await addPasskey(panel);
      assert.strictEqual((await panel.call("PATCH", "api/auth/password-login", { enabled: "no" })).status, 400);
      assert.strictEqual((await panel.call("PATCH", "api/auth/password-login", { enabled: false, extra: 1 })).status, 400);

      // 用密码登录或用密码二次验证过都不够，要求用 passkey 验证
      const byPassword = await toggle(false);
      assert.strictEqual(byPassword.status, 403);
      assert.deepStrictEqual([byPassword.json.error, byPassword.json.method], ["reauth_required", "passkey"]);
      assert.strictEqual((await panel.call("POST", "api/auth/reauth", { password: "correct-horse" })).status, 204);
      assert.strictEqual((await panel.call("GET", "api/auth/session")).json.verifiedBy, "password");
      assert.strictEqual((await toggle(false)).status, 403);

      const other = sessionCookie(await login(panel, "correct-horse"));
      const events = await openEvents(panel.port, other);
      await until(() => events.events.length > 0);
      const viaPasskey = sessionCookie(await passkeyLogin(panel, authenticator));
      const options = await panel.call("POST", "api/auth/passkey/options", { purpose: "reauth" });
      assert.strictEqual((await panel.call("POST", "api/auth/reauth", { passkey: authenticator.assert(options.json) })).status, 204);
      const off = await toggle(false);
      assert.strictEqual(off.status, 200, JSON.stringify(off.json));
      assert.deepStrictEqual(off.json.passwordLogin, { enabled: false, active: false, forced: false, reason: null });
      await Promise.race([events.closed, new Promise((_, reject) => setTimeout(() => reject(new Error("推送连接没有立即断开")), 1000))]);
      assert.strictEqual((await callAs(panel, other, "GET", "api/auth/session")).status, 401, "其他密码会话失效");
      assert.strictEqual((await callAs(panel, viaPasskey, "GET", "api/auth/session")).status, 200, "passkey 会话保留");
      assert.strictEqual((await panel.call("GET", "api/auth/session")).status, 200, "当前会话保留");
      assert.strictEqual(JSON.parse(fs.readFileSync(path.join(panel.options.dataDir, "panel.json"), "utf8")).auth.passwordLogin, false);

      assert.strictEqual((await panel.request("api/auth/methods")).json.password, false);
      for (const password of ["correct-horse", "wrong"]) {
        const denied = await login(panel, password);
        assert.strictEqual(denied.status, 403);
        assert.strictEqual(denied.json.error, "password_login_disabled");
        assert.strictEqual(sessionCookie(denied), "");
      }
      const reauthByPassword = await panel.call("POST", "api/auth/reauth", { password: "correct-horse" });
      assert.strictEqual(reauthByPassword.status, 403);
      assert.strictEqual(reauthByPassword.json.error, "password_login_disabled");
      const change = await panel.call("POST", "api/auth/password", { current: "correct-horse", next: "another-horse" });
      assert.strictEqual(change.status, 409);
      assert.strictEqual(change.json.error, "password_login_disabled");

      // 不能删除最后一个可用的 passkey；还有其他可用的时可以删
      const last = await panel.call("DELETE", `api/auth/passkeys/${authenticator.id}`);
      assert.strictEqual(last.status, 409);
      assert.strictEqual(last.json.error, "last_passkey");
      const second = await addPasskey(panel, "第二个");
      assert.strictEqual((await panel.call("DELETE", `api/auth/passkeys/${authenticator.id}`)).status, 204);
      assert.strictEqual((await panel.call("DELETE", `api/auth/passkeys/${second.id}`)).status, 409);

      // 打开密码登录只要求 5 分钟内验证过；打开后恢复原来的密码，最后一个 passkey 也可以删除
      const on = await toggle(true);
      assert.strictEqual(on.status, 200);
      assert.strictEqual(on.json.passwordLogin.active, true);
      assert.strictEqual((await login(panel, "correct-horse")).status, 204);
      assert.strictEqual((await panel.call("DELETE", `api/auth/passkeys/${second.id}`)).status, 204);
    });

    await scenario("密码登录关闭后的应急恢复：PANEL_FORCE_PASSWORD_LOGIN、换了域名或去掉 PANEL_PUBLIC_URL 时仍允许密码登录并提示，不修改设置", async (logs) => {
      const panel = await startAuthed({ publicUrl: PASSKEY_URL, limits: { reauthWindowMs: 300 } });
      const authenticator = await addPasskey(panel);
      // 二次验证过期后打开密码登录同样需要验证；密码登录关闭时只能用 passkey 验证
      const options = await panel.call("POST", "api/auth/passkey/options", { purpose: "reauth" });
      assert.strictEqual((await panel.call("POST", "api/auth/reauth", { passkey: authenticator.assert(options.json) })).status, 204);
      assert.strictEqual((await panel.call("PATCH", "api/auth/password-login", { enabled: false })).status, 200);
      await new Promise((resolve) => setTimeout(resolve, 350));
      const expired = await panel.call("PATCH", "api/auth/password-login", { enabled: true });
      assert.strictEqual(expired.status, 403);
      assert.strictEqual(expired.json.error, "reauth_required");
      assert.strictEqual(expired.json.method, undefined);
      const { dataDir } = panel.options;
      await panel.close();
      const restart = (overrides) => start({ dataDir, password: "correct-horse", ...overrides });

      const forced = await restart({ publicUrl: PASSKEY_URL, forcePasswordLogin: true });
      assert.ok(logs.some((line) => /PANEL_FORCE_PASSWORD_LOGIN 已生效/.test(line)));
      const forcedLogin = await login(forced, "correct-horse");
      assert.strictEqual(forcedLogin.status, 204);
      assert.deepStrictEqual((await callAs(forced, sessionCookie(forcedLogin), "GET", "api/auth/session")).json.passwordLogin, {
        enabled: false,
        active: true,
        forced: true,
        reason: "forced",
      });
      assert.strictEqual((await forced.request("api/auth/methods")).json.password, true);
      assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dataDir, "panel.json"), "utf8")).auth.passwordLogin, false, "不修改设置");
      await forced.close();

      const normal = await restart({ publicUrl: PASSKEY_URL });
      assert.strictEqual((await login(normal, "correct-horse")).status, 403, "去掉变量后恢复原来的设置");
      await normal.close();

      const moved = await restart({ publicUrl: "https://other.example/" });
      assert.ok(logs.some((line) => /当前域名下没有可用的 passkey，暂时允许用密码登录/.test(line)));
      const movedLogin = await login(moved, "correct-horse");
      assert.strictEqual(movedLogin.status, 204);
      const movedCookie = sessionCookie(movedLogin);
      assert.strictEqual((await callAs(moved, movedCookie, "GET", "api/auth/session")).json.passwordLogin.reason, "no_usable_passkey");
      // 换了域名后旧的 passkey 不可用，不受“最后一个”的限制
      assert.strictEqual((await callAs(moved, movedCookie, "DELETE", `api/auth/passkeys/${authenticator.id}`)).status, 204);
      await moved.close();

      const withoutUrl = await restart({ publicUrl: "" });
      assert.strictEqual((await login(withoutUrl, "correct-horse")).status, 204);

      // 密码登录本来就打开时设置 PANEL_FORCE_PASSWORD_LOGIN 只给出提示
      await start({ password: "correct-horse", forcePasswordLogin: true });
      assert.ok(logs.some((line) => /密码登录本来就是打开的/.test(line)));
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
      // 账号目录保存 cookies 与登录二维码，只允许属主访问
      assert.strictEqual(fs.statSync(path.join(accountsDir, "me")).mode & 0o777, 0o700);

      assert.strictEqual((await panel.call("POST", "api/accounts", { id: "me" })).status, 409);
      for (const id of ["Bad_ID", "-x", "x-", "a".repeat(33), "../etc"]) {
        assert.strictEqual((await panel.call("POST", "api/accounts", { id })).status, 400, id);
      }
      assert.strictEqual((await panel.call("POST", "api/accounts", { id: "long", name: "名".repeat(33) })).status, 400);
      assert.strictEqual((await panel.call("POST", "api/accounts", "null")).status, 400);
      const typo = await panel.call("POST", "api/accounts", { id: "typo", nmae: "拼错" });
      assert.deepStrictEqual([typo.status, typo.json.message], [400, "不支持的字段：nmae"]);
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

      // 数据目录建不出来时接口失败且不保存账号，修正后可以重试
      fs.writeFileSync(path.join(accountsDir, "blocked"), "not a directory");
      const blocked = await panel.call("POST", "api/accounts", { id: "blocked" });
      assert.deepStrictEqual([blocked.status, blocked.json.error], [500, "account_dir_failed"]);
      assert.strictEqual((await panel.call("GET", "api/accounts/blocked")).status, 404);
      fs.rmSync(path.join(accountsDir, "blocked"));
      assert.strictEqual((await panel.call("POST", "api/accounts", { id: "blocked" })).status, 201);
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

    await scenario("没有设置 SELENIUM_URL 时，把旧版写入的 http://selenium:4444 清空，改用内置浏览器；其他地址与设置了 SELENIUM_URL 时不变", async () => {
      const dataDir = tempDir();
      const file = path.join(dataDir, "panel.json");
      const legacy = {
        version: 1,
        auth: { passwordHash: await hashPassword("old-password") },
        defaults: { seleniumUrl: "http://selenium:4444/", duration: "30" },
        accounts: [
          { id: "legacy", name: "旧地址", overrides: { seleniumUrl: "selenium:4444" } },
          { id: "custom", name: "自定义", overrides: { seleniumUrl: "http://grid.lan:4444" } },
          { id: "plain", name: "未覆盖" },
        ],
      };
      fs.writeFileSync(file, JSON.stringify(legacy), { mode: 0o600 });
      const kept = await start({ dataDir, seleniumUrl: "http://selenium:4444" });
      await kept.close();
      assert.strictEqual(JSON.parse(fs.readFileSync(file, "utf8")).defaults.seleniumUrl, "http://selenium:4444/", "设置了 SELENIUM_URL 时不迁移");

      const panel = await start({ dataDir });
      const migrated = JSON.parse(fs.readFileSync(file, "utf8"));
      assert.deepStrictEqual(migrated.defaults, { duration: "30" });
      assert.deepStrictEqual(
        migrated.accounts.map((account) => [account.id, account.overrides]),
        [
          ["legacy", {}],
          ["custom", { seleniumUrl: "http://grid.lan:4444" }],
          ["plain", undefined],
        ]
      );
      await panel.close();
    });

    await scenario("panel.json 修改前保存上一版；损坏时备份损坏文件并从上一版恢复，上一版也不可用时拒绝启动", async () => {
      const first = await startAuthed();
      await first.call("POST", "api/accounts", { id: "keep-1" });
      await first.call("POST", "api/accounts", { id: "keep-2" });
      await first.close();
      const { dataDir } = first.options;
      const file = path.join(dataDir, "panel.json");
      const backup = JSON.parse(fs.readFileSync(`${file}.bak`, "utf8"));
      assert.deepStrictEqual(backup.accounts.map((account) => account.id), ["keep-1"]);
      assert.strictEqual(fs.statSync(`${file}.bak`).mode & 0o777, 0o600);

      // 模拟断电后的空文件；损坏文件的副本只保留最近 3 份
      for (const stamp of [1000000000001, 1000000000002, 1000000000003]) {
        fs.writeFileSync(`${file}.corrupt-${stamp}`, "old");
      }
      fs.writeFileSync(file, "");
      const restored = await startAuthed({ dataDir });
      assert.deepStrictEqual((await restored.call("GET", "api/accounts")).json.accounts.map((account) => account.id), ["keep-1"]);
      const copies = fs.readdirSync(dataDir).filter((name) => name.startsWith("panel.json.corrupt-")).sort();
      assert.strictEqual(copies.length, 3);
      assert.ok(!copies.includes("panel.json.corrupt-1000000000001"), "最早的副本应被删除");
      assert.strictEqual(fs.readFileSync(path.join(dataDir, copies[2]), "utf8"), "", "最新的副本是这次损坏的文件");
      assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, "utf8")).accounts.map((account) => account.id), ["keep-1"]);
      await restored.call("POST", "api/accounts", { id: "keep-3" });
      await restored.close();

      // panel.json 不见了（例如恢复过程中崩溃）时从上一版恢复，第一次修改不会用空数据覆盖上一版
      fs.rmSync(file);
      const missing = await startAuthed({ dataDir });
      assert.deepStrictEqual((await missing.call("GET", "api/accounts")).json.accounts.map((account) => account.id), ["keep-1"]);
      await missing.call("POST", "api/accounts", { id: "keep-4" });
      assert.deepStrictEqual(JSON.parse(fs.readFileSync(`${file}.bak`, "utf8")).accounts.map((account) => account.id), ["keep-1"]);
      await missing.close();

      fs.writeFileSync(file, "{broken");
      fs.writeFileSync(`${file}.bak`, "{broken too");
      await assert.rejects(start({ dataDir, password: "correct-horse" }), /也没有可用的上一版/);
    });

    await scenario("panel.json 结构不对（例如 accounts 不是数组）时视为损坏：从上一版恢复，不会清空账号", async () => {
      const first = await startAuthed();
      await first.call("POST", "api/accounts", { id: "keep-1" });
      await first.call("POST", "api/accounts", { id: "keep-2" });
      await first.close();
      const { dataDir } = first.options;
      const file = path.join(dataDir, "panel.json");
      const good = JSON.parse(fs.readFileSync(file, "utf8"));
      fs.writeFileSync(file, JSON.stringify({ ...good, accounts: { "keep-1": {} } }));
      const restored = await startAuthed({ dataDir });
      assert.deepStrictEqual((await restored.call("GET", "api/accounts")).json.accounts.map((account) => account.id), ["keep-1"]);
      await restored.close();

      for (const broken of [{ ...good, accounts: "me" }, { ...good, settings: "Asia/Shanghai" }, { ...good, accounts: [{ id: "x", schedules: {} }] }, { ...good, accounts: null }, { ...good, auth: null }, { ...good, settings: null }, []]) {
        fs.writeFileSync(file, JSON.stringify(broken));
        fs.writeFileSync(`${file}.bak`, JSON.stringify(broken));
        await assert.rejects(start({ dataDir, password: "correct-horse" }), /也没有可用的上一版/, JSON.stringify(broken));
        assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, "utf8")), broken, "结构不对的文件不应被改写");
      }
    });

    await scenario("panel.json 中手工写入的无效账号 ID 在启动时拒绝", async () => {
      const dataDir = tempDir();
      fs.writeFileSync(path.join(dataDir, "panel.json"), JSON.stringify({ version: 1, auth: { passwordHash: "" }, accounts: [{ id: "../x" }] }), { mode: 0o600 });
      await assert.rejects(start({ dataDir, password: "correct-horse" }), /panel\.json 中有无效的账号 ID：\.\.\/x/);
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
        // 运行日志与阅读截图属于阅读隐私，只允许属主访问
        assert.strictEqual(fs.statSync(files.dir).mode & 0o777, 0o700);
        assert.strictEqual(fs.statSync(path.dirname(files.dir)).mode & 0o777, 0o700);
        for (const name of ["output.log", "meta.json"]) {
          assert.strictEqual(fs.statSync(path.join(files.dir, name)).mode & 0o777, 0o600, name);
        }
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

    await scenario("停止：子进程收到 SIGTERM 后退出记为已停止；不响应时超时强制结束；两种情况都删除 Selenium 会话", async () => {
      const selenium = await startMockSelenium();
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
        const slowLog = await runFiles(panel, "slow-1", slow.id).log();
        assert.match(slowLog, /收到 SIGTERM，关闭浏览器/);
        // 正常退出的子进程通常已经关闭了浏览器，仍请求删除一次会话：关闭浏览器失败时会话也不会残留
        assert.match(slowLog, /已请求 Selenium 删除会话 stub-session-slow-1（HTTP 200）/);

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
        // 顺序是确定的：面板删除会话后才把 slow-1 记为结束，上面等到它结束后才停止 stubborn-1
        assert.deepStrictEqual(selenium.requests, ["DELETE /session/stub-session-slow-1", "DELETE /session/stub-session-stubborn-1"]);
        assert.strictEqual(selenium.state.sessionAuthorization, "");

        // Selenium 地址带用户名与密码时，删除会话改用 Authorization 请求头
        await panel.call("PATCH", "api/settings", {
          defaults: { seleniumUrl: selenium.url.replace("://", "://robot:p%40ss@") },
        });
        const authReading = nextRun(panel, (run) => run.accountId === "stubborn-2" && run.status === "reading");
        await panel.call("POST", "api/accounts", { id: "stubborn-2" });
        await panel.call("POST", "api/accounts/stubborn-2/runs");
        await authReading;
        const authEnded = nextRun(panel, ended("stubborn-2"));
        await panel.call("POST", "api/accounts/stubborn-2/stop");
        const authRun = await authEnded;
        assert.match(await runFiles(panel, "stubborn-2", authRun.id).log(), /已请求 Selenium 删除会话 stub-session-stubborn-2（HTTP 200）/);
        assert.strictEqual(selenium.requests.at(-1), "DELETE /session/stub-session-stubborn-2");
        assert.strictEqual(selenium.state.sessionAuthorization, `Basic ${Buffer.from("robot:p@ss").toString("base64")}`);

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

    await scenario("二维码解析不出登录链接时提供这次运行的二维码截图；没有等待扫码时返回 404；面板地址下发给子进程", async () => {
      const panel = await startAuthed({ publicUrl: "https://example.com/weread/" });
      await panel.call("POST", "api/accounts", { id: "qrimg-1" });
      // 之前运行留下的截图不返回
      const stale = path.join(panel.options.dataDir, "accounts", "qrimg-1", "login.png");
      fs.writeFileSync(stale, "old");
      fs.utimesSync(stale, new Date(Date.now() - 3600000), new Date(Date.now() - 3600000));
      assert.strictEqual((await panel.call("GET", "api/accounts/qrimg-1/login-qr")).status, 404);
      const waiting = nextRun(panel, (run) => run.accountId === "qrimg-1" && run.status === "waiting-login");
      await panel.call("POST", "api/accounts/qrimg-1/runs", { mode: "login" });
      const run = await waiting;
      assert.strictEqual(run.loginUrl, "");
      assert.ok(run.loginQrAt);
      const image = await panel.call("GET", "api/accounts/qrimg-1/login-qr");
      assert.strictEqual(image.status, 200);
      assert.strictEqual(image.headers.get("content-type"), "image/png");
      assert.strictEqual(image.headers.get("cache-control"), "no-store");
      assert.strictEqual((await panel.request("api/accounts/qrimg-1/login-qr")).status, 401);
      assert.strictEqual((await panel.call("GET", "api/accounts/nobody/login-qr")).status, 404);
      // 之后只更新了整页截图（例如刷新后二维码图片还没加载）：不再返回旧的二维码区域截图
      const later = new Date(Date.now() + 5000);
      fs.writeFileSync(stale, "page");
      fs.utimesSync(stale, later, later);
      const pageImage = await panel.call("GET", "api/accounts/qrimg-1/login-qr");
      assert.strictEqual(pageImage.text, "page");
      const finished = nextRun(panel, ended("qrimg-1"));
      await panel.call("POST", "api/accounts/qrimg-1/stop");
      await finished;
      assert.match(await runFiles(panel, "qrimg-1", run.id).log(), /panelLink=https:\/\/example\.com\/weread\/#\/accounts\/qrimg-1\/live/);
      assert.strictEqual((await panel.call("GET", "api/accounts/qrimg-1/login-qr")).status, 404);
      assert.ok(!("loginQrAt" in runFiles(panel, "qrimg-1", run.id).meta()));
    });

    await scenario("进度跳过的分钟按时间均匀补记；分钟数不超过本次阅读时长（含 1 分钟余量）", async () => {
      const panel = await startAuthed();
      await panel.call("POST", "api/accounts", { id: "skip-1" });
      await panel.call("PATCH", "api/accounts/skip-1", { overrides: { duration: 5 } });
      const finished = nextRun(panel, ended("skip-1"));
      await panel.call("POST", "api/accounts/skip-1/runs");
      const run = await finished;
      assert.strictEqual(run.minutes, 6);
      const marks = runFiles(panel, "skip-1", run.id).meta().minuteMarks.map((mark) => Date.parse(mark));
      assert.strictEqual(marks.length, 6);
      // 第 2–4 分钟在第 1 分钟与第 5 分钟之间，各不相同
      assert.ok(marks[0] < marks[1] && marks[1] < marks[2] && marks[2] < marks[3] && marks[3] < marks[4], "补记的分钟应递增");
      assert.ok(marks.every((mark, i) => i === 0 || mark >= marks[i - 1]));
    });

    await scenario("超过运行时长上限时结束子进程并记为失败", async () => {
      const panel = await startAuthed({ runner: { workerPath: STUB_WORKER, killTimeoutMs: 500, runTimeoutMs: 300 } });
      await panel.call("POST", "api/accounts", { id: "hang-1" });
      const finished = nextRun(panel, ended("hang-1"));
      await panel.call("POST", "api/accounts/hang-1/runs");
      const run = await finished;
      assert.deepStrictEqual([run.status, run.error], ["failed", "运行超时，已强制结束"]);
    });

    await scenario("停止后、子进程退出前到达运行时长上限时仍记为已停止", async () => {
      const panel = await startAuthed({ runner: { workerPath: STUB_WORKER, killTimeoutMs: 1500, runTimeoutMs: 1000 } });
      await panel.call("POST", "api/accounts", { id: "stubborn-1" });
      const reading = nextRun(panel, (run) => run.accountId === "stubborn-1" && run.status === "reading");
      await panel.call("POST", "api/accounts/stubborn-1/runs");
      await reading;
      const finished = nextRun(panel, ended("stubborn-1"));
      await panel.call("POST", "api/accounts/stubborn-1/stop");
      const run = await finished;
      assert.deepStrictEqual([run.status, run.error], ["stopped", ""]);
      assert.strictEqual(runFiles(panel, "stubborn-1", run.id).meta().exitSignal, "SIGKILL");
    });

    await scenario("启动运行出错时记为失败并释放账号，不会一直排队", async () => {
      const panel = await startAuthed();
      await panel.call("POST", "api/accounts", { id: "broken-1" });
      // 账号数据目录被同名文件占用，启动时无法创建
      const dir = path.join(panel.options.dataDir, "accounts", "broken-1");
      fs.rmSync(dir, { recursive: true, force: true });
      fs.writeFileSync(dir, "not a directory");
      const res = await panel.call("POST", "api/accounts/broken-1/runs");
      assert.strictEqual(res.status, 202);
      assert.strictEqual(res.json.run.status, "failed");
      assert.match(res.json.run.error, /无法创建账号数据目录/);
      assert.deepStrictEqual((await panel.call("GET", "api/runs")).json.runs, []);
      assert.strictEqual((await panel.call("POST", "api/accounts/broken-1/runs")).json.run.status, "failed");
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

    await scenario("Selenium 状态：需要登录；按全局默认与账号覆盖分组并列出使用的账号；解析 Grid 与 chromedriver 的会话数；区分面板自己的会话；地址中不显示用户名与密码", async () => {
      const grid = await startMockSelenium();
      const driver = await startMockSelenium({ mode: "driver" });
      try {
        const panel = await startAuthed();
        assert.strictEqual((await panel.request("api/selenium/status")).status, 401);
        await panel.call("PATCH", "api/settings", { settings: { maxConcurrentRuns: 3 }, defaults: { seleniumUrl: `${grid.url}/` } });
        for (const id of ["slow-1", "ok-1", "ok-2"]) {
          await panel.call("POST", "api/accounts", { id, name: `账号${id}` });
        }
        // 没有协议、带用户名与密码的地址
        await panel.call("PATCH", "api/accounts/ok-2", { overrides: { seleniumUrl: `robot:pass-9527@127.0.0.1:${driver.port}` } });

        let res = await panel.call("GET", "api/selenium/status");
        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.json.maxConcurrentRuns, 3);
        assert.ok(!Number.isNaN(Date.parse(res.json.checkedAt)));
        assert.doesNotMatch(JSON.stringify(res.json), /robot|pass-9527/, "接口不应返回地址中的用户名与密码");
        const [defaultServer, driverServer] = res.json.servers;
        assert.strictEqual(res.json.servers.length, 2);
        assert.deepStrictEqual(defaultServer, {
          url: grid.url,
          builtin: false,
          isDefault: true,
          accounts: [
            { id: "slow-1", name: "账号slow-1" },
            { id: "ok-1", name: "账号ok-1" },
          ],
          panelRuns: 0,
          state: "ready",
          ready: true,
          message: "Selenium Grid ready.",
          sessions: { used: 0, total: 1 },
          nodes: 1,
          error: "",
        });
        assert.deepStrictEqual(
          driverServer,
          {
            url: driver.url,
            builtin: false,
            isDefault: false,
            accounts: [{ id: "ok-2", name: "账号ok-2" }],
            panelRuns: 0,
            state: "ready",
            ready: true,
            message: "ChromeDriver ready for new sessions.",
            sessions: null,
            nodes: null,
            error: "",
          }
        );
        assert.strictEqual(driver.state.authorization, `Basic ${Buffer.from("robot:pass-9527").toString("base64")}`, "查询时应带上地址中的用户名与密码");

        // 面板的运行占用会话：panelRuns 计入；会话全部占用时为 busy 而不是未就绪
        const reading = nextRun(panel, (run) => run.accountId === "slow-1" && run.status === "reading");
        await panel.call("POST", "api/accounts/slow-1/runs");
        await reading;
        grid.state.used = 1;
        res = await panel.call("GET", "api/selenium/status");
        assert.deepStrictEqual(
          [res.json.servers[0].state, res.json.servers[0].ready, res.json.servers[0].sessions, res.json.servers[0].panelRuns],
          ["busy", false, { used: 1, total: 1 }, 1]
        );
        assert.strictEqual(res.json.servers[1].panelRuns, 0);
        const stopped = nextRun(panel, ended("slow-1"));
        await panel.call("POST", "api/accounts/slow-1/stop");
        await stopped;
        res = await panel.call("GET", "api/selenium/status");
        assert.deepStrictEqual([res.json.servers[0].state, res.json.servers[0].panelRuns], ["busy", 0], "运行结束后会话不再算作面板的");

        // 多个会话槽位
        Object.assign(grid.state, { maxSessions: 3, used: 1 });
        res = await panel.call("GET", "api/selenium/status");
        assert.deepStrictEqual([res.json.servers[0].state, res.json.servers[0].sessions], ["ready", { used: 1, total: 3 }]);
        // 节点不可用时不计入总会话数，状态为未就绪
        grid.state.availability = "DOWN";
        res = await panel.call("GET", "api/selenium/status");
        assert.deepStrictEqual(
          [res.json.servers[0].state, res.json.servers[0].sessions, res.json.servers[0].message],
          ["not-ready", { used: 1, total: 0 }, "Selenium Grid not ready."]
        );
        grid.state.availability = "UP";

        // 所有账号都覆盖了地址时，全局默认地址仍然列出
        const otherUrl = `http://localhost:${grid.port}`;
        await panel.call("PATCH", "api/accounts/slow-1", { overrides: { seleniumUrl: otherUrl } });
        await panel.call("PATCH", "api/accounts/ok-1", { overrides: { seleniumUrl: otherUrl } });
        res = await panel.call("GET", "api/selenium/status");
        assert.deepStrictEqual(
          res.json.servers.map((server) => [server.url, server.isDefault, server.accounts.map((account) => account.id)]),
          [
            [grid.url, true, []],
            [otherUrl, false, ["slow-1", "ok-1"]],
            [driver.url, false, ["ok-2"]],
          ]
        );
      } finally {
        await grid.stop();
        await driver.stop();
      }
    });

    await scenario("Selenium 状态：地址为空时检查内置浏览器，显示浏览器版本；找不到、无法运行或 chromedriver 与浏览器主版本不一致时为 unreachable 并附带原因", async () => {
      const binDir = tempDir();
      const fake = (name, output) => {
        const file = path.join(binDir, name);
        fs.writeFileSync(file, `#!/bin/sh\necho "${output}"\n`, { mode: 0o755 });
        return file;
      };
      const saved = { PATH: process.env.PATH, CHROME_BIN: process.env.CHROME_BIN, CHROMEDRIVER_PATH: process.env.CHROMEDRIVER_PATH };
      const restore = () => {
        for (const [key, value] of Object.entries(saved)) {
          if (value === undefined) {
            delete process.env[key];
          } else {
            process.env[key] = value;
          }
        }
      };
      try {
        delete process.env.CHROME_BIN;
        delete process.env.CHROMEDRIVER_PATH;
        process.env.PATH = binDir;
        const panel = await startAuthed();
        await panel.call("POST", "api/accounts", { id: "local-1", name: "本机" });
        const check = async () => (await panel.call("GET", "api/selenium/status")).json.servers;

        let servers = await check();
        assert.strictEqual(servers.length, 1);
        assert.deepStrictEqual(
          [servers[0].url, servers[0].builtin, servers[0].isDefault, servers[0].state, servers[0].error],
          ["", true, true, "unreachable", "找不到 chromedriver 与 Chromium"]
        );

        fake("chromedriver", "ChromeDriver 155.0.8059.84");
        fake("chromium-browser", "Chromium 155.0.8059.84 Alpine Linux");
        servers = await check();
        assert.deepStrictEqual(
          [servers[0].state, servers[0].ready, servers[0].message, servers[0].sessions, servers[0].accounts],
          ["ready", true, "Chromium 155.0.8059.84 Alpine Linux", null, [{ id: "local-1", name: "本机" }]]
        );

        // chromedriver 与浏览器的主版本不一致
        fake("chromedriver", "ChromeDriver 154.0.7999.1");
        servers = await check();
        assert.deepStrictEqual(
          [servers[0].state, servers[0].error],
          ["unreachable", "chromedriver 与 Chromium 的主版本不一致（chromedriver 154，Chromium 155）"]
        );

        // 用环境变量指定的浏览器无法运行
        process.env.CHROME_BIN = path.join(binDir, "missing-chrome");
        servers = await check();
        assert.strictEqual(servers[0].state, "unreachable");
        assert.match(servers[0].error, /无法读取浏览器版本/);
      } finally {
        restore();
      }
    });

    await scenario("Selenium 状态：停止、不是 Selenium、超时（含持续缓慢发送数据）、响应中途断开都返回 unreachable 与原因；旧版地址回退到 /wd/hub/status", async () => {
      const selenium = await startMockSelenium();
      try {
        const panel = await startAuthed({ seleniumTimeoutMs: 300 });
        await panel.call("PATCH", "api/settings", { defaults: { seleniumUrl: selenium.url } });
        const check = async () => (await panel.call("GET", "api/selenium/status")).json.servers[0];

        await selenium.stop();
        let server = await check();
        assert.deepStrictEqual([server.state, server.ready, server.sessions], ["unreachable", false, null]);
        assert.match(server.error, /连接被拒绝（ECONNREFUSED）/);

        await selenium.start();
        selenium.state.mode = "html";
        server = await check();
        assert.strictEqual(server.state, "unreachable");
        assert.match(server.error, /返回的不是 Selenium 状态/);

        selenium.state.mode = "hang";
        selenium.requests.length = 0;
        const startedAt = Date.now();
        server = await check();
        assert.strictEqual(server.state, "unreachable");
        assert.match(server.error, /0\.3 秒内没有响应/);
        assert.ok(Date.now() - startedAt < 3000, "超时后应及时返回");
        assert.deepStrictEqual(selenium.requests, ["GET /status"], "超时后不再尝试下一个地址");

        // 超时是整个请求的时限：对端不停缓慢发送数据（连接从不空闲）时同样按时返回
        selenium.state.mode = "drip";
        selenium.requests.length = 0;
        const dripStartedAt = Date.now();
        server = await check();
        assert.strictEqual(server.state, "unreachable");
        assert.match(server.error, /0\.3 秒内没有响应/);
        assert.ok(Date.now() - dripStartedAt < 3000, "持续收到数据时也应按时返回");
        assert.deepStrictEqual(selenium.requests, ["GET /status"]);

        // 响应中途断开时不会一直等待
        selenium.state.mode = "cut";
        server = await check();
        assert.strictEqual(server.state, "unreachable");
        assert.match(server.error, /连接被重置（ECONNRESET）/);

        selenium.state.mode = "legacy";
        selenium.requests.length = 0;
        server = await check();
        assert.deepStrictEqual([server.state, server.sessions], ["ready", { used: 0, total: 1 }]);
        assert.deepStrictEqual(selenium.requests, ["GET /status", "GET /wd/hub/status"]);

        // 同时到达的查询共用一次请求
        Object.assign(selenium.state, { mode: "grid", delayMs: 200 });
        selenium.requests.length = 0;
        await Promise.all([check(), check(), check()]);
        assert.deepStrictEqual(selenium.requests, ["GET /status"]);
      } finally {
        await selenium.stop();
      }
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
      // 移开第二个目录（运行记录）失败时，已移开的账号目录改回原名，账号与数据都保留，可以重试
      await panel.call("POST", "api/accounts", { id: "slow-2" });
      await panel.call("POST", "api/accounts/slow-2/runs");
      const stopped = nextRun(panel, ended("slow-2"));
      await panel.call("POST", "api/accounts/slow-2/stop");
      await stopped;
      const rename = fs.renameSync;
      fs.renameSync = (from, to) => {
        if (from === path.join(panel.options.dataDir, "runs", "slow-2")) {
          throw Object.assign(new Error("EIO: simulated"), { code: "EIO" });
        }
        return rename(from, to);
      };
      let failed;
      try {
        failed = await panel.call("DELETE", "api/accounts/slow-2", { deleteData: true });
      } finally {
        fs.renameSync = rename;
      }
      assert.deepStrictEqual([failed.status, failed.json.error], [500, "delete_data_failed"]);
      assert.strictEqual((await panel.call("GET", "api/accounts/slow-2")).status, 200);
      assert.ok(fs.existsSync(path.join(panel.options.dataDir, "accounts", "slow-2")), "账号目录应改回原名");
      assert.ok(fs.existsSync(path.join(panel.options.dataDir, "runs", "slow-2")));
      assert.strictEqual((await panel.call("DELETE", "api/accounts/slow-2", { deleteData: true })).status, 204);
      // 数据目录先移开、写入后再删除，不留下临时目录
      for (const dir of ["accounts", "runs"]) {
        assert.deepStrictEqual(fs.readdirSync(path.join(panel.options.dataDir, dir)).filter((name) => name.startsWith(".deleting-")), [], dir);
      }
    });

    await scenario("升级前创建的运行记录目录在启动时收紧为 0700", async () => {
      const dataDir = tempDir();
      const oldRun = path.join(dataDir, "runs", "old-1", "20261001T000000Z-abcd");
      fs.mkdirSync(oldRun, { recursive: true, mode: 0o755 });
      fs.chmodSync(path.join(dataDir, "runs"), 0o755);
      fs.chmodSync(path.join(dataDir, "runs", "old-1"), 0o755);
      fs.writeFileSync(path.join(oldRun, "output.log"), "old\n", { mode: 0o644 });
      await start({ dataDir, password: "correct-horse" });
      for (const dir of ["runs", path.join("runs", "old-1")]) {
        assert.strictEqual(fs.statSync(path.join(dataDir, dir)).mode & 0o777, 0o700, dir);
      }
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
                { id: "notimes", type: "daily", enabled: true },
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

      // 无效规则在接口中没有触发时间，不影响读取；缺少字段的规则说明为“无效规则”，账号列表照常返回
      const account = await panel.request("api/accounts/slow-1", { cookie });
      assert.deepStrictEqual(account.json.account.schedules.find((rule) => rule.id === "broken").nextRuns, []);
      const notimes = account.json.account.schedules.find((rule) => rule.id === "notimes");
      assert.deepStrictEqual([notimes.description, notimes.nextRuns], ["无效规则（daily）", []]);
      assert.strictEqual((await panel.request("api/accounts", { cookie })).status, 200);
      assert.strictEqual((await panel.request("api/accounts/slow-1/schedules", { cookie })).status, 200);

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
      // 更早的记录读不出来（meta.json 损坏）时，最后一页不再提供下一页
      const corruptId = writeRun(panel.options.dataDir, "ok-1", { queuedAt: "2020-01-01T00:00:00.000Z" });
      const corruptDir = path.join(panel.options.dataDir, "runs", "ok-1", corruptId);
      fs.writeFileSync(path.join(corruptDir, "meta.json"), "{");
      const whole = await panel.call("GET", "api/accounts/ok-1/runs?limit=3");
      assert.deepStrictEqual([whole.json.runs.map((run) => run.id), whole.json.nextBefore], [[third, second, first], null]);
      const lastPage = await panel.call("GET", `api/accounts/ok-1/runs?limit=2&before=${second}`);
      assert.deepStrictEqual([lastPage.json.runs.map((run) => run.id), lastPage.json.nextBefore], [[first], null]);
      assert.strictEqual((await panel.call("GET", "api/accounts/ok-1/runs?limit=2")).json.nextBefore, second);
      fs.rmSync(corruptDir, { recursive: true });
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
      for (const challenge of [{ type: "week", startDate: "2026-04-01" }, { type: "constructor", startDate: "2026-04-01" }, { type: "__proto__", startDate: "2026-04-01" }, { type: "toString", startDate: "2026-04-01" }, { type: "month", startDate: "2026-02-30" }, { type: "month", startDate: "2026/04/01" }, { type: "month", startDate: "2026-04-01", x: 1 }, "month"]) {
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
      // 旧版本保存下来的继承属性类型：没有进度，不让账号详情与打卡日历出错
      assert.strictEqual(challengeProgress(dataDir, { id: "ch", challenge: { type: "constructor", startDate: "2026-04-01" } }, { timezone }), null);
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
