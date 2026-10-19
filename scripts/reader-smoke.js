#!/usr/bin/env node
/**
 * 自动阅读流程 smoke 测试。
 *
 * 用本地模拟页面（scripts/fixtures/mock-weread.js）驱动真实浏览器跑完整的 runOnce，
 * 覆盖扫码登录、二维码过期刷新、等待超时、cookies 损坏、选书、翻章、读完回到目录、白屏刷新等分支，
 * 并检查阅读循环的翻动节奏是否符合配置；再以面板的方式启动阅读子进程（src/reader/worker.js），
 * 检查经 IPC 上报的事件，以及收到 SIGTERM 后关闭浏览器。不访问微信读书。
 *
 * 用法: SELENIUM_URL=http://localhost:4444 node scripts/reader-smoke.js
 *   READER_SMOKE_ONLY=<场景名> 只运行一个场景（login / timeout / corrupt / reading / single / worker / worker-stop）。
 *   SELENIUM_URL 默认 http://localhost:4444，也可以直接指向 chromedriver（如 http://localhost:9515）。
 *   浏览器需要能访问本机的模拟服务；Selenium 跑在容器里时用 --network host 启动，
 *   或通过 MOCK_HOST 指定浏览器访问本机时使用的地址。
 */

const assert = require("assert");
const { fork } = require("child_process");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

const { resolveConfig } = require(path.resolve(__dirname, "..", "src", "config", "resolve"));
const { runOnce } = require(path.resolve(__dirname, "..", "src", "reader", "run"));
const { startMockWeread } = require("./fixtures/mock-weread");

const WORKER_PATH = path.resolve(__dirname, "..", "src", "reader", "worker.js");
const SELENIUM_URL = process.env.SELENIUM_URL || "http://localhost:4444";
const ONLY = process.env.READER_SMOKE_ONLY || "";

// 所有场景共用的缩短版时间参数
const FAST_TIMING = {
  loginPollMs: 300,
  elementWaitMs: 2000,
  pageWaitMs: 5000,
};

function startNtfyMock() {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      requests.push(JSON.parse(body));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("{}");
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        baseUrl: `http://127.0.0.1:${server.address().port}`,
        requests,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

async function withCapturedConsole(fn) {
  const original = { info: console.info, warn: console.warn, error: console.error, debug: console.debug, log: console.log };
  const logs = [];
  const capture = (...args) => logs.push(args.map((arg) => (arg instanceof Error ? arg.stack : String(arg))).join(" "));
  Object.assign(console, { info: capture, warn: capture, error: capture, debug: capture, log: capture });
  try {
    return await fn();
  } catch (error) {
    error.capturedLogs = logs;
    throw error;
  } finally {
    Object.assign(console, original);
  }
}

function countEvents(events, type) {
  return events.filter((event) => event.type === type).length;
}

async function until(check, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) {
      throw new Error(message);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

// 与面板相同的方式启动阅读子进程：经 IPC 下发配置，收集上报的事件与标准输出
function startWorker(message) {
  const child = fork(WORKER_PATH, [], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
  const reported = [];
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  child.on("message", (event) => reported.push(event));
  const exited = new Promise((resolve) => child.once("close", (code, signal) => resolve({ code, signal })));
  child.send({ type: "start", ...message });
  return { child, reported, exited, output: () => output };
}

// 会话被删除后，WebDriver 对该会话的请求返回 invalid session id
async function sessionClosed(sessionId) {
  const res = await fetch(`${SELENIUM_URL.replace(/\/+$/, "")}/session/${sessionId}/url`);
  const body = await res.json().catch(() => ({}));
  return res.status === 404 && body.value && body.value.error === "invalid session id";
}

async function main() {
  const mock = await startMockWeread();
  const ntfy = await startNtfyMock();
  const results = [];

  // 建立临时数据目录，运行一次 runOnce，再交给 check 断言；values 可以是接收首页地址的函数
  const scenario = async (title, { name, site, values = {}, mode, timing, prepare, check }) => {
    if (ONLY && ONLY !== name) {
      return;
    }
    const homeUrl = mock.addScenario(name, site);
    const extraValues = typeof values === "function" ? values(homeUrl) : values;
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `reader-smoke-${name}-`));
    ntfy.requests.length = 0;
    const config = resolveConfig({
      seleniumUrl: SELENIUM_URL,
      dataDir,
      ntfyTopic: "reader_smoke",
      ntfyServer: ntfy.baseUrl,
      screenshot: false,
      // 书架中找不到书时打开的默认阅读链接也指向模拟页面，任何场景都不访问微信读书
      bookUrl: `${homeUrl}reader?book=1&ch=1`,
      ...extraValues,
    });
    if (prepare) {
      prepare(dataDir);
    }

    const startedAt = Date.now();
    const note = await withCapturedConsole(async () => {
      const result = await runOnce(config, { mode, homeUrl, timing: { ...FAST_TIMING, ...timing } });
      return check({ result, events: mock.events(name), pushes: ntfy.requests, dataDir });
    });
    fs.rmSync(dataDir, { recursive: true, force: true });
    results.push(title);
    const seconds = Math.round((Date.now() - startedAt) / 1000);
    console.log(`✅ ${title}（${seconds} 秒${note ? `，${note}` : ""}）`);
  };

  try {
    await scenario("扫码登录：二维码过期后刷新，扫码成功后保存 cookies", {
      name: "login",
      site: { qrExpireMs: 3000, scanOnQr: 2, scanDelayMs: 1500 },
      mode: "login",
      timing: { loginTimeoutMs: 30000, loginLinkPushIntervalMs: 10 * 60000 },
      check({ result, events, pushes, dataDir }) {
        assert.strictEqual(result.status, "success");
        assert.ok(countEvents(events, "refresh") >= 1, "二维码过期后应点击刷新");
        // 从二维码图片解出的登录链接被推送；刷新后的链接因推送间隔限制不再推送
        const loginPushes = pushes.filter((push) => push.title.endsWith("需要扫码"));
        assert.strictEqual(loginPushes.length, 1);
        assert.strictEqual(loginPushes[0].click, mock.loginUrlFor("login", 1));
        assert.ok(fs.existsSync(path.join(dataDir, "login.png")));
        assert.ok(fs.existsSync(path.join(dataDir, "login-qr.png")));
        const cookies = JSON.parse(fs.readFileSync(path.join(dataDir, "cookies.json"), "utf8"));
        assert.ok(cookies.some((cookie) => cookie.name === "wr_vid"));
      },
    });

    await scenario("等待扫码超时：不限次数刷新二维码，以 login-timeout 结束并通知", {
      name: "timeout",
      site: { qrExpireMs: 1500 },
      mode: "login",
      timing: { loginTimeoutMs: 25000 },
      check({ result, events, pushes }) {
        assert.strictEqual(result.status, "login-timeout");
        // 旧版最多等 3 轮；现在等待时长内二维码过期就刷新
        assert.ok(countEvents(events, "refresh") >= 3, `刷新次数 ${countEvents(events, "refresh")} 应不少于 3`);
        assert.ok(pushes.some((push) => push.title.endsWith("运行失败") && push.message.includes("等待扫码超时")));
        return `刷新二维码 ${countEvents(events, "refresh")} 次`;
      },
    });

    await scenario("cookies 损坏：备份后照常运行并写入新的 cookies", {
      name: "corrupt",
      site: { loggedIn: true },
      mode: "login",
      prepare(dataDir) {
        fs.writeFileSync(path.join(dataDir, "cookies.json"), "{broken");
      },
      check({ result, dataDir }) {
        assert.strictEqual(result.status, "success");
        const files = fs.readdirSync(dataDir);
        assert.ok(files.some((file) => file.startsWith("cookies.json.corrupt-")), "损坏的 cookies 应被备份");
        assert.ok(Array.isArray(JSON.parse(fs.readFileSync(path.join(dataDir, "cookies.json"), "utf8"))));
      },
    });

    await scenario("阅读：等书架加载后选书（跳过公众号文章）、翻到下一章、读完回到目录，翻动节奏符合配置", {
      name: "reading",
      site: { loggedIn: true, books: 3, mpArticles: 1, shelfLoadMs: 1500, chapters: 2, contentHeight: 1800 },
      values: { selection: 2 },
      timing: { durationMs: 30000, pressIntervalMs: [100, 200] },
      check({ result, events, pushes }) {
        assert.strictEqual(result.status, "success");
        const chapters = events.filter((event) => event.type === "chapter").map((event) => `${event.book}:${event.ch}`);
        assert.strictEqual(chapters[0], "2:1", "应打开书架第 2 本书");
        assert.ok(chapters.includes("2:2"), "应翻到下一章");
        const finishedAt = chapters.indexOf("2:2");
        assert.ok(chapters.slice(finishedAt + 1).includes("2:1"), "读完后应回到目录中的章节");
        assert.ok(countEvents(events, "vertical") >= 1, "应切换到上下滚动模式");
        // 旧版每轮被隐式等待拖到 10-15 秒，30 秒只能翻动两三次
        const presses = countEvents(events, "press");
        assert.ok(presses >= 30, `30 秒内翻动 ${presses} 次，应不少于 30 次`);
        assert.ok(pushes.some((push) => push.title === "WeReadAssistant · 阅读完成"));
        assert.ok(!pushes.some((push) => push.title.endsWith("登录成功")), "登录成功通知默认关闭");
        return `翻动 ${presses} 次`;
      },
    });

    await scenario("目录只有一项时回到该项；截图过小视为白屏并刷新页面", {
      name: "single",
      site: { loggedIn: true, chapters: 1, frontMatter: true, contentHeight: 600 },
      values: (homeUrl) => ({ selection: -1, bookUrl: `${homeUrl}reader?book=1&ch=1`, screenshot: true }),
      timing: { durationMs: 13000, minuteMs: 4000, pressIntervalMs: [300, 500] },
      check({ result, events, dataDir }) {
        assert.strictEqual(result.status, "success");
        assert.ok(events.some((event) => event.type === "chapter" && event.ch === "0"), "应点击目录中唯一的条目");
        assert.ok(fs.existsSync(path.join(dataDir, "screenshot-1.png")));
        assert.ok(countEvents(events, "reload") >= 1, "白屏截图后应刷新页面");
      },
    });

    // 以下两个场景以子进程方式运行，不经过 runOnce 的场景封装
    const workerScenario = async (title, { name, site, values = () => ({}), mode = "read", timing, run, screenshotDir }) => {
      if (ONLY && ONLY !== name) {
        return;
      }
      const homeUrl = mock.addScenario(name, site);
      const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `reader-smoke-${name}-`));
      ntfy.requests.length = 0;
      const config = resolveConfig({
        seleniumUrl: SELENIUM_URL,
        dataDir,
        ntfyTopic: "reader_smoke",
        ntfyServer: ntfy.baseUrl,
        screenshot: false,
        accountName: "子进程",
        bookUrl: `${homeUrl}reader?book=1&ch=1`,
        ...values(homeUrl),
      });
      const startedAt = Date.now();
      const shotsDir = screenshotDir ? path.join(dataDir, screenshotDir) : undefined;
      if (shotsDir) {
        fs.mkdirSync(shotsDir);
      }
      const worker = startWorker({ mode, config, homeUrl, timing: { ...FAST_TIMING, ...timing }, screenshotDir: shotsDir });
      let note;
      try {
        note = await run({ worker, events: mock.events(name), pushes: ntfy.requests, dataDir });
      } catch (error) {
        worker.child.kill("SIGKILL");
        error.capturedLogs = [worker.output()];
        throw error;
      }
      fs.rmSync(dataDir, { recursive: true, force: true });
      results.push(title);
      const seconds = Math.round((Date.now() - startedAt) / 1000);
      console.log(`✅ ${title}（${seconds} 秒${note ? `，${note}` : ""}）`);
    };

    await workerScenario("阅读子进程：经 IPC 接收配置，按顺序上报登录、选书、进度与完成事件", {
      name: "worker",
      site: { qrExpireMs: 60000, scanOnQr: 1, scanDelayMs: 6000, chapters: 3, contentHeight: 1800 },
      values: (homeUrl) => ({ selection: -1, bookUrl: `${homeUrl}reader?book=1&ch=1`, screenshot: true }),
      timing: { loginTimeoutMs: 30000, durationMs: 9000, minuteMs: 3000, pressIntervalMs: [300, 500] },
      // 与面板一样指定运行目录，阅读截图写到这里
      screenshotDir: "run",
      async run({ worker, dataDir }) {
        const { code, signal } = await worker.exited;
        assert.deepStrictEqual({ code, signal }, { code: 0, signal: null });
        const names = worker.reported.map((event) => event.event);
        const order = ["started", "session", "login-required", "login-ok", "book-opened", "reading-minute", "done"];
        assert.deepStrictEqual(names.filter((name, i) => name !== names[i - 1]), order);
        const byName = (name) => worker.reported.find((event) => event.event === name).data;
        assert.strictEqual(byName("login-required").url, mock.loginUrlFor("worker", 1));
        assert.strictEqual(byName("book-opened").title, "Mock Book 1");
        const minutes = worker.reported.filter((event) => event.event === "reading-minute").map((event) => event.data);
        // 9 秒、每“分钟” 3 秒：第 3 次可能正好落在结束时刻
        assert.ok(minutes.length >= 2 && minutes.every((data, i) => data.minute === i + 1), "阅读进度应逐分钟上报");
        assert.ok(minutes.every((data) => data.total === 3));
        assert.strictEqual(minutes[0].screenshot, "screenshot-1.png");
        assert.ok(fs.existsSync(path.join(dataDir, "run", "screenshot-1.png")), "截图写入指定的运行目录");
        assert.ok(!fs.existsSync(path.join(dataDir, "screenshot-1.png")));
        assert.ok(fs.existsSync(path.join(dataDir, "cookies.json")), "cookies 仍写入账号数据目录");
        assert.ok(await sessionClosed(byName("session").sessionId), "运行结束后应关闭浏览器会话");
        const output = worker.output();
        assert.match(output, /^\[INFO\]\[[^\]]+\]: /m, "日志应带级别与时间");
        assert.match(output, /Selenium 状态（[^）]+）：就绪/, "连接浏览器前记录 Selenium 状态");
        assert.match(output, /Run finished: success/);
        assert.ok(!/[▄▀█]/.test(output), "由面板运行时不在日志中打印二维码");
        // 登录链接只经事件交给面板，不写入日志
        assert.match(output, /已解析登录链接/);
        assert.ok(!output.includes(mock.loginUrlFor("worker", 1)), "日志中不应出现登录链接");
        assert.ok(!output.includes("uid="), "日志中不应出现登录链接中的 uid");
      },
    });

    await workerScenario("阅读子进程：收到 SIGTERM 后关闭浏览器并退出，不上报失败、不发送失败通知", {
      name: "worker-stop",
      site: { loggedIn: true, books: 2, chapters: 3, contentHeight: 1800 },
      timing: { durationMs: 120000, minuteMs: 2000, pressIntervalMs: [8000, 10000] },
      async run({ worker, pushes }) {
        await until(() => worker.reported.some((event) => event.event === "reading-minute"), 30000, "没有开始阅读");
        // 等这一轮的页面操作做完，在两次翻动之间的等待中停止
        await new Promise((resolve) => setTimeout(resolve, 1500));
        const stopAt = Date.now();
        worker.child.kill("SIGTERM");
        const { code, signal } = await worker.exited;
        const seconds = (Date.now() - stopAt) / 1000;
        assert.deepStrictEqual({ code, signal }, { code: 0, signal: null });
        // 翻动间隔为 8–10 秒，停止应打断等待而不是等到下一轮
        assert.ok(seconds < 4, `从 SIGTERM 到退出用了 ${seconds} 秒`);
        const names = worker.reported.map((event) => event.event);
        assert.ok(!names.includes("error") && !names.includes("done"), `不应上报结果：${names.join(",")}`);
        const { sessionId } = worker.reported.find((event) => event.event === "session").data;
        assert.ok(await sessionClosed(sessionId), "停止后应关闭浏览器会话");
        const output = worker.output();
        assert.match(output, /收到 SIGTERM，停止运行/);
        assert.match(output, /Browser closed\./);
        assert.match(output, /Run finished: stopped/);
        assert.ok(!pushes.some((push) => push.title.endsWith("运行失败")), "停止不应发送失败通知");
        return `${seconds.toFixed(1)} 秒内退出`;
      },
    });

    // 一个没有程序监听的端口
    const closedPort = await new Promise((resolve) => {
      const server = http.createServer();
      server.listen(0, "127.0.0.1", () => {
        const { port } = server.address();
        server.close(() => resolve(port));
      });
    });
    await workerScenario("阅读子进程：连不上 Selenium 时上报写明地址与原因的错误，日志中不出现地址里的密码", {
      name: "worker-no-selenium",
      site: {},
      values: () => ({ seleniumUrl: `http://robot:pw-9527@127.0.0.1:${closedPort}` }),
      async run({ worker, pushes }) {
        const { code, signal } = await worker.exited;
        assert.deepStrictEqual({ code, signal }, { code: 0, signal: null });
        const error = worker.reported.find((event) => event.event === "error");
        assert.ok(error, "应上报错误");
        assert.strictEqual(
          error.data.message,
          `无法连接 Selenium（http://127.0.0.1:${closedPort}）：连接被拒绝（ECONNREFUSED），请确认 Selenium 正在运行、地址正确`
        );
        const output = worker.output();
        assert.match(output, new RegExp(`Selenium 状态（http://127\\.0\\.0\\.1:${closedPort}）：无法连接，连接被拒绝（ECONNREFUSED）`));
        assert.ok(!output.includes("pw-9527"), "日志中不应出现 Selenium 地址里的密码");
        assert.ok(pushes.some((push) => push.title.endsWith("运行失败")), "应发送失败通知");
      },
    });

    console.log(`\n阅读流程 smoke 全部通过（${results.length} 个场景）`);
  } finally {
    await mock.close();
    await ntfy.close();
  }
}

main().catch((error) => {
  console.error(`阅读流程 smoke 失败: ${error.message}`);
  if (error.capturedLogs) {
    console.error("捕获的日志:");
    console.error(error.capturedLogs.join("\n"));
  }
  process.exit(1);
});
