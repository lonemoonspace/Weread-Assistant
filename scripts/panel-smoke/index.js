#!/usr/bin/env node
/**
 * 面板 smoke 测试：在本机启动面板，用 HTTP 请求验证鉴权、会话（含跨重启保留）、限速、反向代理、安全响应头、
 * passkey（软件认证器 scripts/fixtures/soft-authenticator.js）、配置与账号，以及运行队列（排队、成功、失败、停止、强制结束、实时推送）。
 * 运行队列使用桩子进程 scripts/fixtures/stub-worker.js，不需要浏览器与 Selenium。
 * 每组场景在同目录下的一个文件中，各场景自己启动面板、准备数据，互不依赖。
 * 用法: node scripts/panel-smoke [--only runs,schedules]
 */

const { createSuite } = require("./helpers");

const GROUPS = ["auth", "sessions", "security", "passkeys", "settings", "accounts", "backup", "startup", "runs", "planner", "schedules", "history", "official", "tokens", "mcp"];

function selectedGroups(argv) {
  const index = argv.indexOf("--only");
  if (index < 0) {
    return GROUPS;
  }
  const names = String(argv[index + 1] || "").split(",").map((name) => name.trim()).filter(Boolean);
  const unknown = names.filter((name) => !GROUPS.includes(name));
  if (names.length === 0 || unknown.length > 0) {
    throw new Error(`--only 只能是以下分组（逗号分隔）：${GROUPS.join(", ")}`);
  }
  return GROUPS.filter((name) => names.includes(name));
}

async function main() {
  const groups = selectedGroups(process.argv.slice(2));
  const suite = createSuite();
  try {
    for (const group of groups) {
      await require(`./${group}`)(suite);
    }
    const scope = groups.length === GROUPS.length ? "" : `，分组 ${groups.join(", ")}`;
    console.log(`\n面板 smoke 全部通过（${suite.results.length} 个场景${scope}）`);
  } finally {
    await suite.close();
  }
}

main().catch((error) => {
  console.error(`面板 smoke 失败: ${error.message}`);
  if (error.capturedLogs) {
    console.error("捕获的日志:");
    console.error(error.capturedLogs.join("\n"));
  }
  process.exit(1);
});
