const fs = require("fs");
const path = require("path");
const { writeFileAtomic } = require("../shared/files");

const STORE_VERSION = 1;

function defaultData() {
  return {
    version: STORE_VERSION,
    auth: { passwordHash: "" },
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

// panel.json 的读写。写入串行执行、原子替换，文件权限 0600（其中保存密码哈希与各类密钥）
function createStore(dataDir) {
  const filePath = path.join(dataDir, "panel.json");
  let data;

  if (fs.existsSync(filePath)) {
    restrictPermissions(filePath);
    try {
      data = { ...defaultData(), ...JSON.parse(fs.readFileSync(filePath, "utf8")) };
    } catch (e) {
      throw new Error(`无法解析 ${filePath}：${e.message}。请修复该文件，或删除后重新启动面板`);
    }
  } else {
    fs.mkdirSync(dataDir, { recursive: true });
    data = defaultData();
    writeFileAtomic(filePath, JSON.stringify(data, null, 2), { mode: 0o600 });
  }

  let pending = Promise.resolve();

  return {
    filePath,
    // 返回当前数据的深拷贝，调用方修改它不会影响存储
    get() {
      return JSON.parse(JSON.stringify(data));
    },
    // mutator 接收数据副本并直接修改；按调用顺序依次写入
    update(mutator) {
      const run = pending.then(() => {
        const next = this.get();
        mutator(next);
        writeFileAtomic(filePath, JSON.stringify(next, null, 2), { mode: 0o600 });
        data = next;
        return this.get();
      });
      pending = run.catch(() => {});
      return run;
    },
  };
}

module.exports = {
  createStore,
};
