// 面板 smoke：会话跨重启保留（sessions.json）、不该恢复的会话、退出其他设备

const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const { hashPassword } = require(path.resolve(__dirname, "..", "..", "src", "panel", "auth"));
const { PASSKEY_URL, sessionCookie } = require("./helpers");

const sessionsFile = (panel) => path.join(panel.options.dataDir, "sessions.json");
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const editJson = (file, edit) => {
  const data = readJson(file);
  edit(data);
  fs.writeFileSync(file, JSON.stringify(data));
};

module.exports = async function sessionScenarios({ scenario, start, login, startAuthed, addPasskey, passkeyLogin, callAs }) {
  // 用同一个数据目录重新启动面板（先停止上一个）
  const restart = async (panel, overrides = {}) => {
    await panel.close();
    return start({ dataDir: panel.options.dataDir, password: panel.options.password, publicUrl: panel.options.publicUrl, ...overrides });
  };

  await scenario("会话跨重启保留：原 cookie 仍然有效，敏感操作需要重新验证；sessions.json 为 0600，只有令牌的哈希", async () => {
    const first = await startAuthed();
    assert.strictEqual((await first.call("POST", "api/auth/logout-others")).status, 200, "刚登录时可以直接退出其他设备");
    await first.close();
    const file = sessionsFile(first);
    assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
    const token = decodeURIComponent(first.cookie.split("=").slice(1).join("="));
    const text = fs.readFileSync(file, "utf8");
    assert.ok(!text.includes(token), "文件中不应出现会话令牌");
    const saved = JSON.parse(text);
    assert.strictEqual(saved.sessions.length, 1);
    assert.strictEqual(saved.sessions[0].key, crypto.createHash("sha256").update(token).digest("hex"));
    assert.deepStrictEqual(Object.keys(saved.sessions[0]).sort(), ["cookieSetAt", "createdAt", "credentialId", "expiresAt", "key", "method"]);

    const second = await start({ dataDir: first.options.dataDir, password: "correct-horse" });
    const info = await callAs(second, first.cookie, "GET", "api/auth/session");
    assert.strictEqual(info.status, 200, "重启后原 cookie 仍然有效");
    assert.strictEqual(info.json.method, "password");
    assert.strictEqual(info.json.verifiedUntil, null, "恢复的会话需要重新验证");
    const blocked = await callAs(second, first.cookie, "POST", "api/auth/logout-others");
    assert.strictEqual(blocked.status, 403);
    assert.strictEqual(blocked.json.error, "reauth_required");
    assert.strictEqual((await callAs(second, first.cookie, "POST", "api/auth/reauth", { password: "correct-horse" })).status, 204);
    assert.strictEqual((await callAs(second, first.cookie, "POST", "api/auth/logout-others")).status, 200, "重新验证后可以进行敏感操作");
  });

  await scenario("不恢复的会话：已过期的、密码在停机期间变了的、所用 passkey 已删除的；文件损坏时照常启动", async () => {
    // 已过期
    const expired = await startAuthed();
    await expired.close();
    editJson(sessionsFile(expired), (data) => {
      data.sessions[0].expiresAt = Date.now() - 1000;
    });
    const afterExpired = await start({ dataDir: expired.options.dataDir, password: "correct-horse" });
    assert.strictEqual((await callAs(afterExpired, expired.cookie, "GET", "api/auth/session")).status, 401, "已过期的会话不恢复");
    assert.strictEqual(readJson(sessionsFile(expired)).sessions.length, 0, "丢弃后立即改写文件");

    // 改了 PANEL_PASSWORD
    const envPanel = await startAuthed();
    const sameEnv = await restart(envPanel);
    assert.strictEqual((await callAs(sameEnv, envPanel.cookie, "GET", "api/auth/session")).status, 200, "密码没变时恢复");
    const changedEnv = await restart(sameEnv, { password: "battery-staple" });
    assert.strictEqual((await callAs(changedEnv, envPanel.cookie, "GET", "api/auth/session")).status, 401, "PANEL_PASSWORD 改了后不恢复");

    // 停机期间 panel.json 中的密码被换掉（例如从备份恢复）
    const stored = await start();
    const storedCookie = sessionCookie(await login(stored, stored.generatedPassword));
    await stored.close();
    const anotherHash = await hashPassword("another-password");
    editJson(path.join(stored.options.dataDir, "panel.json"), (data) => {
      data.auth.passwordHash = anotherHash;
    });
    const afterRestore = await start({ dataDir: stored.options.dataDir });
    assert.strictEqual((await callAs(afterRestore, storedCookie, "GET", "api/auth/session")).status, 401, "panel.json 中的密码换了后不恢复");

    // 所用 passkey 在停机期间被删除；用密码登录的会话不受影响
    const withPasskey = await startAuthed({ publicUrl: PASSKEY_URL });
    const authenticator = await addPasskey(withPasskey);
    const passkeyCookie = sessionCookie(await passkeyLogin(withPasskey, authenticator));
    const kept = await restart(withPasskey);
    assert.strictEqual((await callAs(kept, passkeyCookie, "GET", "api/auth/session")).json.method, "passkey", "passkey 还在时恢复");
    await kept.close();
    editJson(path.join(withPasskey.options.dataDir, "panel.json"), (data) => {
      data.auth.passkeys = [];
    });
    const removed = await start({ dataDir: withPasskey.options.dataDir, password: "correct-horse", publicUrl: PASSKEY_URL });
    assert.strictEqual((await callAs(removed, passkeyCookie, "GET", "api/auth/session")).status, 401, "passkey 已删除时不恢复");
    assert.strictEqual((await callAs(removed, withPasskey.cookie, "GET", "api/auth/session")).status, 200, "用密码登录的会话不受影响");

    // 文件损坏
    const broken = await startAuthed();
    await broken.close();
    fs.writeFileSync(sessionsFile(broken), "{oops");
    const recovered = await start({ dataDir: broken.options.dataDir, password: "correct-horse" });
    assert.strictEqual((await callAs(recovered, broken.cookie, "GET", "api/auth/session")).status, 401);
    const fresh = sessionCookie(await login(recovered, "correct-horse"));
    assert.ok(fresh, "文件损坏时照常登录");
    await recovered.close();
    assert.strictEqual(readJson(sessionsFile(broken)).sessions.length, 1, "之后重新写入完好的文件");
  });

  await scenario("退出其他设备：需要近期验证；只保留当前会话，其他会话立即失效，重启后也不恢复；会话信息显示其他设备数", async () => {
    const panel = await startAuthed();
    const other = sessionCookie(await login(panel, "correct-horse"));
    assert.strictEqual((await panel.call("GET", "api/auth/session")).json.otherSessions, 1);
    const res = await panel.call("POST", "api/auth/logout-others");
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.json, { ended: 1 });
    assert.strictEqual((await callAs(panel, other, "GET", "api/auth/session")).status, 401, "其他会话立即失效");
    assert.strictEqual((await panel.call("GET", "api/auth/session")).json.otherSessions, 0);
    assert.strictEqual((await callAs(panel, panel.cookie, "POST", "api/auth/logout-others", {})).status, 200);
    const restarted = await restart(panel);
    assert.strictEqual((await callAs(restarted, other, "GET", "api/auth/session")).status, 401, "重启后也不恢复");
    assert.strictEqual((await callAs(restarted, panel.cookie, "GET", "api/auth/session")).status, 200);
    const noCsrf = await restarted.request("api/auth/logout-others", { method: "POST", cookie: panel.cookie });
    assert.strictEqual(noCsrf.status, 403, "缺少 X-WA-Request 时拒绝");
  });
};
