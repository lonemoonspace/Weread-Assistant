// 面板 smoke：配置备份的导出与导入

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const { until } = require("./helpers");

const readPanel = (panel) => JSON.parse(fs.readFileSync(path.join(panel.options.dataDir, "panel.json"), "utf8"));
const cookiesFile = (panel, id) => path.join(panel.options.dataDir, "accounts", id, "cookies.json");
const COOKIES = [{ name: "wr_vid", value: "cookie-value-123", domain: ".weread.qq.com", path: "/" }];
const SECRETS = ["bark-secret-123", "sel-pass-123", "topic_secret_123", "cookie-value-123"];

module.exports = async function backupScenarios({ scenario, startAuthed }) {
  let fullBackup = null;

  await scenario("导出：需要近期验证；不含密钥时文件中没有任何密钥值；含密钥或登录状态时需要备份密码，加密后读不出来", async () => {
    const stale = await startAuthed({ limits: { reauthWindowMs: 0 } });
    const denied = await stale.call("POST", "api/backup/export", {});
    assert.strictEqual(denied.status, 403);
    assert.strictEqual(denied.json.error, "reauth_required");
    assert.strictEqual((await stale.call("POST", "api/backup/import", { mode: "preview", backup: {} })).status, 403);

    const panel = await startAuthed();
    await panel.call("PATCH", "api/settings", {
      settings: { timezone: "Asia/Tokyo" },
      defaults: { duration: 45, barkKey: "bark-secret-123", seleniumUrl: "http://robot:sel-pass-123@selenium:4444" },
    });
    await panel.call("POST", "api/accounts", { id: "me", name: "小明" });
    await panel.call("PATCH", "api/accounts/me", {
      overrides: { ntfyTopic: "topic_secret_123", speed: "fast", telegramChatId: "-100123" },
      challenge: { type: "month", startDate: "2026-11-01" },
    });
    await panel.call("PUT", "api/accounts/me/schedules", { schedules: [{ type: "daily", times: ["06:00", "21:30"], jitterMinutes: 5 }] });
    await panel.call("PUT", "api/accounts/me/goal", { goal: { minutes: 40, checkAt: "22:00" } });
    await panel.call("PUT", "api/accounts/me/split", { split: { minutes: 50, from: "08:00", to: "22:00", minSegment: 10, maxSegment: 30 } });
    fs.writeFileSync(cookiesFile(panel, "me"), JSON.stringify(COOKIES), { mode: 0o600 });

    const plain = await panel.call("POST", "api/backup/export", {});
    assert.strictEqual(plain.status, 200);
    assert.match(plain.headers.get("content-disposition"), /^attachment; filename="weread-assistant-backup-\d{8}\.json"$/);
    assert.strictEqual(plain.headers.get("cache-control"), "no-store");
    for (const secret of SECRETS) {
      assert.ok(!plain.text.includes(secret), `不含密钥的备份中不应出现 ${secret}`);
    }
    assert.strictEqual(plain.json.format, "weread-assistant-backup");
    assert.strictEqual(plain.json.formatVersion, 1);
    assert.strictEqual(plain.json.sealed, null);
    assert.deepStrictEqual(
      plain.json.omittedSecrets.map((item) => `${item.scope}.${item.key}`).sort(),
      ["defaults.barkKey", "defaults.seleniumUrl", "me.ntfyTopic"]
    );
    assert.strictEqual(plain.json.settings.timezone, "Asia/Tokyo");
    assert.deepStrictEqual(plain.json.defaults, { duration: 45 });
    const [me] = plain.json.accounts;
    assert.deepStrictEqual(me.overrides, { speed: "fast", telegramChatId: "-100123" });
    assert.strictEqual(me.schedules[0].jitterMinutes, 5);
    assert.deepStrictEqual(me.goal, { enabled: true, minutes: 40, checkAt: "22:00" });
    assert.deepStrictEqual(me.split, { enabled: true, minutes: 50, from: "08:00", to: "22:00", minSegment: 10, maxSegment: 30 });
    assert.ok(!("auth" in plain.json) && !plain.text.includes("passwordHash"), "不包含面板密码与 passkey");

    const missing = await panel.call("POST", "api/backup/export", { includeSecrets: true });
    assert.strictEqual(missing.status, 400);
    assert.strictEqual(missing.json.error, "backup_passphrase_required");
    assert.strictEqual((await panel.call("POST", "api/backup/export", { includeCookies: true, passphrase: "short" })).status, 400);
    assert.strictEqual((await panel.call("POST", "api/backup/export", { bogus: 1 })).status, 400);

    const sealed = await panel.call("POST", "api/backup/export", { includeSecrets: true, includeCookies: true, passphrase: "backup-pass-1" });
    assert.strictEqual(sealed.status, 200);
    for (const secret of SECRETS) {
      assert.ok(!sealed.text.includes(secret), `加密后的备份中不应出现 ${secret}`);
    }
    assert.strictEqual(sealed.json.sealed.cipher, "aes-256-gcm");
    assert.deepStrictEqual(sealed.json.omittedSecrets, []);
    fullBackup = sealed.json;
  });

  await scenario("导入：预览不写入；在新的数据目录上恢复出相同的账号、调度、通知配置与登录状态；密码错误、文件被改动或版本更新时不写入", async () => {
    const panel = await startAuthed();
    const before = fs.readFileSync(path.join(panel.options.dataDir, "panel.json"), "utf8");
    const preview = (body) => panel.call("POST", "api/backup/import", { mode: "preview", ...body });

    const wrong = await preview({ backup: fullBackup, passphrase: "wrong-pass-1" });
    assert.strictEqual(wrong.status, 400);
    assert.strictEqual(wrong.json.error, "backup_decrypt_failed");
    assert.strictEqual((await preview({ backup: fullBackup })).json.error, "backup_passphrase_required");
    const tampered = JSON.parse(JSON.stringify(fullBackup));
    tampered.sealed.data = `${tampered.sealed.data.slice(0, -4)}AAAA`;
    assert.strictEqual((await preview({ backup: tampered, passphrase: "backup-pass-1" })).json.error, "backup_decrypt_failed");
    assert.strictEqual((await preview({ backup: { ...fullBackup, formatVersion: 99 } })).json.error, "backup_too_new");
    assert.strictEqual((await preview({ backup: { hello: 1 } })).json.error, "backup_invalid");
    const applyWrong = await panel.call("POST", "api/backup/import", { mode: "apply", backup: fullBackup, passphrase: "wrong-pass-1" });
    assert.strictEqual(applyWrong.status, 400);

    const ok = await preview({ backup: fullBackup, passphrase: "backup-pass-1" });
    assert.strictEqual(ok.status, 200);
    assert.deepStrictEqual(ok.json.preview.accounts, [{ id: "me", name: "小明", action: "add", reason: "", cookies: true }]);
    const barkDiff = ok.json.preview.defaults.find((item) => item.key === "barkKey");
    assert.deepStrictEqual(barkDiff, { key: "barkKey", from: null, to: "••••••" }, "预览中不出现密钥值");
    assert.ok(!JSON.stringify(ok.json).includes("bark-secret-123"));
    assert.ok(ok.json.preview.settings.some((item) => item.key === "timezone" && item.to === "Asia/Tokyo"), JSON.stringify(ok.json.preview));
    assert.strictEqual(fs.readFileSync(path.join(panel.options.dataDir, "panel.json"), "utf8"), before, "预览不写入");
    assert.ok(!fs.existsSync(cookiesFile(panel, "me")));

    const applied = await panel.call("POST", "api/backup/import", { mode: "apply", backup: fullBackup, passphrase: "backup-pass-1" });
    assert.strictEqual(applied.status, 200, JSON.stringify(applied.json));
    assert.strictEqual(applied.json.applied, true);
    assert.match(applied.json.copy, /^panel\.json\.pre-import-\d{8}T\d{9}Z$/);
    assert.strictEqual(fs.statSync(path.join(panel.options.dataDir, applied.json.copy)).mode & 0o777, 0o600);
    const data = readPanel(panel);
    assert.strictEqual(data.settings.timezone, "Asia/Tokyo");
    assert.deepStrictEqual(data.defaults, { duration: 45, barkKey: "bark-secret-123", seleniumUrl: "http://robot:sel-pass-123@selenium:4444" });
    const [me] = data.accounts;
    assert.strictEqual(me.name, "小明");
    assert.deepStrictEqual(me.overrides, { speed: "fast", telegramChatId: "-100123", ntfyTopic: "topic_secret_123" });
    assert.deepStrictEqual(me.challenge, { type: "month", startDate: "2026-11-01" });
    assert.deepStrictEqual(me.goal, { enabled: true, minutes: 40, checkAt: "22:00" });
    assert.deepStrictEqual(me.split, { enabled: true, minutes: 50, from: "08:00", to: "22:00", minSegment: 10, maxSegment: 30 });
    assert.deepStrictEqual(me.schedules.map((rule) => rule.times), [["06:00", "21:30"]]);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(cookiesFile(panel, "me"), "utf8")), COOKIES);
    assert.strictEqual(fs.statSync(cookiesFile(panel, "me")).mode & 0o777, 0o600);
    assert.strictEqual((await panel.call("GET", "api/accounts")).json.accounts[0].hasCookies, true);
    assert.ok((await panel.call("GET", "api/accounts")).json.accounts[0].nextRunAt, "导入的调度规则立即生效");
  });

  await scenario("导入：合并与整体替换；同 ID 账号默认不覆盖；备份不含密钥时保留现有密钥；无效条目跳过且不影响其他内容；正在运行的账号不覆盖、不移除；导入前另存最近 3 份", async () => {
    const panel = await startAuthed();
    for (const id of ["a", "b", "slow-1"]) {
      await panel.call("POST", "api/accounts", { id, name: `原来的 ${id}` });
    }
    await panel.call("PATCH", "api/accounts/a", { overrides: { barkKey: "keep-me-123", speed: "slow" } });
    await panel.call("POST", "api/accounts/slow-1/runs", {});
    await until(async () => (await panel.call("GET", "api/runs")).json.runs.some((run) => run.status === "reading"));

    const backup = {
      format: "weread-assistant-backup",
      formatVersion: 1,
      settings: { maxConcurrentRuns: 2 },
      defaults: { duration: 30, bogus: 1, dataDir: "/etc" },
      accounts: [
        { id: "a", name: "新的 a", overrides: { speed: "fast" }, schedules: [] },
        { id: "c", name: "新账号 c", overrides: { duration: 0, speed: "normal" }, schedules: [{ type: "daily", times: ["07:00"] }] },
        { id: "Bad ID", name: "x" },
        { id: "../etc", name: "x" },
        { id: "d", schedules: [{ type: "daily", times: ["25:00"] }] },
        { id: "slow-1", name: "改不了" },
        { id: "c", name: "重复" },
      ],
    };
    const call = (mode, options) => panel.call("POST", "api/backup/import", { mode, backup, options });

    const merge = await call("preview", {});
    assert.strictEqual(merge.status, 200, JSON.stringify(merge.json));
    const actions = Object.fromEntries(merge.json.preview.accounts.map((entry) => [entry.id, entry.action]));
    assert.deepStrictEqual(actions, { a: "skip", c: "add", "slow-1": "skip" });
    const invalidItems = merge.json.preview.invalid.map((item) => item.item);
    for (const item of ["全局默认配置 · bogus", "全局默认配置 · dataDir", "账号 c 的配置 · duration", "账号 Bad ID", "账号 ../etc", "账号 d", "账号 c"]) {
      assert.ok(invalidItems.includes(item), `无效条目中应有 ${item}：${invalidItems.join("，")}`);
    }

    const overwrite = await call("apply", { overwrite: true });
    assert.strictEqual(overwrite.status, 200);
    const busy = overwrite.json.preview.accounts.find((entry) => entry.id === "slow-1");
    assert.deepStrictEqual([busy.action, busy.reason], ["skip", "账号正在运行或排队，没有覆盖"]);
    let data = readPanel(panel);
    const byId = Object.fromEntries(data.accounts.map((account) => [account.id, account]));
    assert.deepStrictEqual(data.accounts.map((account) => account.id), ["a", "b", "slow-1", "c"]);
    assert.strictEqual(byId.a.name, "新的 a");
    assert.deepStrictEqual(byId.a.overrides, { barkKey: "keep-me-123", speed: "fast" }, "备份不含密钥时保留现有密钥");
    assert.deepStrictEqual(byId.c.overrides, { speed: "normal" }, "无效的配置项跳过，其余照常导入");
    assert.strictEqual(byId["slow-1"].name, "原来的 slow-1");
    assert.strictEqual(data.settings.maxConcurrentRuns, 2);
    assert.deepStrictEqual(data.defaults, { duration: 30 });

    const replace = await call("apply", { accounts: "replace", settings: false });
    assert.strictEqual(replace.status, 200);
    assert.deepStrictEqual(replace.json.preview.removed, [{ id: "b", name: "原来的 b" }]);
    assert.deepStrictEqual(replace.json.preview.kept, [], "slow-1 在备份中，按“正在运行，不覆盖”处理");
    assert.strictEqual(replace.json.preview.accounts.find((entry) => entry.id === "slow-1").action, "skip");
    data = readPanel(panel);
    assert.deepStrictEqual(data.accounts.map((account) => account.id).sort(), ["a", "c", "slow-1"]);
    assert.ok(fs.existsSync(path.join(panel.options.dataDir, "accounts", "b")), "移除的账号保留数据目录");

    assert.strictEqual((await call("preview", { accounts: "all" })).status, 400);
    assert.strictEqual((await panel.call("POST", "api/backup/import", { mode: "apply" })).json.error, "backup_invalid");
    await call("apply", {});
    await call("apply", {});
    const copies = fs.readdirSync(panel.options.dataDir).filter((name) => name.startsWith("panel.json.pre-import-"));
    assert.strictEqual(copies.length, 3, `导入了 4 次，只保留最近 3 份：${copies.join(", ")}`);
    await panel.call("POST", "api/accounts/slow-1/stop");
  });

  await scenario("导入的请求体上限为 2MB，只在登录并近期验证后才解析；其他接口仍为 10KB", async () => {
    const panel = await startAuthed();
    const big = { format: "weread-assistant-backup", formatVersion: 1, accounts: [], defaults: {}, padding: "x".repeat(100 * 1024) };
    const res = await panel.call("POST", "api/backup/import", { mode: "preview", backup: big });
    assert.strictEqual(res.status, 200, "100KB 的备份可以导入");
    assert.strictEqual((await panel.call("PATCH", "api/settings", { defaults: { bookUrl: "x".repeat(20 * 1024) } })).status, 413);
    const tooBig = await panel.call("POST", "api/backup/import", { mode: "preview", backup: { ...big, padding: "x".repeat(3 * 1024 * 1024) } });
    assert.strictEqual(tooBig.status, 413);
    const anonymous = await panel.request("api/backup/import", { method: "POST", body: { mode: "preview", backup: big }, headers: { "X-WA-Request": "1" } });
    assert.strictEqual(anonymous.status, 401);
  });
};
