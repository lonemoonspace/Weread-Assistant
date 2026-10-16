const fs = require("fs");
const path = require("path");
const { writeFileAtomic } = require("../shared/files");
const { DEFAULT_SETTINGS } = require("./settings");

const STORE_VERSION = 1;

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

// panel.json 的读写。写入串行执行、原子替换，文件权限 0600（其中保存密码哈希与各类密钥）。
// options.seedDefaults：首次初始化全局默认配置时使用的值，例如来自 SELENIUM_URL 的 Selenium 地址；
// options.readOnly：只读取，不升级、不写入（供面板以外的进程使用，写入只由持有锁的面板进行）
function createStore(dataDir, { seedDefaults = {}, readOnly = false } = {}) {
  const filePath = path.join(dataDir, "panel.json");
  let raw = {};

  if (fs.existsSync(filePath)) {
    if (!readOnly) {
      restrictPermissions(filePath);
    }
    try {
      raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch (e) {
      throw new Error(`无法解析 ${filePath}：${e.message}。请修复该文件，或删除后重新启动面板`);
    }
  } else {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  let data = normalizeData(raw, seedDefaults);
  if (!readOnly && JSON.stringify(data) !== JSON.stringify(raw)) {
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
