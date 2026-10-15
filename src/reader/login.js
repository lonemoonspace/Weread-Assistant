const fs = require("fs");
const assert = require("assert");
const { By, until } = require("selenium-webdriver");
const { ensureDir } = require("./paths");

const WEREAD_URL = "https://weread.qq.com/";
const QR_EXPIRED_TEXTS = ["点击刷新二维码", "二维码已失效"]; // 登录二维码过期提示

async function saveCookies(driver, filePath) {
  const cookies = await driver.manage().getCookies();
  fs.writeFileSync(filePath, JSON.stringify(cookies, null, 2));
  console.info("Cookies saved successfully.");
}

async function loadCookies(driver, filePath) {
  if (!fs.existsSync(filePath)) {
    console.warn("No cookies file found.");
    return;
  }

  const cookies = JSON.parse(fs.readFileSync(filePath, "utf8"));
  for (const cookie of cookies) {
    await driver.manage().addCookie(cookie);
  }
  console.info("Cookies loaded successfully.");
}

// 简化的二维码定位函数
async function findQRCodeElement(driver) {
  try {
    console.info("正在查找二维码登录元素...");
    // 使用更精确的定位策略，优先查找二维码图片
    await driver.wait(
      until.elementLocated(
        By.xpath("//img[contains(@class, 'qr') or contains(@src, 'qr') or contains(@alt, '二维码')]")
      ),
      3000
    );
    console.info("找到二维码图片元素");
    return true;
  } catch (e) {
    try {
      // 备选方案：查找包含"扫码"或"二维码"文本的元素
      await driver.wait(
        until.elementLocated(
          By.xpath("//*[contains(text(), '扫码') or contains(text(), '二维码')]")
        ),
        3000
      );
      console.info("找到包含'扫码'或'二维码'文本的元素");
      return true;
    } catch (e) {
      console.info("未找到二维码相关元素，可能已经登录");
      return false;
    }
  }
}

// 从页面二维码图片中解码登录链接并在终端显示为二维码
async function extractAndDisplayQRCode(driver, notifier) {
  try {
    const qrImg = await driver.findElement(
      By.xpath("//img[contains(@class, 'qr') or contains(@src, 'qr') or contains(@alt, '二维码')]")
    );

    const base64Png = await qrImg.takeScreenshot();

    const { PNG } = require("pngjs");
    const png = PNG.sync.read(Buffer.from(base64Png, "base64"));

    const jsQR = require("jsqr");
    const code = jsQR(new Uint8ClampedArray(png.data), png.width, png.height);

    if (code && code.data) {
      console.info("登录链接:", code.data);
      const qrcode = require("qrcode-terminal");
      qrcode.generate(code.data, { small: true });
      await notifier.loginLink(code.data);
      return code.data;
    }
    console.warn("无法从二维码图片中解析登录链接");
    return null;
  } catch (e) {
    console.warn("提取二维码登录链接失败:", e.message);
    return null;
  }
}

// 截取整页保存为登录二维码图片
async function captureLoginQrCode(driver, ctx) {
  await driver.takeScreenshot().then((image) => {
    fs.writeFileSync(ctx.paths.loginQrCode, image, "base64");
  });
}

// 安全点击元素函数，处理元素被拦截的情况
async function safeClickElement(driver, element, description = "元素") {
  try {
    // 首先检查元素是否可见和可点击
    const isDisplayed = await element.isDisplayed();
    if (!isDisplayed) {
      console.warn(`${description}不可见，尝试滚动到元素位置`);
      await driver.executeScript("arguments[0].scrollIntoView({block: 'center'});", element);
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    // 尝试直接点击
    await element.click();
    console.info(`成功点击${description}`);
    return true;
  } catch (error) {
    console.warn(`直接点击${description}失败: ${error.message}`);

    try {
      // 尝试使用JavaScript点击
      console.info(`尝试使用JavaScript点击${description}`);
      await driver.executeScript("arguments[0].click();", element);
      console.info(`使用JavaScript成功点击${description}`);
      return true;
    } catch (jsError) {
      console.warn(`使用JavaScript点击${description}失败: ${jsError.message}`);

      try {
        // 尝试使用Actions类模拟点击
        console.info(`尝试使用Actions类点击${description}`);
        const actions = driver.actions({ bridge: true });
        await actions.move({ origin: element }).click().perform();
        console.info(`使用Actions类成功点击${description}`);
        return true;
      } catch (actionError) {
        console.error(`所有点击方法都失败: ${actionError.message}`);
        return false;
      }
    }
  }
}

// 刷新二维码的函数
async function refreshQRCode(driver, ctx) {
  try {
    console.info("开始刷新二维码...");

    // 尝试多种方式找到刷新按钮
    const refreshLocators = [
      By.css(".login_dialog_retry_delegate"),
      By.xpath("//div[contains(@class, 'login_dialog_retry_delegate')]"),
      By.xpath("//div[contains(text(), '点击刷新二维码') and @class='wr_login_modal_qr_overlay_text']"),
      By.xpath("//div[contains(text(), '点击刷新二维码')]"),
      By.xpath("//div[@class='login_dialog_retry_delegate']"),
      By.xpath("//div[contains(@class, 'refresh') or contains(@class, 'retry')]"),
      By.xpath("//button[contains(text(), '刷新')]"),
      By.xpath("//span[contains(text(), '刷新')]")
    ];

    let refreshClicked = false;
    let refreshElement = null;

    // 尝试每个定位器
    for (const locator of refreshLocators) {
      try {
        refreshElement = await driver.wait(until.elementLocated(locator), 2000);
        if (refreshElement) {
          console.info(`找到刷新元素，尝试点击: ${locator.toString()}`);
          refreshClicked = await safeClickElement(driver, refreshElement, "刷新按钮");
          if (refreshClicked) {
            try {
              await driver.wait(until.stalenessOf(refreshElement), 3000);
            } catch (waitError) {
              console.debug(`刷新元素可能未及时从DOM移除: ${waitError.message}`);
            }
            break;
          }
        }
      } catch (e) {
        console.debug(`未找到元素: ${locator.toString()}`);
      }
    }

    if (!refreshClicked) {
      console.warn("常规定位失败，尝试执行脚本触发刷新");
      try {
        const jsClicked = await driver.executeScript(
          "const delegate = document.querySelector('.login_dialog_retry_delegate'); if (delegate) { delegate.click(); return true; } return false;"
        );
        if (!jsClicked) {
          console.error("无法找到或点击任何刷新按钮");
          return false;
        }
        refreshClicked = true;
      } catch (scriptError) {
        console.error(`执行脚本触发刷新失败: ${scriptError.message}`);
        return false;
      }
    }

    // 等待页面加载
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // 检查二维码是否已刷新
    let qrElementFound = await findQRCodeElement(driver);

    if (qrElementFound) {
      // 避免截图时二维码还未弹出
      await new Promise((resolve) => setTimeout(resolve, 1000));
      await captureLoginQrCode(driver, ctx);
      console.info("QR code refreshed, datetime: ", new Date());
      await extractAndDisplayQRCode(driver, ctx.notifier);
      return true;
    } else {
      console.error("刷新后未能找到任何二维码相关元素");
      return false;
    }
  } catch (error) {
    console.error("刷新二维码过程中发生错误:", error.message);
    return false;
  }
}

// 打开首页、加载 cookies，需要时展示二维码并等待扫码登录；返回是否登录成功
async function login(driver, ctx) {
  const { paths } = ctx;

  await driver.get(WEREAD_URL);

  if (fs.existsSync(paths.cookies)) {
    await loadCookies(driver, paths.cookies);
    await driver.navigate().refresh(); // Refresh to apply cookies
  }

  console.info("Going to the URL:", WEREAD_URL);

  let title = await driver.getTitle();
  assert.equal("微信读书", title);
  console.info("Successfully opened the url:", WEREAD_URL);

  ensureDir(paths.dataDir);

  // Check if "Login" hyperlink exists
  console.info("Find login links...");
  let loginLinks = await driver.findElements(
    By.xpath("//a[contains(text(), '登录')]"),
    10000
  );
  if (loginLinks.length > 0) {
    console.info("Login link found. Clicking...");
    // 避免点击不成功
    await new Promise((resolve) => setTimeout(resolve, 1000));
    await loginLinks[0].click();

    // 等待页面加载
    await new Promise((resolve) => setTimeout(resolve, 2000));

    let qrElementFound = await findQRCodeElement(driver);

    if (qrElementFound) {
      // 避免截图时二维码还未弹出
      await new Promise((resolve) => setTimeout(resolve, 1000));
      await captureLoginQrCode(driver, ctx);
      console.info("QR code saved, datetime: ", new Date());
      await extractAndDisplayQRCode(driver, ctx.notifier);
    } else {
      console.error("未能找到任何二维码相关元素");
    }
  }

  let locator1 = By.xpath(
    "//div[contains(text(), '点击刷新二维码') and @class='wr_login_modal_qr_overlay_text']"
  );
  let locator2 = By.xpath(
    "//div[contains(text(), '我的书架') and @class='wr_index_page_top_section_header_action_link']"
  );

  let loggedIn = false;
  let maxRetries = 3;
  while (maxRetries-- > 0) {
    console.info("Waiting for login...");
    const element = await driver.wait(
      new Promise((resolve, reject) => {
        driver
          .wait(until.elementLocated(locator1), 300000)
          .then(resolve)
          .catch(() => { });
        driver
          .wait(until.elementLocated(locator2), 300000)
          .then(resolve)
          .catch(() => { });
      }),
      300000 // 5 minutes
    );

    if (element === undefined) {
      console.info("no element found");
      continue;
    }

    let text = await element.getText();
    // if text contains "我的书架", then login is successful
    if (text.includes("我的书架")) {
      console.info("Login completed.");
      loggedIn = true;
      break;
    }

    // 如果出现二维码过期提示，则自动刷新
    if (QR_EXPIRED_TEXTS.some((expiredText) => text.includes(expiredText))) {
      console.info("Refreshing QR code...");
      let refreshSuccess = await refreshQRCode(driver, ctx);

      if (!refreshSuccess) {
        console.error("二维码刷新失败，尝试其他方法...");
        // 如果刷新失败，尝试直接刷新页面
        await driver.navigate().refresh();
        await new Promise((resolve) => setTimeout(resolve, 3000));

        // 再次检查二维码
        let qrElementFound = await findQRCodeElement(driver);
        if (qrElementFound) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
          await captureLoginQrCode(driver, ctx);
          console.info("页面刷新后找到二维码, datetime: ", new Date());
          await extractAndDisplayQRCode(driver, ctx.notifier);
        }
      }
      continue;
    }
  }

  // 重试次数用完仍未看到“我的书架”时 loggedIn 保持 false
  return loggedIn;
}

module.exports = {
  login,
  saveCookies,
};
