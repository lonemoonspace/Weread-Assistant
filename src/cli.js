#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const { DEFAULT_PANEL_PORT, panelDataDirFromEnv, panelOptionsFromEnv, publicUrlWarning } = require("./panel/options");
const { ensureDir, getDataPaths } = require("./reader/paths");
const { ensurePrivateDir } = require("./shared/files");
const { closeLogFile, initLogFile } = require("./shared/log");
const { VERSION } = require("./shared/version");

function showHelp() {
  console.log(`WeReadAssistant ${VERSION}

Usage:
  node src/cli.js [panel]                  Start the web panel (default command).
  node src/cli.js run --account <id>       Run one reading session for a panel account, using its saved settings.
                                           Add --login-only to only log in (scan the QR code if needed) and save cookies.
  node src/cli.js help                     Show this help text.

Reading settings, notifications and schedules are configured in the panel.

run exits with 0 when the run succeeds, 1 when login times out, an error occurs or it is stopped
(SIGTERM / Ctrl+C close the browser before exiting).

Environment variables:
  PANEL_PORT               Listening port (default: ${DEFAULT_PANEL_PORT})
  PANEL_HOST               Listening address (default: 0.0.0.0)
  PANEL_PASSWORD           Panel password; generated on first start when unset
  PANEL_BASE_PATH          Path prefix behind a reverse proxy, e.g. /weread/ (default: /)
  PANEL_TRUST_PROXY        Trust X-Forwarded-* headers: true or the number of proxy hops (default: false)
  PANEL_PUBLIC_URL         Public URL of the panel, used in notification links; an HTTPS URL enables passkey login
  PANEL_FORCE_PASSWORD_LOGIN  true: allow password login even if it is turned off in settings (recovery)
  PANEL_DATA_DIR           Panel data directory (default: data)
  SELENIUM_URL             Selenium address written to the panel's global settings on first start;
                           leave unset to use the built-in browser (Chromium + chromedriver in the image)
  CHROME_BIN               Built-in browser binary (default: chromium-browser or chromium on PATH)
  CHROMEDRIVER_PATH        Built-in chromedriver binary (default: chromedriver on PATH)`);
}

async function startPanelCommand(args) {
  // 面板只读环境变量，端口等参数与镜像健康检查使用同一来源
  if (args.length > 0) {
    throw new Error(`Unexpected arguments for panel: ${args.join(" ")}`);
  }
  const options = panelOptionsFromEnv(process.env);
  ensureDir(path.resolve(options.dataDir));
  initLogFile(path.join(path.resolve(options.dataDir), "panel.log"));
  // 每条提示单独输出，都带上级别与时间前缀
  for (const line of publicUrlWarning(options).split("\n").filter(Boolean)) {
    console.warn(line);
  }

  const { startPanel } = require("./panel/server");
  const panel = await startPanel(options);
  if (panel.generatedPassword) {
    // 只输出到标准输出，不写入 panel.log
    console.log(`面板初始密码：${panel.generatedPassword}（只在首次启动时显示，请妥善保存；登录后可修改，或设置 PANEL_PASSWORD 改用自己的密码）`);
  }
  console.info(`WeReadAssistant ${VERSION} 面板已启动：http://${options.host}:${panel.port}${options.basePath}`);

  // 容器中 node 作为 1 号进程运行，需要自己处理停止信号
  const shutdown = async (signal) => {
    console.info(`收到 ${signal}，正在停止面板...`);
    await panel.close();
    await closeLogFile();
    process.exit(0);
  };
  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.once("SIGINT", () => shutdown("SIGINT"));
}

function parseRunArgs(args) {
  const parsed = { accountId: "", loginOnly: false };
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--login-only") {
      parsed.loginOnly = true;
    } else if (args[i] === "--account" && args[i + 1] && !args[i + 1].startsWith("-")) {
      parsed.accountId = args[i + 1];
      i += 1;
    } else {
      throw new Error(`Unexpected arguments for run: ${args.slice(i).join(" ")}`);
    }
  }
  return parsed;
}

// 按面板中保存的账号配置生成运行配置；面板数据不存在、账号不存在或已停用时报错
function configFromPanelAccount(accountId) {
  // 只读取数据目录：PANEL_PORT、PANEL_PUBLIC_URL 等面板参数与命令行运行无关，取值非法也不影响
  const dataDir = path.resolve(panelDataDirFromEnv(process.env));
  if (!fs.existsSync(path.join(dataDir, "panel.json"))) {
    throw new Error(`面板数据不存在：${path.join(dataDir, "panel.json")}，请先启动面板并创建账号（或设置 PANEL_DATA_DIR）`);
  }
  const { createStore } = require("./panel/store");
  const { findAccount } = require("./panel/accounts");
  const { resolveAccountConfig } = require("./panel/config");
  const data = createStore(dataDir, { readOnly: true }).get();
  const account = findAccount(data, accountId);
  if (!account.enabled) {
    throw new Error(`账号已停用：${accountId}，请先在面板中启用`);
  }
  return resolveAccountConfig(data, account, dataDir);
}

async function main(argv) {
  const [command, ...rest] = argv;

  if (["help", "-h", "--help"].includes(command)) {
    showHelp();
    return;
  }

  if (!command || command === "panel") {
    await startPanelCommand(rest);
    return;
  }

  if (command === "run") {
    if (rest.includes("-h") || rest.includes("--help")) {
      showHelp();
      return;
    }
    const { accountId, loginOnly } = parseRunArgs(rest);
    if (!accountId) {
      throw new Error("run 需要指定账号：node src/cli.js run --account <id>（账号在面板中创建）");
    }
    const config = configFromPanelAccount(accountId);
    const paths = getDataPaths(config);
    ensurePrivateDir(paths.dataDir);
    initLogFile(paths.outputLog, { debug: config.debug });

    const { runOnce } = require("./reader/run");
    console.info("账号:", accountId, "数据目录:", config.dataDir);
    // 在容器中作为 1 号进程运行时没有默认的信号处理，需要自己响应 docker stop 与 Ctrl+C：关闭浏览器后退出
    const controller = new AbortController();
    const stop = (signal) => {
      console.warn(`收到 ${signal}，正在停止...`);
      controller.abort();
    };
    process.once("SIGTERM", () => stop("SIGTERM"));
    process.once("SIGINT", () => stop("SIGINT"));
    const result = await runOnce(config, { mode: loginOnly ? "login" : "read", signal: controller.signal });
    console.info("Run finished:", result.status);
    await closeLogFile();
    process.exit(result.status === "success" ? 0 : 1);
  }

  throw new Error(`Unknown command: ${command}`);
}

main(process.argv.slice(2)).catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
