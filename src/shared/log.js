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

let consoleReady = false;

// 给控制台输出加上级别与时间；debug 级别只在调试时输出
function initConsole({ debug = false } = {}) {
  if (consoleReady) {
    return;
  }
  consoleReady = true;

  ["info", "warn", "error"].forEach(redirectConsole);
  if (debug) {
    redirectConsole("debug");
  } else {
    console.debug = () => {};
  }
}

// 同 initConsole，并把输出同时写入日志文件
function initLogFile(filePath, options = {}) {
  if (logStream) {
    return;
  }

  // 日志中有书名、错误信息等，只允许属主读写；mode 只对新文件生效，已有的文件再 chmod 一次
  const stream = fs.createWriteStream(filePath, { flags: "w", mode: 0o600 });
  // 数据目录只读、磁盘已满等写入失败时只输出到控制台，不让进程因未处理的 error 事件崩溃
  stream.on("error", (e) => {
    if (logStream === stream) {
      logStream = null;
    }
    writeStdout(`[ERROR][${formatLocalTimestamp()}]: 无法写入日志文件 ${filePath}，之后只输出到控制台：${e.message}`);
  });
  logStream = stream;
  try {
    fs.chmodSync(filePath, 0o600);
  } catch (_) {}
  initConsole(options);
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
    stream.once("error", () => resolve());
    stream.end(resolve);
  });
}

module.exports = {
  closeLogFile,
  formatLocalTimestamp,
  initConsole,
  initLogFile,
};
