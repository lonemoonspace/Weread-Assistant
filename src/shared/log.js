const fs = require("fs");

let logStream = null;

function formatLocalTimestamp(d = new Date()) {
  const pad2 = (n) => String(n).padStart(2, "0");
  const pad3 = (n) => String(n).padStart(3, "0");
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(
    d.getDate()
  )} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(
    d.getSeconds()
  )}.${pad3(d.getMilliseconds())}`;
}

// Prefix console output with level and timestamp, and mirror it into the log file
function redirectConsole(method) {
  console[method] = function (...args) {
    let logstr = `[${method.toUpperCase()}][${formatLocalTimestamp()}]: ` + args.join(" ");

    if (logStream) {
      logStream.write(logstr + "\r\n");
    }

    console.log(logstr);
  };
}

function initLogFile(filePath, { debug = false } = {}) {
  if (logStream) {
    return;
  }

  logStream = fs.createWriteStream(filePath, { flags: "w" });

  if (!debug) {
    ["info", "warn", "error"].forEach(redirectConsole);
  }
}

module.exports = {
  formatLocalTimestamp,
  initLogFile,
};
