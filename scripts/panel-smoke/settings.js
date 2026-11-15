// 面板 smoke：全局设置与默认配置、配置合并、密钥脱敏、Selenium 状态与测试通知

const assert = require("assert");
const fs = require("fs");
const http = require("http");
const path = require("path");

const { createLocalBrowserChecker } = require(path.resolve(__dirname, "..", "..", "src", "shared", "local-browser"));
const { SECRET_MASK, resolveAccountConfig } = require(path.resolve(__dirname, "..", "..", "src", "panel", "config"));
const { startMockSelenium } = require("../fixtures/mock-selenium");
const { tempDir, nextRun, ended, runFiles } = require("./helpers");

module.exports = async function settingsScenarios({ scenario, startAuthed }) {
  await scenario("Selenium 地址中的密码返回掩码；提交掩码时只在地址其余部分不变时沿用原密码", async () => {
    const panel = await startAuthed();
    const file = path.join(panel.options.dataDir, "panel.json");
    const saved = () => JSON.parse(fs.readFileSync(file, "utf8")).defaults.seleniumUrl;
    const withPassword = "http://robot:p%40ss@grid.lan:4444/wd/hub";
    const masked = "http://robot:••••••@grid.lan:4444/wd/hub";
    const set = await panel.call("PATCH", "api/settings", { defaults: { seleniumUrl: withPassword } });
    assert.strictEqual(set.status, 200);
    assert.strictEqual(set.json.defaults.seleniumUrl, masked);
    assert.strictEqual((await panel.call("GET", "api/settings")).json.defaults.seleniumUrl, masked);
    // 原样提交掩码：密码不变
    assert.strictEqual((await panel.call("PATCH", "api/settings", { defaults: { seleniumUrl: masked } })).status, 200);
    assert.strictEqual(saved(), withPassword);
    // 换了主机、用户名或路径还提交掩码：拒绝，不能把密码发往别的地址
    for (const url of ["http://robot:••••••@evil.example:4444/wd/hub", "http://other:••••••@grid.lan:4444/wd/hub", "http://robot:••••••@grid.lan:4444"]) {
      const res = await panel.call("PATCH", "api/settings", { defaults: { seleniumUrl: url } });
      assert.strictEqual(res.status, 400, url);
    }
    assert.strictEqual(saved(), withPassword);
    // 带首尾空白的地址同样返回掩码，原样提交掩码时沿用原密码
    await panel.call("PATCH", "api/settings", { defaults: { seleniumUrl: ` \t${withPassword} ` } });
    const padded = (await panel.call("GET", "api/settings")).json.defaults.seleniumUrl;
    assert.strictEqual(padded, masked);
    assert.strictEqual((await panel.call("PATCH", "api/settings", { defaults: { seleniumUrl: padded } })).status, 200);
    assert.strictEqual(saved().trim(), withPassword);
    // 重新填写密码可以修改；没有密码的地址原样返回
    await panel.call("PATCH", "api/settings", { defaults: { seleniumUrl: "http://robot:new@grid2.lan:4444" } });
    assert.strictEqual(saved(), "http://robot:new@grid2.lan:4444");
    await panel.call("PATCH", "api/settings", { defaults: { seleniumUrl: "http://grid.lan:4444" } });
    assert.strictEqual((await panel.call("GET", "api/settings")).json.defaults.seleniumUrl, "http://grid.lan:4444");
    // 账号覆盖与实际生效的配置同样返回掩码
    await panel.call("POST", "api/accounts", { id: "sel", name: "sel" });
    const account = await panel.call("PATCH", "api/accounts/sel", { overrides: { seleniumUrl: withPassword } });
    assert.strictEqual(account.status, 200, JSON.stringify(account.json));
    assert.strictEqual(account.json.account.overrides.seleniumUrl, masked);
    assert.strictEqual((await panel.call("GET", "api/accounts/sel")).json.effective.seleniumUrl, masked);
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
      [{ defaults: { webhookUrl: "ftp://hook" } }, /Webhook 地址必须是以 http:\/\/ 或 https:\/\/ 开头的地址/],
      [{ defaults: { webhookFormat: "slack" } }, /Webhook 格式 只能是 json、wecom、feishu、dingtalk/],
      [{ defaults: { webhookHeader: "Authorization Bearer x" } }, /Webhook 附加请求头：格式为“名称: 值”/],
      [{ defaults: { telegramBotToken: "not-a-token" } }, /Telegram 机器人令牌：形如/],
      [{ defaults: { telegramChatId: "me" } }, /Telegram 会话 ID：只能是数字 ID/],
      [{ defaults: { telegramApiBase: "api.telegram.org" } }, /Telegram 接口地址必须是/],
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
    for (const key of ["dataDir", "accountName"]) {
      assert.ok(!(key in effective), `${key} 不应出现在接口中`);
    }
    assert.strictEqual((await panel.call("PATCH", "api/accounts/me", { overrides: { duration: "abc" } })).status, 400);

    await panel.call("PATCH", "api/accounts/me", { overrides: { speed: null } });
    assert.strictEqual((await panel.call("GET", "api/accounts/me")).json.effective.speed, "normal");

    const data = JSON.parse(fs.readFileSync(path.join(panel.options.dataDir, "panel.json"), "utf8"));
    const config = resolveAccountConfig(data, data.accounts[0], panel.options.dataDir);
    assert.strictEqual(config.dataDir, path.join(path.resolve(panel.options.dataDir), "accounts", "me"));
    assert.ok(!("profileName" in config), "profileName 已删除");
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
    for (const key of ["dataDir", "accountName"]) {
      assert.ok(!keys.includes(key), key);
    }
    assert.strictEqual(schema.fields.find((field) => field.key === "barkKey").secret, true);
    assert.deepStrictEqual(
      schema.settingsFields.map((field) => field.key),
      ["timezone", "maxConcurrentRuns", "retryCount", "catchupGraceMinutes", "logRetentionDays", "screenshotRetentionRuns", "vncUrl"]
    );
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
    // 假的 chromedriver 与 Chromium 要能执行：放在 node_modules/.cache 下，不放系统临时目录（可能以 noexec 挂载）
    const binDir = tempDir(path.join(__dirname, "..", "..", "node_modules", ".cache"));
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

      // 检查过的版本随运行配置下发，阅读子进程不必再执行 --version
      await panel.call("POST", "api/accounts", { id: "ok-local", name: "本机运行" });
      const finished = nextRun(panel, ended("ok-local"));
      assert.strictEqual((await panel.call("POST", "api/accounts/ok-local/runs")).status, 202);
      const run = await finished;
      const runLog = await runFiles(panel, "ok-local", run.id).log();
      assert.match(runLog, /面板下发的内置浏览器：Chromium 155\.0\.8059\.84 Alpine Linux/);

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
      assert.match(servers[0].error, /无法读取浏览器版本：.*missing-chrome --version 无法执行（ENOENT）/);
    } finally {
      restore();
    }
  });

  await scenario("内置浏览器：读取版本超时、出错退出时报出原因；读到的版本按文件缓存，文件不变时不再启动浏览器", async () => {
    const binDir = tempDir(path.join(__dirname, "..", "..", "node_modules", ".cache"));
    const script = (name, body) => {
      const file = path.join(binDir, name);
      fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
      return file;
    };
    const counter = path.join(binDir, "count");
    const env = {
      PATH: binDir,
      CHROMEDRIVER_PATH: script("chromedriver", 'echo "ChromeDriver 155.0.8059.84"'),
      CHROME_BIN: script("chromium-browser", `echo x >> "${counter}"\necho "Chromium 155.0.8059.84 Alpine Linux"`),
    };
    const runs = () => fs.readFileSync(counter, "utf8").split("\n").filter(Boolean).length;

    const check = createLocalBrowserChecker(env, { timeoutMs: 500 });
    assert.strictEqual((await check()).message, "Chromium 155.0.8059.84 Alpine Linux");
    assert.strictEqual((await check()).ready, true);
    assert.strictEqual(runs(), 1);

    // 文件改了（例如升级了浏览器）就重新读取
    script("chromium-browser", `echo x >> "${counter}"\necho "Chromium 156.0.1.2 Alpine Linux"`);
    fs.utimesSync(env.CHROME_BIN, new Date(), new Date(Date.now() + 5000));
    const status = await check();
    assert.strictEqual(runs(), 2);
    assert.match(status.error, /主版本不一致（chromedriver 155，Chromium 156）/);

    script("chromium-browser", "exec sleep 3");
    fs.utimesSync(env.CHROME_BIN, new Date(), new Date(Date.now() + 10000));
    let result = await check();
    assert.strictEqual(result.state, "unreachable");
    assert.match(result.error, /chromium-browser --version 0\.5 秒内没有输出版本/);

    script("chromium-browser", 'echo "error while loading shared libraries: libfoo.so" >&2\nexit 127');
    fs.utimesSync(env.CHROME_BIN, new Date(), new Date(Date.now() + 15000));
    result = await check();
    assert.match(result.error, /chromium-browser --version 退出码 127：error while loading shared libraries: libfoo\.so$/);
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

  await scenario("测试通知：按账号或全局默认配置向已配置的渠道发送，不受事件开关影响；失败带原因，账号中关闭的渠道不发送", async () => {
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
      assert.deepStrictEqual(
        result.json.results,
        [
          { channel: "ntfy", ok: true, error: "" },
          { channel: "email", ok: false, error: "缺少配置：SMTP 服务器、SMTP 用户名、SMTP 密码、收件人" },
        ],
        "邮件缺少 SMTP 配置时为失败并说明原因"
      );
      assert.strictEqual(requests.length, 1);
      assert.strictEqual(requests[0].title, "WeReadAssistant · 小明 · 测试通知");
      assert.match(requests[0].message, /测试通知/);

      await panel.call("PATCH", "api/settings", { defaults: { ntfyTopic: "global_topic", ntfyServer: server } });
      assert.deepStrictEqual((await panel.call("POST", "api/notifications/test")).json.results, [{ channel: "ntfy", ok: true, error: "" }]);
      assert.strictEqual(requests[1].title, "WeReadAssistant · 测试通知", "全局默认配置没有账号名称");
      assert.strictEqual(requests[1].topic, "global_topic");

      // 全局配置了 ntfy，账号中关闭：不发送，记为已关闭
      await panel.call("PATCH", "api/accounts/me", { overrides: { ntfyTopic: null, ntfyServer: null, ntfyEnabled: false, emailEnabled: null } });
      assert.deepStrictEqual((await panel.call("POST", "api/notifications/test", { accountId: "me" })).json.results, [
        { channel: "ntfy", ok: false, error: "已在配置中关闭，未发送", disabled: true },
      ]);
      assert.strictEqual(requests.length, 2, "账号中关闭的渠道不发送");

      assert.strictEqual((await panel.call("POST", "api/notifications/test", { accountId: "nobody" })).status, 404);
      assert.strictEqual((await panel.request("api/notifications/test", { method: "POST", cookie: panel.cookie })).status, 403);
    } finally {
      await new Promise((resolve) => ntfy.close(resolve));
    }
  });
};
