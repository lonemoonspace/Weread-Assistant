#!/usr/bin/env node
/**
 * 配置解析 smoke 测试：运行配置与面板参数的类型、范围、可选值校验，以及 CLI 遇到非法配置时的退出码。
 * 不需要浏览器与网络。
 * 用法: node scripts/config-smoke.js
 */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const { configFromEnv } = require(path.resolve(__dirname, "..", "src", "config", "resolve"));
const { panelOptionsFromEnv } = require(path.resolve(__dirname, "..", "src", "panel", "options"));
const { createStore } = require(path.resolve(__dirname, "..", "src", "panel", "store"));

const CLI = path.resolve(__dirname, "..", "src", "cli.js");

function rejects(fn, pattern) {
  assert.throws(fn, pattern);
}

function runCli(args, env) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, ...env },
    timeout: 30000,
  });
}

const scenarios = [
  ["未设置任何变量时使用默认值", () => {
    const config = configFromEnv({});
    assert.strictEqual(config.duration, 10);
    assert.strictEqual(config.selection, 2);
    assert.strictEqual(config.speed, "slow");
    assert.strictEqual(config.emailEnabled, false);
    assert.ok(Object.isFrozen(config));
  }],

  ["整数必须是完整的十进制数，带后缀的值报错", () => {
    assert.strictEqual(configFromEnv({ WEREAD_DURATION: " 68 " }).duration, 68);
    rejects(() => configFromEnv({ WEREAD_DURATION: "10abc" }), /WEREAD_DURATION 必须是整数：10abc/);
    rejects(() => configFromEnv({ WEREAD_SELECTION: "2xyz" }), /WEREAD_SELECTION 必须是整数/);
    rejects(() => configFromEnv({ EMAIL_PORT: "465oops" }), /EMAIL_PORT 必须是整数/);
    rejects(() => configFromEnv({ WEREAD_DURATION: "1.5" }), /WEREAD_DURATION 必须是整数/);
  }],

  ["阅读时长与等待扫码时长必须为正整数", () => {
    rejects(() => configFromEnv({ WEREAD_DURATION: "0" }), /WEREAD_DURATION 必须不小于 1：0/);
    rejects(() => configFromEnv({ WEREAD_DURATION: "-5" }), /WEREAD_DURATION 必须不小于 1/);
    rejects(() => configFromEnv({ WEREAD_LOGIN_TIMEOUT: "0" }), /WEREAD_LOGIN_TIMEOUT 必须不小于 1/);
    assert.strictEqual(configFromEnv({ WEREAD_DURATION: "1" }).duration, 1);
  }],

  ["SMTP 端口必须在 1–65535 之间", () => {
    rejects(() => configFromEnv({ EMAIL_PORT: "70000" }), /EMAIL_PORT 必须在 1–65535 之间/);
    assert.strictEqual(configFromEnv({ EMAIL_PORT: "587" }).emailPort, 587);
  }],

  ["选书方式与阅读速度只接受列出的取值", () => {
    for (const value of ["-1", "0", "1", "4"]) {
      assert.strictEqual(configFromEnv({ WEREAD_SELECTION: value }).selection, Number(value));
    }
    rejects(() => configFromEnv({ WEREAD_SELECTION: "-2" }), /WEREAD_SELECTION 只能是 -1、0、1、2、3、4：-2/);
    rejects(() => configFromEnv({ WEREAD_SELECTION: "5" }), /WEREAD_SELECTION 只能是/);
    assert.strictEqual(configFromEnv({ WEREAD_SPEED: "fast" }).speed, "fast");
    rejects(() => configFromEnv({ WEREAD_SPEED: "turbo" }), /WEREAD_SPEED 只能是 slow、normal、fast：turbo/);
  }],

  ["布尔值拼写错误时报错", () => {
    assert.strictEqual(configFromEnv({ ENABLE_EMAIL: "yes" }).emailEnabled, true);
    assert.strictEqual(configFromEnv({ WEREAD_SCREENSHOT: "off" }).screenshot, false);
    rejects(() => configFromEnv({ ENABLE_EMAIL: "ture" }), /ENABLE_EMAIL 只能是 true 或 false：ture/);
  }],

  ["面板端口必须是 1–65535 的整数", () => {
    assert.strictEqual(panelOptionsFromEnv({}).port, 26868);
    assert.strictEqual(panelOptionsFromEnv({ PANEL_PORT: "30000" }).port, 30000);
    rejects(() => panelOptionsFromEnv({ PANEL_PORT: "26868foo" }), /PANEL_PORT 必须是整数/);
    rejects(() => panelOptionsFromEnv({ PANEL_PORT: "0" }), /PANEL_PORT 必须在 1–65535 之间/);
    rejects(() => panelOptionsFromEnv({ PANEL_PORT: "70000" }), /PANEL_PORT 必须在 1–65535 之间/);
  }],

  ["代理层数与子路径", () => {
    assert.strictEqual(panelOptionsFromEnv({ PANEL_TRUST_PROXY: "true" }).trustProxy, 1);
    assert.strictEqual(panelOptionsFromEnv({ PANEL_TRUST_PROXY: "2" }).trustProxy, 2);
    assert.strictEqual(panelOptionsFromEnv({ PANEL_TRUST_PROXY: "false" }).trustProxy, false);
    rejects(() => panelOptionsFromEnv({ PANEL_TRUST_PROXY: "maybe" }), /PANEL_TRUST_PROXY 只能是/);
    assert.strictEqual(panelOptionsFromEnv({ PANEL_BASE_PATH: "weread" }).basePath, "/weread/");
    rejects(() => panelOptionsFromEnv({ PANEL_BASE_PATH: "/a b/" }), /PANEL_BASE_PATH 含有不支持的字符/);
  }],

  ["CLI：非法配置与多余参数直接报错退出", () => {
    const run = runCli;

    const badDuration = run(["run"], { WEREAD_DURATION: "0" });
    assert.strictEqual(badDuration.status, 1);
    assert.match(badDuration.stderr, /WEREAD_DURATION 必须不小于 1/);

    const badPort = run(["panel"], { PANEL_PORT: "0" });
    assert.strictEqual(badPort.status, 1);
    assert.match(badPort.stderr, /PANEL_PORT 必须在 1–65535 之间/);

    const portFlag = run(["panel", "--port", "1234"], {});
    assert.strictEqual(portFlag.status, 1);
    assert.match(portFlag.stderr, /Unexpected arguments for panel: --port 1234/);

    const missingValue = run(["run", "--account"], {});
    assert.strictEqual(missingValue.status, 1);
    assert.match(missingValue.stderr, /Unexpected arguments for run: --account/);
  }],

  ["CLI：run --account 按面板中的账号配置运行，日志写入账号目录", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "config-smoke-"));
    const noPanel = runCli(["run", "--account", "me"], { PANEL_DATA_DIR: dataDir });
    assert.strictEqual(noPanel.status, 1);
    assert.match(noPanel.stderr, /面板数据不存在/);

    // 全局默认指向一个不可达的 Selenium，账号覆盖等待扫码时长
    const store = createStore(dataDir, { seedDefaults: { seleniumUrl: "http://127.0.0.1:9" } });
    await store.update((data) => {
      data.accounts.push({ id: "me", name: "小明", enabled: true, createdAt: new Date().toISOString(), overrides: { loginTimeout: 1 } });
    });

    const missing = runCli(["run", "--account", "nobody"], { PANEL_DATA_DIR: dataDir });
    assert.strictEqual(missing.status, 1);
    assert.match(missing.stderr, /账号不存在：nobody/);

    const result = runCli(["run", "--account", "me", "--login-only"], { PANEL_DATA_DIR: dataDir, SELENIUM_URL: "http://ignored:4444" });
    assert.strictEqual(result.status, 1, "连接不到 Selenium 时应以退出码 1 结束");
    const log = fs.readFileSync(path.join(dataDir, "accounts", "me", "output.log"), "utf8");
    assert.match(log, /账号: me 数据目录: .*accounts[\\/]me/);
    assert.match(log, /SELENIUM_URL:  http:\/\/127\.0\.0\.1:9/, "使用面板中的全局配置，而不是环境变量");
    assert.match(log, /Run finished: error/);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }],
];

(async () => {
  let passed = 0;
  for (const [name, fn] of scenarios) {
    try {
      await fn();
    } catch (error) {
      console.error(`配置 smoke 失败（${name}）: ${error.message}`);
      process.exit(1);
    }
    passed += 1;
    console.log(`✅ ${name}`);
  }
  console.log(`\n配置 smoke 全部通过（${passed} 个场景）`);
})();
