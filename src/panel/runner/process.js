const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { normalizeSeleniumUrl } = require("../../shared/selenium");

const WORKER_PATH = path.resolve(__dirname, "..", "..", "reader", "worker.js");
// 停止时先发 SIGTERM，子进程在这段时间内没有退出就强制结束
const KILL_TIMEOUT_MS = 15000;
// 子进程上报结果后应很快退出（关闭浏览器、发送通知）；超过这段时间仍未退出就结束它
const EXIT_AFTER_RESULT_MS = 3 * 60000;
// 运行时长上限 = 等待扫码时长 + 阅读时长 + 余量；Selenium 卡住时防止一直占用并发槽位
const RUN_TIMEOUT_MARGIN_MS = 30 * 60000;
const SESSION_DELETE_TIMEOUT_MS = 5000;

// 子进程只继承运行 Node 与联网所需的环境变量（白名单，另加 LC_*）。运行配置与密钥经 IPC 下发，
// 面板所在环境中的 PANEL_PASSWORD、BARK_KEY、EMAIL_PASS 等变量都不会传给子进程
const CHILD_ENV_KEYS = new Set([
  "PATH",
  "HOME",
  "USER",
  "TZ",
  "TMPDIR",
  "LANG",
  "LANGUAGE",
  "NODE_OPTIONS",
  "NODE_EXTRA_CA_CERTS",
  "NODE_USE_ENV_PROXY",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  // 内置浏览器的路径
  "CHROME_BIN",
  "CHROMEDRIVER_PATH",
]);

// extra 覆盖白名单中的变量，例如每次运行单独的 TMPDIR
function childEnv(extra = {}) {
  return {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => CHILD_ENV_KEYS.has(key) || key.startsWith("LC_"))),
    ...extra,
  };
}

// 每次运行在系统临时目录下单独建一个目录，经 TMPDIR 交给子进程（chromedriver 与浏览器的临时文件都写在这里），
// 子进程退出后删除；运行被强制结束时也不会在容器里留下临时文件（B10）。目录名带上数据目录的摘要，
// 同一台机器上的多个面板只清理自己的
function runTempPrefix(panelDataDir) {
  const digest = crypto.createHash("sha256").update(path.resolve(panelDataDir)).digest("hex").slice(0, 8);
  return `weread-run-${digest}-`;
}

function createRunTempDir(panelDataDir) {
  return fs.mkdtempSync(path.join(os.tmpdir(), runTempPrefix(panelDataDir)));
}

function removeRunTempDir(dir) {
  if (!dir) {
    return;
  }
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (e) {
    console.warn("删除运行的临时目录失败:", dir, e.message);
  }
}

// 面板启动时删除上次留下的运行临时目录（面板崩溃时来不及删除）
function cleanupRunTempDirs(panelDataDir) {
  const prefix = runTempPrefix(panelDataDir);
  let removed = 0;
  let names;
  try {
    names = fs.readdirSync(os.tmpdir());
  } catch (_) {
    return 0;
  }
  for (const name of names) {
    if (name.startsWith(prefix)) {
      removeRunTempDir(path.join(os.tmpdir(), name));
      removed += 1;
    }
  }
  if (removed > 0) {
    console.info(`删除了上次遗留的 ${removed} 个运行临时目录`);
  }
  return removed;
}

// fetch 不接受带用户名与密码的地址：从地址中取出，改用 Authorization 请求头（与连接浏览器时一致）
async function deleteSeleniumSession(seleniumUrl, sessionId) {
  const url = new URL(`${normalizeSeleniumUrl(seleniumUrl)}/session/${encodeURIComponent(sessionId)}`);
  const headers = {};
  if (url.username || url.password) {
    const credentials = `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`;
    headers.Authorization = `Basic ${Buffer.from(credentials).toString("base64")}`;
    url.username = "";
    url.password = "";
  }
  const res = await fetch(url, { method: "DELETE", headers, signal: AbortSignal.timeout(SESSION_DELETE_TIMEOUT_MS) });
  return res.status;
}

function killProcessGroup(child) {
  if (!child || !child.pid) {
    return;
  }
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch (_) {
    // 组内已没有进程
  }
}

module.exports = {
  cleanupRunTempDirs,
  createRunTempDir,
  removeRunTempDir,
  runTempPrefix,
  CHILD_ENV_KEYS,
  EXIT_AFTER_RESULT_MS,
  KILL_TIMEOUT_MS,
  RUN_TIMEOUT_MARGIN_MS,
  WORKER_PATH,
  childEnv,
  deleteSeleniumSession,
  killProcessGroup,
};
