const fs = require("fs");
const { createNotifier } = require("../notify");
const { collectDiagnostics, createDriver } = require("./browser");
const { login, saveCookies } = require("./login");
const { getDataPaths } = require("./paths");
const { openBook, readLoop } = require("./reading");

async function saveScreenshot(driver, filePath) {
  await driver
    .takeScreenshot()
    .then((image) => fs.writeFileSync(filePath, image, "base64"));
}

// 执行一次完整的自动阅读：连接浏览器、登录、选书、按时长阅读，并在各阶段发送通知
async function runOnce(config) {
  const paths = getDataPaths(config);
  const notifier = createNotifier(config);
  const ctx = { config, paths, notifier };

  console.info("Starting the script, datetime: ", new Date());
  let driver;

  // 发送脚本启动通知
  await notifier.notify("微信读书挑战", "自动阅读脚本开始运行", {
    subtitle: "脚本启动",
    level: "active",
    sound: "beginning"
  });
  try {
    driver = await createDriver(config);

    const loggedIn = await login(driver, ctx);
    if (!loggedIn) {
      console.error("Failed to login.");
      if (config.emailEnabled) {
        const loginFailureAttachments = fs.existsSync(paths.loginQrCode)
          ? [paths.loginQrCode]
          : [];
        await notifier.sendMail(
          "[项目进展--项目停滞]",
          "Failed to login.",
          loginFailureAttachments,
          {
            extraHtml: loginFailureAttachments.length
              ? `
            <div style="background: #fff7e6; border-left: 4px solid #fa8c16; padding: 15px; margin: 20px 0;">
                <p style="margin: 0;">The current login QR code is attached below. Scan it to complete login.</p>
            </div>
          `
              : "",
          }
        );
      }
      await notifier.notify("微信读书挑战", "登录失败", {
        subtitle: "项目停滞",
        level: "critical",
        sound: "alarm"
      });
      return;
    }

    console.info("Successfully logged in.");

    await saveCookies(driver, paths.cookies);

    await openBook(driver, ctx);

    if (config.emailEnabled) {
      await saveScreenshot(driver, paths.screenshot());
      await notifier.sendMail("[项目进展--项目启动]", "Login successful.", [
        paths.screenshot(),
      ]);
    }
    await notifier.notify("微信读书挑战", "登录成功", {
      subtitle: "项目启动",
      level: "active",
      sound: "birdsong"
    });

    await readLoop(driver, ctx);

    // save cookies after reading
    await saveCookies(driver, paths.cookies);
    if (config.emailEnabled) {
      await saveScreenshot(driver, paths.screenshot());
      await notifier.sendMail("[项目进展--项目完成]", "Reading completed.", [
        paths.screenshot(),
      ]);
    }
    await notifier.notify("微信读书挑战", `阅读完成，持续时间：${config.duration}分钟`, {
      subtitle: "项目完成",
      level: "active",
      sound: "success"
    });
  } catch (e) {
    const errorMessage = String(e?.message || e || "Unknown error");
    console.info(errorMessage);
    // 出错时检查 Selenium 健康状态
    await collectDiagnostics(config, errorMessage);
    if (config.emailEnabled) {
      await notifier.sendMail("[项目进展--项目停滞]", "Error occurred: " + errorMessage);
    }
    await notifier.notify("微信读书挑战", `发生错误：${errorMessage.substring(0, 100)}${errorMessage.length > 100 ? '...' : ''}`, {
      subtitle: "项目停滞",
      level: "critical",
      sound: "alarm"
    });

    // wait for 3 seconds before closing the browser
    await new Promise((resolve) => setTimeout(resolve, 3000));
  } finally {
    console.info("Quitting the browser...");
    if (driver) {
      await driver.quit();
      console.info("Browser closed.");
    }
  }
}

module.exports = {
  runOnce,
};
