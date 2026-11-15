const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { SESSION_TTL_MS, createAuth } = require("../../src/panel/auth");

// 静默运行异步函数
async function quietly(fn) {
  const saved = { info: console.info, warn: console.warn };
  console.info = () => {};
  console.warn = () => {};
  try {
    return await fn();
  } finally {
    Object.assign(console, saved);
  }
}

describe("会话持久化", () => {
  let dir;
  let file;
  let t;
  let pending;
  let scheduled;
  const timers = {
    setTimeout: (fn) => {
      scheduled += 1;
      pending.push(fn);
      return { unref() {} };
    },
    clearTimeout: () => {
      pending = [];
    },
  };
  const runTimers = () => {
    const list = pending;
    pending = [];
    list.forEach((fn) => fn());
  };
  const store = { get: () => ({ auth: { passwordHash: "" } }) };
  const makeAuth = async () => {
    const auth = createAuth({ store, envPassword: "correct-horse", now: () => t, sessionFile: file, timers });
    await auth.init();
    return auth;
  };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "auth-sessions-"));
    file = path.join(dir, "sessions.json");
    t = Date.parse("2026-11-15T00:00:00Z");
    pending = [];
    scheduled = 0;
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("1 秒内的多次登录合并为一次写入", async () => {
    const auth = await makeAuth();
    await quietly(async () => {
      await auth.login("1.1.1.1", "correct-horse");
      await auth.login("1.1.1.1", "correct-horse");
      await auth.login("1.1.1.1", "correct-horse");
    });
    assert.equal(scheduled, 1, "只安排一次写入");
    assert.equal(fs.existsSync(file), false, "到时间之前不写");
    runTimers();
    assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).sessions.length, 3);
  });

  it("续期只在过期时间推后超过 1 小时时写入", async () => {
    const auth = await makeAuth();
    const { token } = await quietly(() => auth.login("1.1.1.1", "correct-horse"));
    runTimers();
    scheduled = 0;
    for (let minute = 1; minute <= 59; minute += 1) {
      t += 60 * 1000;
      assert.ok(auth.touchSession(token));
    }
    assert.equal(scheduled, 0, "一小时内的请求不写磁盘");
    t += 2 * 60 * 1000;
    auth.touchSession(token);
    assert.equal(scheduled, 1);
    runTimers();
    const [saved] = JSON.parse(fs.readFileSync(file, "utf8")).sessions;
    assert.equal(saved.expiresAt, t + SESSION_TTL_MS);
  });

  it("停止时写入还没保存的变化；重启后恢复，需要重新验证", async () => {
    const auth = await makeAuth();
    const { token } = await quietly(() => auth.login("1.1.1.1", "correct-horse"));
    assert.ok(auth.isRecentlyVerified(token));
    auth.close();
    const next = await makeAuth();
    assert.deepEqual(await quietly(() => next.restoreSessions()), { restored: 1, dropped: 0 });
    assert.ok(next.touchSession(token));
    assert.equal(next.isRecentlyVerified(token), false);
    assert.equal(next.sessionInfo(token).verifiedUntil, null);
  });

  it("退出登录后立即写入（不等合并），同一轮结束多个会话只写一次", async () => {
    const auth = await makeAuth();
    const tokens = await quietly(async () => [
      (await auth.login("1.1.1.1", "correct-horse")).token,
      (await auth.login("1.1.1.1", "correct-horse")).token,
      (await auth.login("1.1.1.1", "correct-horse")).token,
    ]);
    runTimers();
    auth.destroySession(tokens[0]);
    await Promise.resolve();
    assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).sessions.length, 2, "退出后立即写入");
    const before = fs.statSync(file).mtimeMs;
    assert.equal(auth.endOtherSessions(tokens[1]), 1);
    await Promise.resolve();
    assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).sessions.length, 1);
    assert.ok(fs.statSync(file).mtimeMs >= before);
  });

  it("文件写不进去时改为只在内存中保存，不影响登录", async () => {
    file = path.join(dir, "missing-dir", "sessions.json");
    const auth = await makeAuth();
    const { token } = await quietly(async () => {
      const result = await auth.login("1.1.1.1", "correct-horse");
      runTimers();
      return result;
    });
    assert.ok(auth.touchSession(token));
    scheduled = 0;
    await quietly(() => auth.login("1.1.1.1", "correct-horse"));
    assert.equal(scheduled, 0, "写入失败后不再尝试");
  });
});
