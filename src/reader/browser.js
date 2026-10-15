const { Builder, Browser } = require("selenium-webdriver");
const chrome = require("selenium-webdriver/chrome");
const { fetchJson, isHttpUrl } = require("../shared/http");

function normalizeSeleniumUrl(url) {
  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    return "http://" + url;
  }
  return url;
}

async function checkSeleniumHealth(remoteUrl) {
  try {
    if (!remoteUrl || !isHttpUrl(remoteUrl)) {
      console.warn("跳过健康检查：SELENIUM_URL 未设置或非法。");
      return null;
    }
    // 优先 /status，兼容 /wd/hub/status
    const base = remoteUrl.endsWith("/") ? remoteUrl.slice(0, -1) : remoteUrl;
    const endpoints = ["/status", "/wd/hub/status"];
    for (const ep of endpoints) {
      try {
        const { statusCode, body } = await fetchJson(`${base}${ep}`, 3000);
        if (statusCode >= 200 && statusCode < 300) {
          const ready = body?.ready ?? body?.value?.ready;
          console.info(`Selenium 健康检查 ${ep} 响应: ready=${ready}`);
          return { endpoint: ep, ready, raw: body };
        }
      } catch (_) {
        // 继续尝试下一个端点
      }
    }
    console.warn("Selenium 健康检查失败：所有端点无有效响应。");
    return null;
  } catch (e) {
    console.warn("Selenium 健康检查异常：", e.message || e);
    return null;
  }
}

async function collectDiagnostics(config, reason) {
  try {
    console.warn("开始收集诊断信息，原因：", reason?.toString()?.slice(0, 180) || "未知");
    await checkSeleniumHealth(config.seleniumUrl);
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

  // 远端启动前做一次健康检查
  await checkSeleniumHealth(config.seleniumUrl);
  const remoteBrowserUrl = normalizeSeleniumUrl(config.seleniumUrl);
  console.info("SELENIUM_URL: ", remoteBrowserUrl);
  const driver = await new Builder()
    .usingServer(remoteBrowserUrl)
    .forBrowser(Browser.CHROME)
    .withCapabilities(capabilities)
    .setChromeOptions(options)
    .build();

  // 全局超时配置，避免单次命令长时间挂起
  await driver.manage().setTimeouts({
    implicit: 5000,
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
  checkSeleniumHealth,
  collectDiagnostics,
  createDriver,
};
