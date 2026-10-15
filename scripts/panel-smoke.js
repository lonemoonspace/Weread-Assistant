#!/usr/bin/env node
/**
 * 面板 smoke 测试：在本机启动面板，用 HTTP 请求验证鉴权、会话、限速、反向代理与安全响应头。
 * 不需要浏览器与 Selenium。
 * 用法: node scripts/panel-smoke.js
 */

const assert = require("assert");
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");

const { startPanel } = require(path.resolve(__dirname, "..", "src", "panel", "server"));

const CSRF = { "X-WA-Request": "1" };

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
    ...overrides,
  };
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

      const logout = await panel.request("api/auth/logout", { method: "POST", body: {}, headers: CSRF, cookie });
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
