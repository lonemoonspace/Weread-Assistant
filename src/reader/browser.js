const { Builder, Browser } = require("selenium-webdriver");
const chrome = require("selenium-webdriver/chrome");
const {
  CONNECTION_ERRORS,
  checkSelenium,
  describeSeleniumStatus,
  displaySeleniumUrl,
  normalizeSeleniumUrl,
} = require("../shared/selenium");

// 把 Selenium 的状态与会话数写入运行日志，连接浏览器前与出错时各查询一次
async function logSeleniumStatus(seleniumUrl) {
  const status = await checkSelenium(seleniumUrl);
  const text = `Selenium 状态（${displaySeleniumUrl(normalizeSeleniumUrl(seleniumUrl))}）：${describeSeleniumStatus(status)}`;
  if (status.state === "ready") {
    console.info(text);
  } else {
    console.warn(text);
  }
  return status;
}

async function collectDiagnostics(config, reason) {
  try {
    console.warn("开始收集诊断信息，原因：", reason?.toString()?.slice(0, 180) || "未知");
    await logSeleniumStatus(config.seleniumUrl);
  } catch (_) {
    // 忽略诊断过程错误
  }
}

async function createDriver(config) {
  const capabilities = {
    browserName: Browser.CHROME,
    pageLoadStrategy: "eager",
  };

  const options = new chrome.Options();
  options.addArguments("--no-sandbox");
  options.addArguments("--disable-gpu");
  options.addArguments("--disable-dev-shm-usage");
  options.addArguments("--profile-directory=" + config.profileName);
  options.addArguments("--disable-infobars");
  options.addArguments("--disable-extensions");
  options.addArguments("--disable-notifications");
  options.addArguments("--disable-popup-blocking");

  // 连接前查询一次 Selenium 状态；地址中可能带有用户名与密码，日志中只显示去掉它们的地址
  await logSeleniumStatus(config.seleniumUrl);
  const remoteBrowserUrl = normalizeSeleniumUrl(config.seleniumUrl);
  const shownUrl = displaySeleniumUrl(remoteBrowserUrl);
  console.info("SELENIUM_URL: ", shownUrl);
  let driver;
  try {
    driver = await new Builder()
      .usingServer(remoteBrowserUrl)
      .forBrowser(Browser.CHROME)
      .withCapabilities(capabilities)
      .setChromeOptions(options)
      .build();
  } catch (e) {
    const code = e.code || String(e.message || "").split(" ")[0];
    if (CONNECTION_ERRORS[code]) {
      throw new Error(`无法连接 Selenium（${shownUrl}）：${CONNECTION_ERRORS[code]}（${code}），请确认 Selenium 正在运行、地址正确`);
    }
    throw e;
  }

  // 全局超时配置，避免单次命令长时间挂起。
  // 隐式等待设为 0：元素不存在时立即返回，需要等待的地方使用显式等待
  await driver.manage().setTimeouts({
    implicit: 0,
    pageLoad: 60000,
    script: 30000,
  });

  console.info("Browser launched successfully.");

  // 随机窗口尺寸
  const randomWidth = Math.floor(Math.random() * 1000) + 800;
  const randomHeight = Math.floor(Math.random() * 800) + 700;
  await driver
    .manage()
    .window()
    .setRect({ width: randomWidth, height: randomHeight });

  return driver;
}

module.exports = {
  collectDiagnostics,
  createDriver,
};
