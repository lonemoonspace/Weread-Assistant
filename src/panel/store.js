const fs = require("fs");
const path = require("path");
const { writeFileAtomic } = require("../shared/files");
const { ACCOUNT_ID_PATTERN } = require("./config");
const { DEFAULT_SETTINGS } = require("./settings");

const STORE_VERSION = 1;

// 账号 ID 用作目录名：手工编辑写入的无效 ID 在启动时拒绝，而不是在读写文件时指向意外的位置
function checkAccountIds(accounts) {
  const invalid = accounts.map((account) => account && account.id).filter((id) => typeof id !== "string" || !ACCOUNT_ID_PATTERN.test(id));
  if (invalid.length > 0) {
    throw new Error(`panel.json 中有无效的账号 ID：${invalid.map(String).join(", ")}。账号 ID 只能包含小写字母、数字与短横线`);
  }
}

// 补齐各部分的结构。defaults 不存在时（首次启动，或由只有 auth 的旧文件升级）用 seedDefaults 初始化
function normalizeData(raw, seedDefaults) {
  return {
    version: STORE_VERSION,
    auth: { passwordHash: "", ...(raw.auth || {}) },
    settings: { ...DEFAULT_SETTINGS, ...(raw.settings || {}) },
    defaults: raw.defaults || { ...seedDefaults },
    accounts: Array.isArray(raw.accounts)
      ? raw.accounts.map((account) => ({
          ...account,
          schedules: Array.isArray(account.schedules) ? account.schedules : [],
          challenge: account.challenge && typeof account.challenge === "object" ? account.challenge : null,
        }))
      : [],
  };
}

// 已有文件（例如手工复制或从备份恢复的）可能对其他用户可读，启动时收紧为 0600；改不了时拒绝启动
function restrictPermissions(filePath) {
  const mode = fs.statSync(filePath).mode & 0o777;
  if (mode === 0o600) {
    return;
  }
  try {
    fs.chmodSync(filePath, 0o600);
  } catch (e) {
    throw new Error(`${filePath} 的权限为 ${mode.toString(8)}，无法改为 600：${e.message}`);
  }
  console.warn(`${filePath} 的权限为 ${mode.toString(8)}，已改为 600`);
}

// panel.json 无法解析时读取上一版；上一版也没有或也损坏时拒绝启动
function readBackup(backupPath, filePath, error) {
  try {
    return JSON.parse(fs.readFileSync(backupPath, "utf8"));
  } catch (_) {
    throw new Error(`无法解析 ${filePath}：${error.message}，也没有可用的上一版 ${backupPath}。请修复该文件，或删除后重新启动面板`);
  }
}

// panel.json 的读写。写入串行执行、原子替换，文件权限 0600（其中保存密码哈希与各类密钥）。
// options.seedDefaults：首次初始化全局默认配置时使用的值，例如来自 SELENIUM_URL 的 Selenium 地址；
// options.readOnly：只读取，不升级、不写入（供面板以外的进程使用，写入只由持有锁的面板进行）
function createStore(dataDir, { seedDefaults = {}, readOnly = false } = {}) {
  const filePath = path.join(dataDir, "panel.json");
  // 每次写入前保存的上一版，panel.json 损坏时从它恢复
  const backupPath = `${filePath}.bak`;
  let raw = {};
  let restored = false;

  if (fs.existsSync(filePath)) {
    if (!readOnly) {
      restrictPermissions(filePath);
    }
    try {
      raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch (e) {
      raw = readBackup(backupPath, filePath, e);
      restored = true;
      if (!readOnly) {
        const corruptPath = `${filePath}.corrupt-${Date.now()}`;
        fs.renameSync(filePath, corruptPath);
        console.warn(`${filePath} 已损坏（${e.message}），已改名为 ${corruptPath}，改用上一版 ${backupPath}`);
      }
    }
  } else {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  let data = normalizeData(raw, seedDefaults);
  checkAccountIds(data.accounts);
  if (!readOnly && (restored || JSON.stringify(data) !== JSON.stringify(raw))) {
    writeFileAtomic(filePath, JSON.stringify(data, null, 2), { mode: 0o600 });
  }

  let pending = Promise.resolve();
  const listeners = new Set();

  return {
    filePath,
    // 返回当前数据的深拷贝，调用方修改它不会影响存储
    get() {
      return JSON.parse(JSON.stringify(data));
    },
    // mutator 接收数据副本并直接修改；按调用顺序依次写入。mutator 抛出错误时不写入，错误交给调用方
    update(mutator) {
      if (readOnly) {
        return Promise.reject(new Error("只读模式下不能修改面板数据"));
      }
      const run = pending.then(() => {
        const next = this.get();
        mutator(next);
        writeFileAtomic(backupPath, JSON.stringify(data, null, 2), { mode: 0o600 });
        writeFileAtomic(filePath, JSON.stringify(next, null, 2), { mode: 0o600 });
        data = next;
        for (const listener of listeners) {
          try {
            listener();
          } catch (e) {
            console.error("处理面板数据变化失败:", e);
          }
        }
        return this.get();
      });
      pending = run.catch(() => {});
      return run;
    },
    // 每次写入成功后调用 listener；返回取消订阅的函数
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

module.exports = {
  createStore,
};
