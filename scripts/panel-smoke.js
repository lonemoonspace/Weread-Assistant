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
const { hashPassword } = require(path.resolve(__dirname, "..", "src", "panel", "auth"));
const { SECRET_MASK, resolveAccountConfig } = require(path.resolve(__dirname, "..", "src", "panel", "config"));

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
    seleniumUrl: "",
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
