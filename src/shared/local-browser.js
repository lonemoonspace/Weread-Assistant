const { execFile } = require("child_process");
const fs = require("fs");
const path = require("path");

// 内置浏览器：Selenium 地址留空时，由阅读子进程在本机启动 chromedriver 与 Chromium（Docker 镜像中已安装）。
// 路径可用 CHROMEDRIVER_PATH / CHROME_BIN 指定，否则在 PATH 中查找
const BROWSER_NAMES = ["chromium-browser", "chromium", "google-chrome", "google-chrome-stable"];
// 读取版本要启动一次浏览器：在树莓派、NAS 上长时间空闲后（文件缓存已被换出、硬盘休眠）首次启动
// 可能要十几秒，时限与启动 chromedriver 的一致
const VERSION_TIMEOUT_MS = 30000;

function findInPath(names, env = process.env) {
  const dirs = String(env.PATH || "").split(path.delimiter).filter(Boolean);
  for (const name of names) {
    for (const dir of dirs) {
      const file = path.join(dir, name);
      try {
        fs.accessSync(file, fs.constants.X_OK);
        if (fs.statSync(file).isFile()) {
          return file;
        }
      } catch (_) {
        // 继续查找
      }
    }
  }
  return "";
}

function chromedriverPath(env = process.env) {
  return env.CHROMEDRIVER_PATH || findInPath(["chromedriver"], env);
}

function browserPath(env = process.env) {
  return env.CHROME_BIN || findInPath(BROWSER_NAMES, env);
}

// 把 execFile 的错误写成可读的原因：只有 "Command failed: ..." 时看不出是超时、被结束还是出错退出
function describeVersionError(file, error, stderr, timeoutMs) {
  const command = `${file} --version`;
  if (error.code === "ENOENT" || error.code === "EACCES") {
    return `${command} 无法执行（${error.code}）`;
  }
  let reason;
  if (error.killed && error.signal === "SIGTERM") {
    reason = `${timeoutMs / 1000} 秒内没有输出版本，机器负载高或磁盘较慢时可能出现，可稍后刷新重试`;
  } else if (error.signal) {
    reason = `进程被信号 ${error.signal} 结束${error.signal === "SIGKILL" ? "，可能是内存不足" : ""}`;
  } else if (typeof error.code === "number") {
    reason = `退出码 ${error.code}`;
  } else {
    reason = error.message;
  }
  const detail = String(stderr || "").trim().split("\n")[0].slice(0, 200);
  return `${command} ${reason}${detail ? `：${detail}` : ""}`;
}

function readVersion(file, timeoutMs = VERSION_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    execFile(file, ["--version"], { timeout: timeoutMs }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(describeVersionError(file, error, stderr, timeoutMs)));
        return;
      }
      resolve(String(stdout).trim().split("\n")[0]);
    });
  });
}

// 文件没变时版本也不变：记下路径、大小与修改时间，面板据此复用上次读到的版本，不必每次刷新都启动浏览器
function fileStamp(file) {
  try {
    const real = fs.realpathSync(file);
    const stat = fs.statSync(real);
    return `${real}:${stat.size}:${stat.mtimeMs}`;
  } catch (_) {
    return "";
  }
}

// 浏览器的主版本号，例如 "Chromium 155.0.8059.84 Alpine Linux" → 155；取不到时为 0
function majorVersion(versionText) {
  const match = /(\d+)\.\d+\.\d+\.\d+/.exec(versionText || "");
  return match ? Number(match[1]) : 0;
}

// 与 checkSelenium 的返回值格式一致：找不到 chromedriver 或浏览器时 state 为 unreachable 并附带原因
// versionCache 可选：由 createLocalBrowserChecker 传入，按文件记下读到的版本
async function checkLocalBrowser(env = process.env, { timeoutMs = VERSION_TIMEOUT_MS, versionCache = null } = {}) {
  const result = { state: "unreachable", ready: false, message: "", sessions: null, nodes: null, error: "" };
  const driver = chromedriverPath(env);
  const browser = browserPath(env);
  if (!driver || !browser) {
    result.error = `找不到 ${[!driver && "chromedriver", !browser && "Chromium"].filter(Boolean).join(" 与 ")}`;
    return result;
  }
  const version = async (file) => {
    const stamp = versionCache && fileStamp(file);
    if (stamp && versionCache.get(file)?.stamp === stamp) {
      return versionCache.get(file).version;
    }
    const text = await readVersion(file, timeoutMs);
    if (stamp) {
      versionCache.set(file, { stamp, version: text });
    }
    return text;
  };
  let versions;
  try {
    versions = await Promise.all([version(browser), version(driver)]);
  } catch (e) {
    result.error = `无法读取浏览器版本：${e.message}`;
    return result;
  }
  // chromedriver 只能驱动同一主版本的浏览器，不一致时要到启动浏览器才会失败，这里提前报出
  const [browserMajor, driverMajor] = versions.map(majorVersion);
  if (browserMajor !== driverMajor) {
    result.error = `chromedriver 与 Chromium 的主版本不一致（chromedriver ${driverMajor || "未知"}，Chromium ${browserMajor || "未知"}）`;
    return result;
  }
  return { ...result, state: "ready", ready: true, message: versions[0], error: "" };
}

// 同时只检查一次：多个页面同时刷新时共用结果。读到的版本按文件缓存，浏览器没有更新时不再重复启动它
function createLocalBrowserChecker(env = process.env, options = {}) {
  let pending = null;
  const versionCache = new Map();
  return () => {
    if (!pending) {
      pending = checkLocalBrowser(env, { ...options, versionCache }).finally(() => {
        pending = null;
      });
    }
    return pending;
  };
}

module.exports = {
  browserPath,
  checkLocalBrowser,
  chromedriverPath,
  createLocalBrowserChecker,
  majorVersion,
  readVersion,
};
