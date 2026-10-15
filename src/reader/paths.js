const fs = require("fs");
const path = require("path");

function getDataPaths(config) {
  const dataDir = path.resolve(config.dataDir);
  return {
    dataDir,
    cookies: path.join(dataDir, "cookies.json"),
    loginQrCode: path.join(dataDir, "login.png"),
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
