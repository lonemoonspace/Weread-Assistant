const fs = require("fs");
const path = require("path");

function getDataPaths(config) {
  const dataDir = path.resolve(config.dataDir);
  return {
    dataDir,
    cookies: path.join(dataDir, "cookies.json"),
    // 整页截图，便于排查二维码未出现等问题
    loginQrCode: path.join(dataDir, "login.png"),
    // 只含二维码的截图，作为邮件附件
    loginQrImage: path.join(dataDir, "login-qr.png"),
    outputLog: path.join(dataDir, "output.log"),
    screenshot: (fileName = "screenshot.png") => path.join(dataDir, fileName),
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
