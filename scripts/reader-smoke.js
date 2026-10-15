#!/usr/bin/env node
/**
 * 自动阅读流程 smoke 测试。
 *
 * 用本地模拟页面（scripts/fixtures/mock-weread.js）驱动真实浏览器跑完整的 runOnce，
 * 覆盖扫码登录、二维码过期刷新、等待超时、cookies 损坏、选书、翻章、读完回到目录、白屏刷新等分支，
 * 并检查阅读循环的翻动节奏是否符合配置。不访问微信读书。
 *
 * 用法: SELENIUM_URL=http://localhost:4444 node scripts/reader-smoke.js
 *   READER_SMOKE_ONLY=<场景名> 只运行一个场景（login / timeout / corrupt / reading / single）。
 *   SELENIUM_URL 默认 http://localhost:4444，也可以直接指向 chromedriver（如 http://localhost:9515）。
 *   浏览器需要能访问本机的模拟服务；Selenium 跑在容器里时用 --network host 启动，
 *   或通过 MOCK_HOST 指定浏览器访问本机时使用的地址。
 */

const assert = require("assert");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

const { resolveConfig } = require(path.resolve(__dirname, "..", "src", "config", "resolve"));
const { runOnce } = require(path.resolve(__dirname, "..", "src", "reader", "run"));
const { startMockWeread } = require("./fixtures/mock-weread");

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

    await scenario("阅读：书架选书、翻到下一章、读完回到目录，翻动节奏符合配置", {
      name: "reading",
      site: { loggedIn: true, books: 3, chapters: 2, contentHeight: 1800 },
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
