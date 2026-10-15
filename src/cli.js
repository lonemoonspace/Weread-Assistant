#!/usr/bin/env node
const { CONFIG_SCHEMA } = require("./config/schema");
const { configFromEnv } = require("./config/resolve");
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
    (field) => `  ${field.env.padEnd(18)} ${field.label}${formatDefault(field)}`
  ).join("\n");

  console.log(`WeReadAssistant ${VERSION}

Usage:
  node src/cli.js run     Run one reading session, configured by environment variables.
  node src/cli.js help    Show this help text.

Environment variables:
${envLines}`);
}

async function main(argv) {
  const [command, ...rest] = argv;

  if (!command || ["help", "-h", "--help"].includes(command)) {
    showHelp();
    return;
  }

  if (command === "run") {
    if (rest.includes("-h") || rest.includes("--help")) {
      showHelp();
      return;
    }
    if (rest.length > 0) {
      throw new Error(`Unexpected arguments for run: ${rest.join(" ")}`);
    }

    const config = configFromEnv(process.env);
    const paths = getDataPaths(config);
    ensureDir(paths.dataDir);
    initLogFile(paths.outputLog, { debug: config.debug });

    const { runOnce } = require("./reader/run");
    await runOnce(config);
    process.exit(0);
  }

  throw new Error(`Unknown command: ${command}`);
}

main(process.argv.slice(2)).catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
