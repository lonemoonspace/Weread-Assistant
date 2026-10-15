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

// panel.json 的读写。写入串行执行、原子替换，文件权限 0600（其中保存密码哈希与各类密钥）
function createStore(dataDir) {
  const filePath = path.join(dataDir, "panel.json");
  let data;

  if (fs.existsSync(filePath)) {
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
