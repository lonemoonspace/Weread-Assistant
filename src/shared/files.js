const fs = require("fs");

// 先写临时文件再重命名，进程中途被杀时不会留下写了一半的文件
function writeFileAtomic(filePath, content) {
  const tmpPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmpPath, content);
  fs.renameSync(tmpPath, filePath);
}

module.exports = {
  writeFileAtomic,
};
