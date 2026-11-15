// 面板 smoke：密码登录、会话、登录限速与修改密码

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const { SESSION_MAX_AGE_MS, SESSION_TTL_MS, createAuth, hashPassword, verifyPassword } = require(path.resolve(__dirname, "..", "..", "src", "panel", "auth"));
const { createStore } = require(path.resolve(__dirname, "..", "..", "src", "panel", "store"));
const { CSRF, PASSKEY_URL, tempDir, sessionCookie } = require("./helpers");

module.exports = async function authScenarios({ scenario, start, login, startAuthed, addPasskey }) {
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

  await scenario("所有 IP 累计失败达到上限后暂停未登录过的 IP 登录；登录成功过的 IP 不受影响，管理员不会被挡在面板外", async () => {
    const panel = await start({
      password: "correct-horse",
      trustProxy: 1,
      limits: { globalMaxFailures: 3, globalWindowMs: 500 },
    });
    const admin = { "X-Forwarded-For": "192.0.2.10" };
    assert.strictEqual((await login(panel, "correct-horse", admin)).status, 204);
    for (let i = 1; i <= 3; i += 1) {
      await login(panel, "wrong", { "X-Forwarded-For": `198.51.100.${i}` });
    }
    assert.strictEqual((await login(panel, "correct-horse", { "X-Forwarded-For": "198.51.100.99" })).status, 429);
    assert.strictEqual((await login(panel, "wrong", { "X-Forwarded-For": "198.51.100.98" })).status, 429, "暂停期间不校验密码");
    assert.strictEqual((await login(panel, "correct-horse", admin)).status, 204, "登录成功过的 IP 不受全局暂停影响");
    await new Promise((resolve) => setTimeout(resolve, 550));
    assert.strictEqual((await login(panel, "correct-horse", { "X-Forwarded-For": "198.51.100.99" })).status, 204);
  });

  await scenario("全局暂停只挡密码登录：passkey 登录与已登录会话的二次验证照常可用，仍按 IP 限速", async () => {
    const panel = await startAuthed({
      publicUrl: PASSKEY_URL,
      trustProxy: 1,
      limits: { globalMaxFailures: 3, globalWindowMs: 60000, lockoutBaseMs: 60000 },
    });
    const authenticator = await addPasskey(panel);
    for (let i = 1; i <= 3; i += 1) {
      await login(panel, "wrong", { "X-Forwarded-For": `198.51.100.${i}` });
    }
    const fresh = { "X-Forwarded-For": "203.0.113.50" };
    assert.strictEqual((await login(panel, "correct-horse", fresh)).status, 429, "未登录过的 IP 不能用密码登录");
    const options = await panel.request("api/auth/passkey/options", { method: "POST", body: { purpose: "login" }, headers: { ...CSRF, ...fresh } });
    assert.strictEqual(options.status, 200, "暂停期间仍可申请 passkey 登录参数");
    const loggedIn = await panel.request("api/auth/passkey/login", {
      method: "POST",
      body: { response: authenticator.assert(options.json) },
      headers: { ...CSRF, ...fresh },
    });
    assert.strictEqual(loggedIn.status, 204, "暂停期间仍可用 passkey 登录");
    const cookie = sessionCookie(loggedIn);
    // 已登录的会话换到另一个 IP 后仍可二次验证
    const elsewhere = { ...CSRF, "X-Forwarded-For": "203.0.113.51" };
    const reauth = await panel.request("api/auth/reauth", { method: "POST", cookie, body: { password: "correct-horse" }, headers: elsewhere });
    assert.strictEqual(reauth.status, 204);
    // 按 IP 的限速仍然生效
    const attacker = { "X-Forwarded-For": "203.0.113.60" };
    for (let i = 0; i < 5; i += 1) {
      const bad = await panel.request("api/auth/passkey/options", { method: "POST", body: { purpose: "login" }, headers: { ...CSRF, ...attacker } });
      await panel.request("api/auth/passkey/login", {
        method: "POST",
        body: { response: authenticator.assert(bad.json, { badSignature: true }) },
        headers: { ...CSRF, ...attacker },
      });
    }
    assert.strictEqual(
      (await panel.request("api/auth/passkey/options", { method: "POST", body: { purpose: "login" }, headers: { ...CSRF, ...attacker } })).status,
      429
    );
  });

  await scenario("passkey 与二次验证的失败不计入全局上限，不能用来触发全局暂停", async () => {
    const panel = await startAuthed({ publicUrl: PASSKEY_URL, trustProxy: 1, limits: { globalMaxFailures: 3, globalWindowMs: 60000 } });
    const authenticator = await addPasskey(panel);
    for (let i = 1; i <= 4; i += 1) {
      const headers = { ...CSRF, "X-Forwarded-For": `198.51.100.${i}` };
      const options = await panel.request("api/auth/passkey/options", { method: "POST", body: { purpose: "login" }, headers });
      const res = await panel.request("api/auth/passkey/login", {
        method: "POST",
        body: { response: authenticator.assert(options.json, { badSignature: true }) },
        headers,
      });
      assert.strictEqual(res.status, 401);
    }
    for (let i = 0; i < 3; i += 1) {
      assert.strictEqual((await panel.call("POST", "api/auth/reauth", { password: "wrong" })).status, 400);
    }
    assert.strictEqual((await login(panel, "correct-horse", { "X-Forwarded-For": "203.0.113.70" })).status, 204, "新 IP 仍可用密码登录");
  });

  await scenario("密码哈希被改坏时：任何密码都不能通过、不会抛出；面板拒绝启动并说明恢复办法", async () => {
    const key = Buffer.alloc(64, 1).toString("base64");
    const salt = Buffer.alloc(16, 2).toString("base64");
    for (const bad of [
      "scrypt$16384$8$1$$",
      `scrypt$16384$8$1$${salt}$`,
      `scrypt$16384$8$1$${salt}$AAAA`,
      `scrypt$notanumber$8$1$${salt}$${key}`,
      `scrypt$1000$8$1$${salt}$${key}`,
      `scrypt$1048576$64$1$${salt}$${key}`,
      // N=1、内存占用刚好超过上限：scrypt 会拒绝这些参数，不能让面板启动后任何密码都校验不过
      `scrypt$1$8$1$${salt}$${key}`,
      `scrypt$65536$8$1$${salt}$${key}`,
      `scrypt$16384$8$1$!!$${key}`,
    ]) {
      assert.strictEqual(await verifyPassword("anything", bad), false, bad);
      assert.strictEqual(await verifyPassword("", bad), false, bad);
    }
    const good = await hashPassword("correct-horse");
    assert.strictEqual(await verifyPassword("correct-horse", good), true);

    const dataDir = tempDir();
    fs.writeFileSync(path.join(dataDir, "panel.json"), JSON.stringify({ version: 1, auth: { passwordHash: "scrypt$16384$8$1$$" } }), { mode: 0o600 });
    await assert.rejects(start({ dataDir }), /密码哈希（auth\.passwordHash）无效/);
    fs.writeFileSync(path.join(dataDir, "panel.json"), JSON.stringify({ version: 1, auth: { passwordHash: `scrypt$65536$8$1$${salt}$${key}` } }), { mode: 0o600 });
    await assert.rejects(start({ dataDir }), /密码哈希（auth\.passwordHash）无效/);
    // 设置 PANEL_PASSWORD 时以它为准，可以照常启动
    const panel = await start({ dataDir, password: "correct-horse" });
    assert.strictEqual((await login(panel, "wrong")).status, 401);
    assert.strictEqual((await login(panel, "correct-horse")).status, 204);
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

  await scenario("按 IP 的失败计数：上次失败 15 分钟后从头计数；锁定期间与刚解锁时仍逐次翻倍", async () => {
    let t = Date.now();
    const auth = createAuth({ store: { get: () => ({ auth: { passwordHash: "" } }) }, envPassword: "correct-horse", now: () => t });
    await auth.init();
    for (let i = 0; i < 4; i += 1) {
      assert.strictEqual((await auth.login("192.0.2.1", "wrong")).retryAfterMs, 0);
    }
    t += 15 * 60 * 1000;
    assert.strictEqual((await auth.login("192.0.2.1", "wrong")).retryAfterMs, 0, "15 分钟没有再失败，从头计数");
    for (let i = 0; i < 3; i += 1) {
      await auth.login("192.0.2.1", "wrong");
    }
    assert.strictEqual((await auth.login("192.0.2.1", "wrong")).retryAfterMs, 30 * 1000, "第 5 次失败锁定 30 秒");
    t += 31 * 1000;
    assert.strictEqual((await auth.login("192.0.2.1", "wrong")).retryAfterMs, 60 * 1000, "刚解锁就再失败，锁定翻倍");
    t += 61 * 1000 + 15 * 60 * 1000;
    assert.strictEqual((await auth.login("192.0.2.1", "wrong")).retryAfterMs, 0, "解锁后 15 分钟没有再失败，从头计数");
  });

  await scenario("同一 IP 并发登录：校验中的请求预先占用失败名额，一次突发最多校验 5 次", async () => {
    const auth = createAuth({ store: { get: () => ({ auth: { passwordHash: "" } }) }, envPassword: "correct-horse" });
    await auth.init();
    const results = await Promise.all(Array.from({ length: 50 }, () => auth.login("192.0.2.1", "wrong")));
    assert.strictEqual(results.filter((result) => !result.locked).length, 5, "进入校验的请求数");
    assert.ok(results.every((result) => !result.ok));
    assert.ok((await auth.login("192.0.2.1", "correct-horse")).locked, "5 次失败后锁定");
    // 正确密码与其他请求并发时照常登录，并清除失败计数
    const other = createAuth({ store: { get: () => ({ auth: { passwordHash: "" } }) }, envPassword: "correct-horse" });
    await other.init();
    const mixed = await Promise.all([other.login("192.0.2.2", "wrong"), other.login("192.0.2.2", "correct-horse")]);
    assert.ok(mixed[1].ok);
  });

  await scenario("校验旧密码期间密码被修改：这次登录失败，修改密码后不会留下用旧密码建立的会话", async () => {
    const store = createStore(tempDir());
    let pendingLogin = null;
    let armed = false;
    const auth = createAuth({
      store: {
        get: () => store.get(),
        // 修改密码写入新哈希的同时，有一个用旧密码的登录正在校验
        update: (fn) => {
          if (armed && !pendingLogin) {
            pendingLogin = auth.login("192.0.2.9", original);
          }
          return store.update(fn);
        },
      },
    });
    const original = await auth.init();
    armed = true;
    const changed = await auth.changePassword("192.0.2.1", original, "new-password-1");
    assert.ok(changed.ok);
    const raced = await pendingLogin;
    assert.ok(!raced.ok, "旧密码的登录不成功");
    assert.ok(auth.isSessionValid(changed.token));
    assert.ok((await auth.login("192.0.2.9", "new-password-1")).ok);

    // passkey 登录同样：校验期间修改了密码时不算成功
    let passkeyLogin = null;
    pendingLogin = null;
    const slowPasskey = () => new Promise((resolve) => setTimeout(() => resolve({ id: "pk" }), 50));
    const originalUpdate = store.update.bind(store);
    const second = createAuth({
      store: {
        get: () => store.get(),
        update: (fn) => {
          passkeyLogin = passkeyLogin || second.loginWithPasskey("192.0.2.8", slowPasskey);
          return originalUpdate(fn);
        },
      },
    });
    await second.init();
    assert.ok((await second.changePassword("192.0.2.1", "new-password-1", "new-password-2")).ok);
    assert.ok(!(await passkeyLogin).ok, "passkey 登录不成功");
  });

  await scenario("会话按访问续期，但从登录起最长 30 天", async () => {
    let t = Date.now();
    const auth = createAuth({ store: { get: () => ({ auth: { passwordHash: "" } }) }, envPassword: "correct-horse", now: () => t });
    await auth.init();
    const { token } = await auth.login("127.0.0.1", "correct-horse");
    while (t + SESSION_TTL_MS / 2 < Date.now() + SESSION_MAX_AGE_MS) {
      t += SESSION_TTL_MS / 2;
      assert.ok(auth.touchSession(token), "有效期内使用时续期");
    }
    t = Date.now() + SESSION_MAX_AGE_MS;
    assert.strictEqual(auth.touchSession(token), null, "超过最长有效期后失效");
  });

  await scenario("修改密码时当前密码错误与登录共用按 IP 的失败计数：连续失败后返回 429", async () => {
    const panel = await start({ limits: { lockoutBaseMs: 60000 } });
    const original = panel.generatedPassword;
    const cookie = sessionCookie(await login(panel, original));
    const change = (current) =>
      panel.request("api/auth/password", { method: "POST", body: { current, next: "new-password-1" }, headers: CSRF, cookie });
    for (let i = 0; i < 5; i += 1) {
      assert.strictEqual((await change("wrong")).json.error, "wrong_password");
    }
    const locked = await change(original);
    assert.strictEqual(locked.status, 429);
    assert.strictEqual(locked.json.error, "too_many_attempts");
    assert.ok(Number(locked.headers.get("retry-after")) >= 1);
    assert.strictEqual((await login(panel, original)).status, 429, "同一 IP 的登录也被锁定");
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
};
