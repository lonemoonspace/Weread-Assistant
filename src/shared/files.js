const fs = require("fs");
const path = require("path");

// 先写临时文件再重命名，进程中途被杀时不会留下写了一半的文件；重命名前后分别把文件与目录刷到磁盘，
// 断电后不会出现空文件（树莓派的 SD 卡上常见）。options.mode 设置新文件的权限，例如保存密钥的文件用 0o600
function writeFileAtomic(filePath, content, options = {}) {
  const tmpPath = `${filePath}.${process.pid}.tmp`;
  const fd = fs.openSync(tmpPath, "w", options.mode);
  try {
    fs.writeFileSync(fd, content);
    if (options.mode !== undefined) {
      fs.fchmodSync(fd, options.mode);
    }
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmpPath, filePath);
  syncDir(path.dirname(filePath));
}

// 部分平台与文件系统不支持对目录 fsync，失败时忽略：文件内容已经落盘
function syncDir(dir) {
  let fd;
  try {
    fd = fs.openSync(dir, "r");
    fs.fsyncSync(fd);
  } catch (_) {
  } finally {
    if (fd !== undefined) {
      fs.closeSync(fd);
    }
  }
}

// 创建只有属主可访问（0700）的目录，例如保存 cookies 与登录二维码的账号数据目录。
// mkdir 的 mode 会受 umask 影响，已有的目录也不会改，所以再 chmod 一次；文件系统不支持时只给出警告
function ensurePrivateDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700);
  } catch (e) {
    console.warn(`无法把 ${dir} 的权限改为 700：${e.message}`);
  }
}

module.exports = {
  ensurePrivateDir,
  writeFileAtomic,
};
