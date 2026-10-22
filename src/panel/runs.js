const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { ensurePrivateDir, writeFileAtomic } = require("../shared/files");
const { formatLocalTimestamp } = require("../shared/log");
const { ACCOUNT_ID_PATTERN } = require("./accounts");

// 每次运行保存在 runs/<账号 ID>/<运行 ID>/ 下：meta.json 为运行记录，output.log 为日志

// 运行状态：排队中、启动中、等待扫码、阅读中为进行中；其余为结束状态
const ACTIVE_STATUSES = ["queued", "starting", "waiting-login", "reading"];
const FINAL_STATUSES = ["success", "failed", "stopped", "interrupted"];

// 运行 ID：精确到毫秒的 UTC 时间加随机后缀，按字典序即按时间排序，例如 20261015T063000123Z-3f9a。
// 第 7 步之前的 ID 只精确到秒（20261015T063000Z-3f9a），仍然接受
const RUN_ID_PATTERN = /^\d{8}T\d{6}(\d{3})?Z-[0-9a-f]{4}$/;

function newRunId(date = new Date()) {
  const stamp = date.toISOString().replace(/[-:.]/g, "");
  return `${stamp}-${crypto.randomBytes(2).toString("hex")}`;
}

function runsRoot(panelDataDir) {
  return path.join(path.resolve(panelDataDir), "runs");
}

function accountRunsDir(panelDataDir, accountId) {
  if (!ACCOUNT_ID_PATTERN.test(accountId)) {
    throw new Error(`无效的账号 ID：${accountId}`);
  }
  return path.join(runsRoot(panelDataDir), accountId);
}

function runDir(panelDataDir, accountId, runId) {
  if (!RUN_ID_PATTERN.test(runId)) {
    throw new Error(`无效的运行 ID：${runId}`);
  }
  return path.join(accountRunsDir(panelDataDir, accountId), runId);
}

function writeRunMeta(dir, meta) {
  writeFileAtomic(path.join(dir, "meta.json"), JSON.stringify(meta, null, 2), { mode: 0o600 });
}

function readRunMeta(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, "meta.json"), "utf8"));
}

function listDirs(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch (e) {
    if (e.code === "ENOENT") {
      return [];
    }
    throw e;
  }
}

// 面板启动时调用：把运行记录目录收紧为只有属主可访问（0700）。升级前创建的运行目录与日志是 0755 / 0644，
// 上一级目录收紧后其他用户就无法再进入读取，不需要逐个修改其中的文件
function restrictRunDirs(panelDataDir) {
  const root = runsRoot(panelDataDir);
  if (!fs.existsSync(root)) {
    return;
  }
  ensurePrivateDir(root);
  for (const accountId of listDirs(root)) {
    ensurePrivateDir(path.join(root, accountId));
  }
}

// 面板启动时调用：上次面板停止（或崩溃、断电）时仍在进行中的运行标为“中断”，结束时间取最后一次写入的时间
function markInterruptedRuns(panelDataDir) {
  const marked = [];
  const root = runsRoot(panelDataDir);
  for (const accountId of listDirs(root)) {
    for (const runId of listDirs(path.join(root, accountId))) {
      const dir = path.join(root, accountId, runId);
      let meta;
      try {
        meta = readRunMeta(dir);
      } catch (e) {
        if (e.code !== "ENOENT") {
          console.warn("无法读取运行记录，跳过:", dir, e.message);
        }
        continue;
      }
      if (!ACTIVE_STATUSES.includes(meta.status)) {
        continue;
      }
      const lastWrite = ["meta.json", "output.log"]
        .map((name) => {
          try {
            return fs.statSync(path.join(dir, name)).mtimeMs;
          } catch (_) {
            return 0;
          }
        })
        .reduce((a, b) => Math.max(a, b), 0);
      meta.status = "interrupted";
      meta.error = "面板停止或重启时运行被中断";
      meta.endedAt = new Date(lastWrite || Date.now()).toISOString();
      writeRunMeta(dir, meta);
      fs.appendFileSync(
        path.join(dir, "output.log"),
        `[PANEL][${formatLocalTimestamp()}]: 面板重新启动，上次未结束的运行标记为中断\n`,
        { mode: 0o600 }
      );
      marked.push({ accountId, runId });
    }
  }
  if (marked.length > 0) {
    console.warn(`上次面板停止时有 ${marked.length} 个运行未结束，已标记为中断`);
  }
  return marked;
}

module.exports = {
  ACTIVE_STATUSES,
  FINAL_STATUSES,
  RUN_ID_PATTERN,
  accountRunsDir,
  markInterruptedRuns,
  restrictRunDirs,
  newRunId,
  readRunMeta,
  runDir,
  writeRunMeta,
};
