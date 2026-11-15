// 面板 smoke：panel.json 的修复与迁移、数据目录锁、空闲连接与端口占用

const assert = require("assert");
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");

const { startPanel } = require(path.resolve(__dirname, "..", "..", "src", "panel", "server"));
const { hashPassword } = require(path.resolve(__dirname, "..", "..", "src", "panel", "auth"));
const { tempDir, panelOptions } = require("./helpers");

module.exports = async function startupScenarios({ scenario, start, login, startAuthed }) {
  await scenario("只有 auth 的旧 panel.json 启动时自动补齐结构并保留密码", async () => {
    const dataDir = tempDir();
    const file = path.join(dataDir, "panel.json");
    fs.writeFileSync(file, JSON.stringify({ version: 1, auth: { passwordHash: await hashPassword("old-password") } }), { mode: 0o600 });
    const panel = await start({ dataDir, seleniumUrl: "http://selenium:4444" });
    assert.strictEqual(panel.generatedPassword, "");
    assert.strictEqual((await login(panel, "old-password")).status, 204);
    const upgraded = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.deepStrictEqual(Object.keys(upgraded), ["version", "auth", "settings", "defaults", "accounts", "migrations"]);
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
    assert.deepStrictEqual(migrated.migrations, ["legacy-selenium-url"]);
    await panel.close();

    // 迁移只做一次：之后在面板中主动填写的同一地址重启后保留
    const again = await startAuthed({ dataDir });
    assert.strictEqual((await again.call("PATCH", "api/settings", { defaults: { seleniumUrl: "http://selenium:4444" } })).status, 200);
    await again.close();
    await (await start({ dataDir })).close();
    assert.strictEqual(JSON.parse(fs.readFileSync(file, "utf8")).defaults.seleniumUrl, "http://selenium:4444", "迁移过一次后不再清空");
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

  await scenario("panel.json 中手工写入的设置取值无效时恢复默认值：时区无效不会让账号接口出错，并发数为 0 不会让运行一直排队", async () => {
    const dataDir = tempDir();
    const file = path.join(dataDir, "panel.json");
    fs.writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        auth: { passwordHash: "" },
        settings: { timezone: "Mars/Olympus", maxConcurrentRuns: 0, logRetentionDays: "abc", screenshotRetentionRuns: 5 },
      }),
      { mode: 0o600 }
    );
    const panel = await startAuthed({ dataDir });
    const stored = JSON.parse(fs.readFileSync(file, "utf8")).settings;
    assert.strictEqual(stored.timezone, "Asia/Shanghai");
    assert.strictEqual(stored.maxConcurrentRuns, 1);
    assert.strictEqual(stored.logRetentionDays, 30);
    assert.strictEqual(stored.screenshotRetentionRuns, 5, "有效的设置保持不变");
    await panel.call("POST", "api/accounts", { id: "login-tz" });
    assert.strictEqual((await panel.call("GET", "api/accounts")).status, 200);
    assert.strictEqual((await panel.call("GET", "api/accounts/login-tz")).status, 200);
    const { run } = (await panel.call("POST", "api/accounts/login-tz/runs", { mode: "login" })).json;
    assert.notStrictEqual(run.status, "queued", "并发数恢复为 1 后应立即启动");
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

  await scenario("空闲连接保持 95 秒，长于常见反向代理的保持时间", async () => {
    const panel = await start();
    assert.strictEqual(panel.server.keepAliveTimeout, 95000);
    assert.ok(panel.server.headersTimeout > panel.server.keepAliveTimeout);
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
};
