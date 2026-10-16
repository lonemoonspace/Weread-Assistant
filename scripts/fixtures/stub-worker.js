// panel-smoke 使用的桩阅读子进程：协议与 src/reader/worker.js 相同，不连接浏览器。
// 按账号 ID（即 config.profileName）的前缀决定行为：
//   ok-*        正常阅读 2 分钟后上报 done
//   login-*     仅登录：上报登录链接，随后登录成功
//   fail-*      上报 error
//   timeout-*   上报 login-timeout
//   crash-*     不上报结果直接以退出码 3 退出
//   slow-*      打开书后一直阅读，收到 SIGTERM 后退出
//   stubborn-*  忽略 SIGTERM，只能被强制结束
//   hang-*      建立会话后不再有任何动作，收到 SIGTERM 后退出
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let lastSend = Promise.resolve();
function send(event, data = {}) {
  lastSend = lastSend.then(() => new Promise((resolve) => process.send({ event, data }, () => resolve())));
  return lastSend;
}

function log(message) {
  console.log(`[INFO][stub]: ${message}`);
}

async function exit(code) {
  await lastSend;
  await new Promise((resolve) => process.stdout.write("", resolve));
  process.exit(code);
}

process.once("message", async ({ mode, config }) => {
  const id = config.profileName;
  const kind = id.split("-")[0];
  const sessionId = `stub-session-${id}`;

  if (kind === "stubborn") {
    process.on("SIGTERM", () => log("忽略 SIGTERM"));
  } else {
    process.on("SIGTERM", async () => {
      log("收到 SIGTERM，关闭浏览器");
      await sleep(50);
      await exit(0);
    });
  }

  log(`mode=${mode} account=${config.accountName} dataDir=${config.dataDir}`);
  log(`PANEL_* 环境变量: [${Object.keys(process.env).filter((key) => key.startsWith("PANEL_")).join(",")}]`);
  log(`barkKey 已下发: ${Boolean(config.barkKey)}`);
  send("started", { version: "stub" });
  await sleep(50);
  if (kind === "crash") {
    log("模拟崩溃");
    await exit(3);
    return;
  }
  send("session", { sessionId });

  if (kind === "timeout" || kind === "login") {
    send("login-required", { url: `https://weread.qq.com/web/confirm?uid=${id}` });
    await sleep(150);
    if (kind === "timeout") {
      send("login-timeout");
      await exit(0);
      return;
    }
    send("login-ok");
    send("done", { minutes: 0 });
    await exit(0);
    return;
  }

  if (kind === "fail") {
    send("error", { message: "模拟的页面错误" });
    await exit(0);
    return;
  }

  if (kind === "hang") {
    setInterval(() => {}, 1000);
    return;
  }

  send("book-opened", { title: "测试书" });
  if (kind === "ok") {
    for (const minute of [1, 2]) {
      await sleep(50);
      log(`Reading minute: ${minute}`);
      send("reading-minute", { minute, total: 2, screenshot: `screenshot-${minute}.png` });
    }
    send("done", { minutes: 2 });
    await exit(0);
    return;
  }

  // slow / stubborn：一直阅读
  for (let minute = 1; ; minute += 1) {
    await sleep(100);
    send("reading-minute", { minute, total: 68, screenshot: "" });
  }
});
