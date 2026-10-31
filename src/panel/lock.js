const fs = require("fs");
const os = require("os");
const path = require("path");

// 同一数据目录只允许一个面板实例：多个实例各自缓存 panel.json，后写入的会覆盖其他实例的修改。
// 锁文件记录主机名与进程号，持有期间定时更新修改时间作为心跳。
const HEARTBEAT_MS = 10000;
const STALE_MS = 30000;

// 本进程已持有的锁，防止同一进程内对同一目录重复启动
const heldLocks = new Set();

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}

function readLock(file) {
  try {
    return { info: JSON.parse(fs.readFileSync(file, "utf8")), mtimeMs: fs.statSync(file).mtimeMs };
  } catch (_) {
    return null;
  }
}

// 判断已有的锁是否是遗留下来的（持有者已经不在运行）
function isStale(existing, me, staleMs) {
  if (!existing || !existing.info) {
    return true;
  }
  const { info, mtimeMs } = existing;
  if (info.hostname === me.hostname) {
    // 同一主机（或同一容器）：进程已不存在，或者进程号就是当前进程（容器重启后 1 号进程的进程号相同）
    return info.pid === me.pid || !isProcessAlive(info.pid);
  }
  // 其他主机或容器无法检查进程，按心跳判断
  return Date.now() - mtimeMs > staleMs;
}

function acquirePanelLock(dataDir, { heartbeatMs = HEARTBEAT_MS, staleMs = STALE_MS } = {}) {
  const file = path.join(path.resolve(dataDir), "panel.lock");
  const me = { pid: process.pid, hostname: os.hostname(), startedAt: new Date().toISOString() };
  const conflict = (existing) =>
    new Error(
      `另一个面板实例（主机 ${existing.info.hostname}，进程 ${existing.info.pid}）正在使用数据目录 ${path.dirname(file)}；同一数据目录只能运行一个面板`
    );

  if (heldLocks.has(file)) {
    throw conflict({ info: me });
  }

  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const create = () => fs.writeFileSync(file, JSON.stringify(me), { flag: "wx", mode: 0o600 });
  try {
    create();
  } catch (e) {
    if (e.code !== "EEXIST") {
      throw e;
    }
    const existing = readLock(file);
    if (!isStale(existing, me, staleMs)) {
      throw conflict(existing);
    }
    console.warn("接管遗留的面板锁文件:", file);
    fs.rmSync(file, { force: true });
    create();
  }
  heldLocks.add(file);

  const timer = setInterval(() => {
    const now = new Date();
    try {
      fs.utimesSync(file, now, now);
    } catch (_) {
      // 锁文件被手动删除时忽略
    }
  }, heartbeatMs);
  timer.unref();

  return {
    file,
    release() {
      clearInterval(timer);
      heldLocks.delete(file);
      const current = readLock(file);
      if (current && current.info && current.info.pid === me.pid && current.info.startedAt === me.startedAt) {
        fs.rmSync(file, { force: true });
      }
    },
  };
}

module.exports = {
  acquirePanelLock,
};
