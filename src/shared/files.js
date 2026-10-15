const fs = require("fs");

// 先写临时文件再重命名，进程中途被杀时不会留下写了一半的文件。
// options.mode 设置新文件的权限，例如保存密钥的文件用 0o600
function writeFileAtomic(filePath, content, options = {}) {
  const tmpPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmpPath, content, { mode: options.mode });
  if (options.mode !== undefined) {
    fs.chmodSync(tmpPath, options.mode);
  }
  fs.renameSync(tmpPath, filePath);
}

module.exports = {
  writeFileAtomic,
};
