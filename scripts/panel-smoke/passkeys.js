// 面板 smoke：passkey 的添加、登录、校验、二次验证与密码登录开关

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const { createPasskeys } = require(path.resolve(__dirname, "..", "..", "src", "panel", "passkeys"));
const { createStore } = require(path.resolve(__dirname, "..", "..", "src", "panel", "store"));
const { FLAG_UP, createSoftAuthenticator } = require("../fixtures/soft-authenticator");
const { CSRF, PASSKEY_URL, PASSKEY_RP, tempDir, until, openEvents, sessionCookie } = require("./helpers");

module.exports = async function passkeysScenarios({ scenario, start, login, startAuthed, addPasskey, passkeyLogin, callAs }) {
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

  await scenario("不是已添加的 passkey 的登录请求返回 401，但不计入限速：伪造请求锁不住别人的 IP", async () => {
    const panel = await startAuthed({ publicUrl: PASSKEY_URL, limits: { lockoutBaseMs: 60000 } });
    const authenticator = await addPasskey(panel);
    for (let i = 0; i < 10; i += 1) {
      const res = await passkeyLogin(panel, createSoftAuthenticator(PASSKEY_RP));
      assert.strictEqual(res.status, 401);
      assert.deepStrictEqual(res.json, { error: "passkey_failed" });
    }
    for (const response of [null, "x", { id: 1 }]) {
      const res = await panel.request("api/auth/passkey/login", { method: "POST", body: { response }, headers: CSRF });
      assert.strictEqual(res.status, 401);
    }
    assert.strictEqual((await passkeyLogin(panel, authenticator)).status, 204);
    // 被锁定的 IP 同样返回 429
    for (let i = 0; i < 5; i += 1) {
      await passkeyLogin(panel, authenticator, { badSignature: true });
    }
    assert.strictEqual((await panel.request("api/auth/passkey/login", { method: "POST", body: { response: null }, headers: CSRF })).status, 429);
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
    // 改名同样需要二次验证
    const rename = await panel.call("PATCH", `api/auth/passkeys/${authenticator.id}`, { name: "新名字" });
    assert.strictEqual(rename.status, 403);
    assert.strictEqual(rename.json.error, "reauth_required");

    // 密码：错误时 400（不是 401，页面不会当作会话失效），正确后可以添加
    const wrong = await panel.call("POST", "api/auth/reauth", { password: "wrong" });
    assert.strictEqual(wrong.status, 400);
    assert.strictEqual(wrong.json.error, "wrong_password");
    assert.strictEqual((await panel.call("POST", "api/auth/reauth", { password: "correct-horse" })).status, 204);
    assert.ok(Date.parse((await panel.call("GET", "api/auth/session")).json.verifiedUntil) > Date.now());
    assert.strictEqual((await panel.call("POST", "api/auth/passkeys/options")).status, 200);
    assert.strictEqual((await panel.call("PATCH", `api/auth/passkeys/${authenticator.id}`, { name: "新名字" })).status, 200);

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

  await scenario("passkey 的 challenge：5 分钟后过期；登录用的不在服务端保存，申请再多也挤不掉别人的，只有校验成功才记为用过；二次验证与添加用的不受影响", async () => {
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
    assert.strictEqual(await passkeys.verifyLogin(authenticator.assert(fresh)), null, "用过的 challenge");

    // 未登录的请求申请再多，管理员手上的登录 challenge 与二次验证、添加用的都不受影响
    const mine = await passkeys.loginOptions();
    const reauth = await passkeys.reauthOptions(token);
    const registration = await passkeys.registrationOptions(token);
    for (let i = 0; i < 1000; i += 1) {
      await passkeys.loginOptions();
    }
    assert.ok(await passkeys.verifyLogin(authenticator.assert(mine)), "管理员的登录 challenge 保留");
    assert.ok(await passkeys.verifyReauth(authenticator.assert(reauth), token), "二次验证用的 challenge 保留");
    const added = await passkeys.register(createSoftAuthenticator(PASSKEY_RP).register(registration), "后加的", token);
    assert.strictEqual(added.name, "后加的", "添加用的 challenge 保留");

    // 改动过的、其他面板实例签发的登录 challenge 都不接受
    const other = createPasskeys({ store, relyingParty: { id: "example.com", origin: "https://example.com" }, now: () => t });
    assert.strictEqual(await passkeys.verifyLogin(authenticator.assert(await other.loginOptions())), null, "其他实例的 challenge");
    const tampered = await passkeys.loginOptions();
    const raw = Buffer.from(tampered.challenge, "base64url");
    raw[0] ^= 1;
    assert.strictEqual(
      await passkeys.verifyLogin(authenticator.assert({ ...tampered, challenge: raw.toString("base64url") })),
      null,
      "改过过期时间的 challenge"
    );

    // 同一个 challenge 换种写法（追加空白、填充）不能再用一次
    const padded = await passkeys.loginOptions();
    assert.strictEqual(
      await passkeys.verifyLogin(authenticator.assert({ ...padded, challenge: `${padded.challenge}  ` })),
      null,
      "非规范写法"
    );
    assert.ok(await passkeys.verifyLogin(authenticator.assert(padded)), "规范写法仍可使用");

    // 只有校验成功才记为用过：错误签名的请求再多，也挤不掉用过的记录，捕获的合法结果不能重放，之后的正常登录不受影响
    const captured = authenticator.assert(await passkeys.loginOptions());
    assert.ok(await passkeys.verifyLogin(captured));
    for (let i = 0; i < 10050; i += 1) {
      await passkeys.verifyLogin(authenticator.assert(await passkeys.loginOptions(), { badSignature: true }));
    }
    assert.strictEqual(await passkeys.verifyLogin(captured), null, "错误签名刷满后仍不能重放");
    assert.ok(await passkeys.verifyLogin(authenticator.assert(await passkeys.loginOptions())), "之后仍可登录");

    // 签名不对的请求不会用掉别人的 challenge；同一个结果并发提交时只有一个成功
    const shared = await passkeys.loginOptions();
    assert.strictEqual(await passkeys.verifyLogin(authenticator.assert(shared, { badSignature: true })), null);
    const valid = authenticator.assert(shared);
    const concurrent = await Promise.all([passkeys.verifyLogin(valid), passkeys.verifyLogin(valid), passkeys.verifyLogin(valid)]);
    assert.strictEqual(concurrent.filter(Boolean).length, 1, "并发重放只成功一次");
    assert.strictEqual(await passkeys.verifyLogin(valid), null, "用过后不能再用");
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
};
