const fs = require("fs");
const util = require("util");

let logStream = null;
const writeStdout = console.log.bind(console);

function formatLocalTimestamp(d = new Date()) {
  const pad2 = (n) => String(n).padStart(2, "0");
  const pad3 = (n) => String(n).padStart(3, "0");
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(
    d.getDate()
  )} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(
    d.getSeconds()
  )}.${pad3(d.getMilliseconds())}`;
}

// Prefix console output with level and timestamp, and mirror it into the log file.
// util.format keeps objects and error stacks readable instead of "[object Object]".
function redirectConsole(method) {
  console[method] = function (...args) {
    const logstr = `[${method.toUpperCase()}][${formatLocalTimestamp()}]: ${util.format(...args)}`;

    if (logStream) {
      logStream.write(logstr + "\r\n");
    }

    writeStdout(logstr);
  };
}

function initLogFile(filePath, { debug = false } = {}) {
  if (logStream) {
    return;
  }

  logStream = fs.createWriteStream(filePath, { flags: "w" });

  ["info", "warn", "error"].forEach(redirectConsole);
  if (debug) {
    redirectConsole("debug");
  } else {
    console.debug = () => {};
  }
}

// 关闭日志文件并等待写入完成；退出进程前调用，否则最后几行日志可能来不及写入
function closeLogFile() {
  return new Promise((resolve) => {
    if (!logStream) {
      resolve();
      return;
    }
    const stream = logStream;
    logStream = null;
    stream.end(resolve);
  });
}

module.exports = {
  closeLogFile,
  formatLocalTimestamp,
  initLogFile,
};
