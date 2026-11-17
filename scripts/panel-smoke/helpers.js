// 面板 smoke 的公用部分：临时目录、面板参数、HTTP 客户端、等待条件、读取运行文件、实时推送，以及各组场景共用的启动与登录函数
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { startPanel } = require(path.resolve(__dirname, "..", "..", "src", "panel", "server"));
const { createSoftAuthenticator } = require("../fixtures/soft-authenticator");

const CSRF = { "X-WA-Request": "1" };
// passkey 场景使用的外网地址：RP ID 为 example.com，origin 为 https://example.com
const PASSKEY_URL = "https://example.com/weread/";
const PASSKEY_RP = { rpId: "example.com", origin: "https://example.com" };
const STUB_WORKER = path.resolve(__dirname, "..", "fixtures", "stub-worker.js");

const tempDirs = [];

function tempDir(base = os.tmpdir()) {
  fs.mkdirSync(base, { recursive: true });
  const dir = fs.mkdtempSync(path.join(base, "panel-smoke-"));
  tempDirs.push(dir);
  return dir;
}

function panelOptions(overrides = {}) {
  return {
    port: 0,
    host: "127.0.0.1",
    basePath: "/",
    trustProxy: false,
    publicUrl: "",
    password: "",
    dataDir: tempDir(),
    seleniumUrl: "",
    runner: { workerPath: STUB_WORKER, killTimeoutMs: 500 },
    sseHeartbeatMs: 100,
    // 测试中不访问真实的微信读书接口：默认指向本机不存在的端口，需要时由场景换成 mock-official.js
    officialApi: { gatewayUrl: "http://127.0.0.1:9/api/agent/gateway", retryDelayMs: 1 },
    ...overrides,
  };
}

async function until(check, { timeoutMs = 10000, message = "等待条件成立超时" } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error(message);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

// 等待满足条件的运行状态推送；需在触发运行之前调用
function nextRun(panel, predicate, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error("等待运行状态超时"));
    }, timeoutMs);
    const unsubscribe = panel.runner.subscribe((type, run) => {
      if (type === "run" && predicate(run)) {
        clearTimeout(timer);
        unsubscribe();
        resolve(run);
      }
    });
  });
}

const ended = (accountId) => (run) => run.accountId === accountId && Boolean(run.endedAt);

function runFiles(panel, accountId, runId) {
  const dir = path.join(panel.options.dataDir, "runs", accountId, runId);
  return {
    dir,
    meta: () => JSON.parse(fs.readFileSync(path.join(dir, "meta.json"), "utf8")),
    // 运行结束后日志可能还在写入，等到最后一行出现再读取
    log: async () => {
      const file = path.join(dir, "output.log");
      await until(() => fs.existsSync(file) && fs.readFileSync(file, "utf8").includes("运行结束"));
      return fs.readFileSync(file, "utf8");
    },
  };
}

// 连接实时推送接口，持续解析收到的事件
async function openEvents(port, cookie) {
  const controller = new AbortController();
  const res = await fetch(`http://127.0.0.1:${port}/api/events`, { headers: { Cookie: cookie }, signal: controller.signal });
  const events = [];
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const closed = (async () => {
    let buffer = "";
    for (;;) {
      let chunk;
      try {
        chunk = await reader.read();
      } catch (_) {
        return;
      }
      if (chunk.done) {
        return;
      }
      buffer += decoder.decode(chunk.value, { stream: true });
      let index;
      while ((index = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        const event = { event: "", data: null, comment: false };
        for (const line of block.split("\n")) {
          if (line.startsWith(":")) {
            event.comment = true;
          } else if (line.startsWith("event: ")) {
            event.event = line.slice(7);
          } else if (line.startsWith("data: ")) {
            event.data = JSON.parse(line.slice(6));
          }
        }
        events.push(event);
      }
    }
  })();
  return { status: res.status, headers: res.headers, events, closed, close: () => controller.abort() };
}

// 简单的 HTTP 客户端：不跟随重定向，返回状态、响应头与解析后的 JSON
function client(port, basePath = "/") {
  return async function request(urlPath, { method = "GET", body, headers = {}, cookie } = {}) {
    const init = { method, redirect: "manual", headers: { ...headers } };
    if (cookie) {
      init.headers.Cookie = cookie;
    }
    if (body !== undefined) {
      init.headers["Content-Type"] = init.headers["Content-Type"] || "application/json";
      init.body = typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body);
    }
    const url = urlPath.startsWith("/") ? urlPath : `${basePath}${urlPath}`;
    const res = await fetch(`http://127.0.0.1:${port}${url}`, init);
    const bytes = Buffer.from(await res.arrayBuffer());
    const text = bytes.toString("utf8");
    let json = null;
    try {
      json = JSON.parse(text);
    } catch (_) {}
    return { status: res.status, headers: res.headers, text, json, bytes };
  };
}

function sessionCookie(res) {
  const header = res.headers.get("set-cookie") || "";
  const match = header.match(/wa_session=([^;]*)/);
  return match && match[1] ? `wa_session=${match[1]}` : "";
}

async function withQuietConsole(fn) {
  const original = { info: console.info, warn: console.warn, error: console.error, log: console.log };
  const logs = [];
  const capture = (...args) => logs.push(args.map(String).join(" "));
  Object.assign(console, { info: capture, warn: capture, error: capture, log: capture });
  try {
    return await fn(logs);
  } catch (error) {
    error.capturedLogs = logs;
    throw error;
  } finally {
    Object.assign(console, original);
  }
}

// 一次 smoke 共用的状态：启动过的面板在 close 时统一关闭，临时目录统一删除
function createSuite() {
  const results = [];
  const panels = [];
  const start = async (overrides) => {
    const options = panelOptions(overrides);
    const panel = await startPanel(options);
    panels.push(panel);
    return { ...panel, options, request: client(panel.port, options.basePath) };
  };
  const login = async (panel, password, headers = {}) =>
    panel.request("api/auth/login", { method: "POST", body: { password }, headers: { ...CSRF, ...headers } });
  // 启动带固定密码的面板并登录，返回绑定了会话的接口调用函数
  const startAuthed = async (overrides = {}) => {
    const panel = await start({ password: "correct-horse", ...overrides });
    const cookie = sessionCookie(await login(panel, "correct-horse"));
    const call = (method, urlPath, body) =>
      panel.request(urlPath, {
        method,
        cookie,
        body: method === "GET" ? undefined : body || {},
        headers: method === "GET" ? {} : CSRF,
      });
    return { ...panel, cookie, call };
  };

  // 已登录的面板添加一个软件认证器的 passkey，返回该认证器
  const addPasskey = async (panel, name = "测试设备", authenticator = createSoftAuthenticator(PASSKEY_RP)) => {
    const options = await panel.call("POST", "api/auth/passkeys/options");
    assert.strictEqual(options.status, 200, JSON.stringify(options.json));
    const added = await panel.call("POST", "api/auth/passkeys", { name, response: authenticator.register(options.json) });
    assert.strictEqual(added.status, 201, JSON.stringify(added.json));
    return authenticator;
  };
  // 未登录申请 passkey 登录参数并用 authenticator 登录；tamper 篡改认证器的结果
  const passkeyLogin = async (panel, authenticator, tamper = {}) => {
    const options = await panel.request("api/auth/passkey/options", { method: "POST", body: { purpose: "login" }, headers: CSRF });
    assert.strictEqual(options.status, 200, JSON.stringify(options.json));
    return panel.request("api/auth/passkey/login", {
      method: "POST",
      body: { response: authenticator.assert(options.json, tamper) },
      headers: CSRF,
    });
  };
  // 用某个会话 cookie 调用接口
  const callAs = (panel, cookie, method, urlPath, body) =>
    panel.request(urlPath, { method, cookie, body: method === "GET" ? undefined : body || {}, headers: method === "GET" ? {} : CSRF });

  const scenario = async (name, fn) => {
    await withQuietConsole(fn);
    results.push(name);
    console.log(`✅ ${name}`);
  };

  const close = async () => {
    await Promise.all(panels.map((panel) => panel.close()));
    for (const dir of tempDirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };

  return { results, scenario, start, login, startAuthed, addPasskey, passkeyLogin, callAs, close };
}

module.exports = {
  CSRF,
  PASSKEY_RP,
  PASSKEY_URL,
  STUB_WORKER,
  client,
  createSuite,
  ended,
  nextRun,
  openEvents,
  panelOptions,
  runFiles,
  sessionCookie,
  tempDir,
  until,
  withQuietConsole,
};
