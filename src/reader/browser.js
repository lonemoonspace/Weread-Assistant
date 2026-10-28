const { Builder, Browser } = require("selenium-webdriver");
const chrome = require("selenium-webdriver/chrome");
const {
  CONNECTION_ERRORS,
  checkSelenium,
  describeSeleniumStatus,
  displaySeleniumUrl,
  normalizeSeleniumUrl,
} = require("../shared/selenium");
const { browserPath, checkLocalBrowser, chromedriverPath, majorVersion } = require("../shared/local-browser");

// chromedriver 开始监听端口的时限。selenium-webdriver 默认 30 秒，这里写明：树莓派负载高时启动较慢
const LOCAL_DRIVER_START_TIMEOUT_MS = 30000;

// 把 Selenium 的状态与会话数写入运行日志，连接浏览器前与出错时各查询一次；使用内置浏览器时记录其版本
async function logSeleniumStatus(seleniumUrl) {
  if (!seleniumUrl) {
    const status = await checkLocalBrowser();
    const text = `内置浏览器：${status.ready ? status.message : status.error}`;
    if (status.ready) {
      console.info(text);
    } else {
      console.warn(text);
    }
    return status;
  }
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

// 在本机启动 chromedriver 并以无界面模式运行 Chromium；关闭浏览器时一并结束 chromedriver。
// status 为连接前 checkLocalBrowser 的结果：找不到、无法运行或版本不一致时直接报错，不启动
async function createLocalDriver(capabilities, options, status) {
  if (!status.ready) {
    throw new Error(
      `内置浏览器不可用：${status.error}。请使用 Docker 镜像部署；不使用镜像时安装 Chromium 与同一版本的 chromedriver，或在设置中填写 Selenium 地址`
    );
  }
  const driverPath = chromedriverPath();
  options.setChromeBinaryPath(browserPath());
  options.addArguments("--headless=new");
  // 无界面模式的 UA 带有 HeadlessChrome，改为与有界面时相同
  const major = majorVersion(status.message);
  if (major) {
    const platform = process.arch === "arm64" ? "aarch64" : "x86_64";
    options.addArguments(
      `--user-agent=Mozilla/5.0 (X11; Linux ${platform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`
    );
  }

  const service = new chrome.ServiceBuilder(driverPath).build();
  let serverUrl;
  try {
    serverUrl = await service.start(LOCAL_DRIVER_START_TIMEOUT_MS);
  } catch (e) {
    await service.kill();
    throw new Error(`无法启动 chromedriver（${driverPath}）：${e.message}`);
  }
  console.info("chromedriver: ", serverUrl);
  let driver;
  try {
    driver = await new Builder().usingServer(serverUrl).withCapabilities(capabilities).setChromeOptions(options).build();
  } catch (e) {
    await service.kill();
    throw e;
  }
  const quit = driver.quit.bind(driver);
  driver.quit = () => quit().finally(() => service.kill());
  return driver;
}

async function connectRemoteDriver(config, capabilities, options) {
  const remoteBrowserUrl = normalizeSeleniumUrl(config.seleniumUrl);
  const shownUrl = displaySeleniumUrl(remoteBrowserUrl);
  console.info("SELENIUM_URL: ", shownUrl);
  try {
    return await new Builder()
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
  const status = await logSeleniumStatus(config.seleniumUrl);
  const driver = config.seleniumUrl
    ? await connectRemoteDriver(config, capabilities, options)
    : await createLocalDriver(capabilities, options, status);

  // 连接后的设置失败时关闭浏览器，避免留下会话（内置浏览器时还有 chromedriver 与浏览器进程）
  try {
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
  } catch (e) {
    await driver.quit().catch(() => {});
    throw e;
  }

  return driver;
}

module.exports = {
  collectDiagnostics,
  createDriver,
};
