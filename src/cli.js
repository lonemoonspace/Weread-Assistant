#!/usr/bin/env node
const path = require("path");
const { CONFIG_SCHEMA } = require("./config/schema");
const { configFromEnv } = require("./config/resolve");
const { DEFAULT_PANEL_PORT, panelOptionsFromEnv } = require("./panel/options");
const { ensureDir, getDataPaths } = require("./reader/paths");
const { initLogFile } = require("./shared/log");
const { VERSION } = require("./shared/version");

function formatDefault(field) {
  if (field.secret || field.default === "") {
    return "";
  }
  return ` (default: ${field.default})`;
}

function showHelp() {
  const envLines = CONFIG_SCHEMA.map(
    (field) => `  ${field.env.padEnd(24)} ${field.label}${formatDefault(field)}`
  ).join("\n");

  console.log(`WeReadAssistant ${VERSION}

Usage:
  node src/cli.js [panel] [--port <port>]   Start the web panel (default command).
  node src/cli.js run                      Run one reading session, configured by environment variables.
  node src/cli.js run --login-only         Only log in (scan the QR code if needed) and save cookies.
  node src/cli.js help                     Show this help text.

run exits with 0 when the run succeeds, 1 when login times out or an error occurs.

Panel environment variables:
  PANEL_PORT               Listening port (default: ${DEFAULT_PANEL_PORT})
  PANEL_HOST               Listening address (default: 0.0.0.0)
  PANEL_PASSWORD           Panel password; generated on first start when unset
  PANEL_BASE_PATH          Path prefix behind a reverse proxy, e.g. /weread/ (default: /)
  PANEL_TRUST_PROXY        Trust X-Forwarded-* headers: true or the number of proxy hops (default: false)
  PANEL_PUBLIC_URL         Public URL of the panel, used in notification links
  PANEL_DATA_DIR           Panel data directory (default: data)

Run environment variables:
${envLines}`);
}

function parsePanelFlags(args) {
  const flags = {};
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--port" && args[i + 1] !== undefined) {
      flags.port = args[i + 1];
      i += 1;
    } else {
      throw new Error(`Unexpected arguments for panel: ${args.slice(i).join(" ")}`);
    }
  }
  return flags;
}

async function startPanelCommand(args) {
  const options = panelOptionsFromEnv(process.env, parsePanelFlags(args));
  ensureDir(path.resolve(options.dataDir));
  initLogFile(path.join(path.resolve(options.dataDir), "panel.log"));

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
    process.exit(0);
  };
  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.once("SIGINT", () => shutdown("SIGINT"));
}

async function main(argv) {
  const [command, ...rest] = argv;

  if (["help", "-h", "--help"].includes(command)) {
    showHelp();
    return;
  }

  if (!command || command === "panel" || command === "--port") {
    await startPanelCommand(command === "--port" ? argv : rest);
    return;
  }

  if (command === "run") {
    if (rest.includes("-h") || rest.includes("--help")) {
      showHelp();
      return;
    }
    const unexpected = rest.filter((arg) => arg !== "--login-only");
    if (unexpected.length > 0) {
      throw new Error(`Unexpected arguments for run: ${unexpected.join(" ")}`);
    }

    const config = configFromEnv(process.env);
    const paths = getDataPaths(config);
    ensureDir(paths.dataDir);
    initLogFile(paths.outputLog, { debug: config.debug });

    const { runOnce } = require("./reader/run");
    const result = await runOnce(config, { mode: rest.includes("--login-only") ? "login" : "read" });
    console.info("Run finished:", result.status);
    process.exit(result.status === "success" ? 0 : 1);
  }

  throw new Error(`Unknown command: ${command}`);
}

main(process.argv.slice(2)).catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
