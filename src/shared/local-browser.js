const { execFile } = require("child_process");
const fs = require("fs");
const path = require("path");

// 内置浏览器：Selenium 地址留空时，由阅读子进程在本机启动 chromedriver 与 Chromium（Docker 镜像中已安装）。
// 路径可用 CHROMEDRIVER_PATH / CHROME_BIN 指定，否则在 PATH 中查找
const BROWSER_NAMES = ["chromium-browser", "chromium", "google-chrome", "google-chrome-stable"];
const VERSION_TIMEOUT_MS = 5000;

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

function readVersion(file) {
  return new Promise((resolve, reject) => {
    execFile(file, ["--version"], { timeout: VERSION_TIMEOUT_MS }, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(String(stdout).trim().split("\n")[0]);
    });
  });
}

// 浏览器的主版本号，例如 "Chromium 155.0.8059.84 Alpine Linux" → 155；取不到时为 0
function majorVersion(versionText) {
  const match = /(\d+)\.\d+\.\d+\.\d+/.exec(versionText || "");
  return match ? Number(match[1]) : 0;
}

// 与 checkSelenium 的返回值格式一致：找不到 chromedriver 或浏览器时 state 为 unreachable 并附带原因
async function checkLocalBrowser(env = process.env) {
  const result = { state: "unreachable", ready: false, message: "", sessions: null, nodes: null, error: "" };
  const driver = chromedriverPath(env);
  const browser = browserPath(env);
  if (!driver || !browser) {
    result.error = `找不到 ${[!driver && "chromedriver", !browser && "Chromium"].filter(Boolean).join(" 与 ")}`;
    return result;
  }
  try {
    const versions = await Promise.all([readVersion(browser), readVersion(driver)]);
    return { ...result, state: "ready", ready: true, message: versions[0], error: "" };
  } catch (e) {
    result.error = `无法读取浏览器版本：${e.message}`;
    return result;
  }
}

module.exports = {
  browserPath,
  checkLocalBrowser,
  chromedriverPath,
  majorVersion,
  readVersion,
};
