// panel-smoke 使用的桩阅读子进程：协议与 src/reader/worker.js 相同，不连接浏览器。
// 按账号 ID（即 config.profileName）的前缀决定行为：
//   ok-*        正常阅读 2 分钟（写入两张截图）后上报 done
//   login-*     仅登录：上报登录链接，随后登录成功
//   qr-*        上报登录链接后一直等待扫码，收到 SIGTERM 后退出
//   qrimg-*     保存二维码截图（login-qr.png）但解析不出登录链接，一直等待扫码
//   fail-*      上报 error
//   timeout-*   上报 login-timeout
//   crash-*     不上报结果直接以退出码 3 退出
//   slow-*      打开书后一直阅读，收到 SIGTERM 后退出
//   stubborn-*  忽略 SIGTERM，只能被强制结束
//   hang-*      建立会话后不再有任何动作，收到 SIGTERM 后退出
//   skip-*      进度从第 1 分钟跳到第 5 分钟，最后上报一个超出上限的分钟数
const fs = require("fs");
const path = require("path");
const { PNG } = require("pngjs");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let lastSend = Promise.resolve();
function send(event, data = {}) {
  lastSend = lastSend.then(() => new Promise((resolve) => process.send({ event, data }, () => resolve())));
  return lastSend;
}

// 一张纯色的 PNG，颜色随分钟变化
function stubScreenshot(minute) {
  const png = new PNG({ width: 160, height: 100 });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = (minute * 80) % 256;
    png.data[i + 1] = 140;
    png.data[i + 2] = 200;
    png.data[i + 3] = 255;
  }
  return PNG.sync.write(png);
}

function log(message) {
  console.log(`[INFO][stub]: ${message}`);
}

async function exit(code) {
  await lastSend;
  await new Promise((resolve) => process.stdout.write("", resolve));
  process.exit(code);
}

process.once("message", async ({ mode, config, screenshotDir, panelLink }) => {
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

  log(`mode=${mode} account=${config.accountName} dataDir=${config.dataDir} panelLink=${panelLink || "-"}`);
  log(`环境变量: ${JSON.stringify(Object.keys(process.env).sort())}`);
  log(`barkKey 已下发: ${Boolean(config.barkKey)}`);
  // 模拟子进程不小心打印了密钥与登录链接，面板写入日志前应替换为掩码
  log(`模拟泄露: https://api.day.app/${config.barkKey} https://weread.qq.com/web/confirm?uid=${id}-uid&from=stub`);
  send("started", { version: "stub" });
  await sleep(50);
  if (kind === "crash") {
    log("模拟崩溃");
    await exit(3);
    return;
  }
  send("session", { sessionId });

  if (kind === "qrimg") {
    fs.writeFileSync(path.join(config.dataDir, "login-qr.png"), stubScreenshot(9));
    send("login-required", { url: "" });
    setInterval(() => {}, 1000);
    return;
  }

  if (kind === "qr") {
    send("login-required", { url: `https://weread.qq.com/web/confirm?uid=${id}` });
    setInterval(() => {}, 1000);
    return;
  }

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
    send("error", { message: config.barkKey ? `模拟的页面错误 ${config.barkKey}` : "模拟的页面错误" });
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
      // 与真实子进程一样把截图写入面板指定的运行目录
      fs.writeFileSync(path.join(screenshotDir, `screenshot-${minute}.png`), stubScreenshot(minute));
      send("reading-minute", { minute, total: 2, screenshot: `screenshot-${minute}.png` });
    }
    send("done", { minutes: 2 });
    await exit(0);
    return;
  }

  if (kind === "skip") {
    await sleep(100);
    send("reading-minute", { minute: 1, total: 5, screenshot: "" });
    await sleep(400);
    send("reading-minute", { minute: 5, total: 5, screenshot: "" });
    send("done", { minutes: 10 ** 9 });
    await exit(0);
    return;
  }

  // slow / stubborn：一直阅读
  for (let minute = 1; ; minute += 1) {
    await sleep(100);
    send("reading-minute", { minute, total: 68, screenshot: "" });
  }
});
