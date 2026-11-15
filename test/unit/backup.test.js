const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { FORMAT_VERSION, buildBackup, openBackup, planImport } = require("../../src/panel/backup");

const data = () => ({
  settings: { timezone: "Asia/Shanghai", maxConcurrentRuns: 1, logRetentionDays: 30, screenshotRetentionRuns: 3, vncUrl: "" },
  defaults: { duration: 30, barkKey: "bark-secret-123" },
  accounts: [
    {
      id: "me",
      name: "小明",
      enabled: true,
      createdAt: "2026-11-01T00:00:00.000Z",
      overrides: { ntfyTopic: "topic_secret_123", speed: "fast" },
      schedules: [{ id: "abc", type: "daily", times: ["06:00"], enabled: true }],
      challenge: null,
      goal: null,
    },
  ],
});

describe("配置备份", () => {
  let dir;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "backup-test-"));
    fs.mkdirSync(path.join(dir, "accounts", "me"), { recursive: true });
    fs.writeFileSync(path.join(dir, "accounts", "me", "cookies.json"), JSON.stringify([{ name: "wr_vid", value: "v-123" }]));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("加密与解密往返：密钥与 cookies 只在加密部分中", async () => {
    const backup = await buildBackup(data(), { dataDir: dir, includeSecrets: true, includeCookies: true, passphrase: "pass-phrase-1" });
    const text = JSON.stringify(backup);
    for (const secret of ["bark-secret-123", "topic_secret_123", "v-123"]) {
      assert.ok(!text.includes(secret), secret);
    }
    const opened = await openBackup(JSON.parse(text), "pass-phrase-1");
    assert.equal(opened.defaults.barkKey, "bark-secret-123");
    assert.equal(opened.accounts[0].overrides.ntfyTopic, "topic_secret_123");
    assert.deepEqual(opened.accounts[0].cookies, [{ name: "wr_vid", value: "v-123" }]);
  });

  it("密码错误、密文或认证标签被改动时解密失败", async () => {
    const backup = await buildBackup(data(), { dataDir: dir, includeSecrets: true, passphrase: "pass-phrase-1" });
    await assert.rejects(openBackup(backup, "pass-phrase-2"), { code: "backup_decrypt_failed" });
    const flipped = JSON.parse(JSON.stringify(backup));
    const bytes = Buffer.from(flipped.sealed.data, "base64");
    bytes[0] ^= 1;
    flipped.sealed.data = bytes.toString("base64");
    await assert.rejects(openBackup(flipped, "pass-phrase-1"), { code: "backup_decrypt_failed" });
    const tag = JSON.parse(JSON.stringify(backup));
    tag.sealed.tag = Buffer.alloc(16).toString("base64");
    await assert.rejects(openBackup(tag, "pass-phrase-1"), { code: "backup_decrypt_failed" });
    await assert.rejects(openBackup({ ...backup, sealed: { ...backup.sealed, N: 1 << 20 } }, "pass-phrase-1"), /加密参数不对/);
  });

  it("包含密钥或登录状态时必须设置至少 8 位的备份密码", async () => {
    await assert.rejects(buildBackup(data(), { dataDir: dir, includeSecrets: true }), { code: "backup_passphrase_required" });
    await assert.rejects(buildBackup(data(), { dataDir: dir, includeCookies: true, passphrase: "1234567" }), { code: "backup_passphrase_required" });
    const plain = await buildBackup(data(), { dataDir: dir });
    assert.equal(plain.sealed, null);
    assert.deepEqual(plain.defaults, { duration: 30 });
  });

  it("版本判断：比当前新的拒绝；不是备份文件时拒绝", async () => {
    const plain = await buildBackup(data(), { dataDir: dir });
    await assert.rejects(openBackup({ ...plain, formatVersion: FORMAT_VERSION + 1 }), { code: "backup_too_new" });
    await assert.rejects(openBackup({ ...plain, formatVersion: 0 }), { code: "backup_invalid" });
    await assert.rejects(openBackup({ ...plain, format: "other" }), { code: "backup_invalid" });
    await assert.rejects(openBackup({ ...plain, accounts: {} }), { code: "backup_invalid" });
  });

  it("导入预览不修改传入的数据；账号 ID 不能指向数据目录之外", async () => {
    const current = data();
    const snapshot = JSON.stringify(current);
    const backup = await openBackup({
      format: "weread-assistant-backup",
      formatVersion: 1,
      defaults: {},
      accounts: [{ id: "../../etc", name: "x" }, { id: "new-1", name: "新" }, { id: "__proto__" }],
    });
    const { preview, next } = planImport(current, backup, { accounts: "replace" });
    assert.equal(JSON.stringify(current), snapshot);
    assert.deepEqual(next.accounts.map((account) => account.id), ["new-1"]);
    assert.deepEqual(preview.removed.map((item) => item.id), ["me"]);
    assert.equal(preview.invalid.filter((item) => item.item.startsWith("账号")).length, 2);
  });
});
