const fs = require("fs");
const path = require("path");

// screenshotDir：阅读截图的保存目录，由面板运行时为运行目录，默认为账号数据目录
function getDataPaths(config, { screenshotDir } = {}) {
  const dataDir = path.resolve(config.dataDir);
  const shotsDir = screenshotDir ? path.resolve(screenshotDir) : dataDir;
  return {
    dataDir,
    cookies: path.join(dataDir, "cookies.json"),
    // 整页截图，便于排查二维码未出现等问题
    loginQrCode: path.join(dataDir, "login.png"),
    // 只含二维码的截图，作为邮件附件
    loginQrImage: path.join(dataDir, "login-qr.png"),
    outputLog: path.join(dataDir, "output.log"),
    screenshot: (fileName = "screenshot.png") => path.join(shotsDir, fileName),
  };
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

module.exports = {
  ensureDir,
  getDataPaths,
};
