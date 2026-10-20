// 阅读子进程入口：由面板 fork，经 IPC 接收本次运行的配置并上报运行事件，日志写到标准输出，由面板保存。
// 收到 SIGTERM / SIGINT 或与面板断开连接时关闭浏览器后退出。
//
// 面板 → 子进程：{ type: "start", mode: "read" | "login", config, screenshotDir, panelLink }
// 子进程 → 面板：{ event, data }，事件见 docs/design.md“子进程事件”
const { resolveConfig } = require("../config/resolve");
const { initConsole } = require("../shared/log");
const { VERSION } = require("../shared/version");
const { runOnce } = require("./run");

const START_MESSAGE_TIMEOUT_MS = 10000;

let lastSend = Promise.resolve();

// 按顺序发送；面板已断开时丢弃
function send(message) {
  lastSend = lastSend.then(
    () =>
      new Promise((resolve) => {
        if (!process.connected) {
          resolve();
          return;
        }
        process.send(message, () => resolve());
      })
  );
  return lastSend;
}

function waitForStartMessage() {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("没有收到面板下发的运行配置")), START_MESSAGE_TIMEOUT_MS);
    process.once("message", (message) => {
      clearTimeout(timer);
      resolve(message);
    });
  });
}

// 等标准输出中已写入的内容交给面板后再退出，避免丢失最后几行日志
function flushStdout() {
  return new Promise((resolve) => process.stdout.write("", () => resolve()));
}

async function main() {
  if (!process.send) {
    console.error("worker.js 只能由面板启动；手动运行请使用 node src/cli.js run --account <id>");
    process.exit(2);
  }

  const controller = new AbortController();
  const stop = (reason) => {
    if (!controller.signal.aborted) {
      console.warn(`${reason}，停止运行`);
      controller.abort();
    }
  };
  process.on("SIGTERM", () => stop("收到 SIGTERM"));
  // 在终端按 Ctrl+C 时面板与子进程都会收到 SIGINT，由面板统一停止
  process.on("SIGINT", () => stop("收到 SIGINT"));
  process.on("disconnect", () => stop("与面板的连接已断开"));

  const message = await waitForStartMessage();
  if (!message || message.type !== "start") {
    throw new Error("面板下发的消息格式不正确");
  }
  const config = resolveConfig(message.config);
  initConsole({ debug: config.debug });

  send({ event: "started", data: { version: VERSION } });
  const result = await runOnce(config, {
    mode: message.mode === "login" ? "login" : "read",
    signal: controller.signal,
    report: (event, data = {}) => send({ event, data }),
    terminalQr: false,
    screenshotDir: message.screenshotDir,
    panelLink: typeof message.panelLink === "string" ? message.panelLink : "",
    // 仅供测试：指向模拟页面并缩短等待时间
    homeUrl: message.homeUrl,
    timing: message.timing,
  });
  console.info("Run finished:", result.status);
  await Promise.all([lastSend, flushStdout()]);
  process.exit(0);
}

main().catch(async (error) => {
  console.error("阅读子进程出错:", error);
  await flushStdout();
  process.exit(1);
});
