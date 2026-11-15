const fs = require("fs");
const os = require("os");
const path = require("path");

// 内置浏览器按账号保留的浏览器资料目录（data/accounts/<id>/profile/，0700）。
// 页面缓存、本地存储、登录状态与阅读器设置跨运行保留；cookies.json 仍然保留，作为资料目录被重置后的备份

// HTTP 缓存的上限（--disk-cache-size）
const DISK_CACHE_BYTES = 50 * 1024 * 1024;
// 运行开始前资料目录超过这个大小时清空其中的缓存；清空后仍然超过时重置资料目录
const MAX_PROFILE_BYTES = 300 * 1024 * 1024;
// 可以随时删除的缓存子目录
const CACHE_DIRS = [
  "Default/Cache",
  "Default/Code Cache",
  "Default/GPUCache",
  "Default/DawnGraphiteCache",
  "Default/DawnWebGPUCache",
  "Default/Service Worker/CacheStorage",
  "Default/Service Worker/ScriptCache",
  "GrShaderCache",
  "GraphiteDawnCache",
  "ShaderCache",
];
// Chromium 防止同一资料目录被两个浏览器同时使用的锁。SingletonLock 是指向「主机名-进程号」的符号链接。
// 进程被强制结束或容器重建（主机名改变）后会残留，下次启动时浏览器会认为资料目录正被占用。
// 启动前检查：锁属于本机仍在运行的浏览器进程时（例如面板与命令行同时运行同一账号）拒绝启动，其余情况删除
const SINGLETON_FILES = ["SingletonLock", "SingletonSocket", "SingletonCookie"];

// SingletonLock 记录的 { host, pid }；没有或无法解析时为 null
function singletonOwner(dir) {
  let target;
  try {
    target = fs.readlinkSync(path.join(dir, "SingletonLock"));
  } catch (_) {
    return null;
  }
  const match = /^(.*)-(\d+)$/.exec(target);
  return match ? { host: match[1], pid: Number(match[2]) } : null;
}

// 进程是否仍在运行并且是浏览器：容器重启后进程号会被别的进程重新使用，只看进程是否存在会误判。
// 进程名以 chrom 开头（chromium、chrome、chromium-browse），chromedriver 不算
function isLiveBrowser(pid) {
  try {
    const name = fs.readFileSync(`/proc/${pid}/comm`, "utf8").trim();
    return /^chrom/i.test(name) && !/driver/i.test(name);
  } catch (_) {
    if (fs.existsSync("/proc/self")) {
      return false;
    }
  }
  // 没有 /proc 的系统只能看进程是否存在
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}

class ProfileInUseError extends Error {}

function profileDir(dataDir) {
  return path.join(dataDir, "profile");
}

// 目录占用的字节数（不跟随符号链接）；目录不存在时为 0
function dirSize(dir) {
  let total = 0;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (_) {
    return 0;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      total += dirSize(full);
    } else if (entry.isFile()) {
      try {
        total += fs.statSync(full).size;
      } catch (_) {
        // 期间被删除的文件不计
      }
    }
  }
  return total;
}

// 资料目录最后一次由哪个主版本的浏览器写入（Chromium 写在 Last Version 文件中）；没有时为 0
function lastVersionMajor(dir) {
  try {
    const match = /^(\d+)\./.exec(fs.readFileSync(path.join(dir, "Last Version"), "utf8").trim());
    return match ? Number(match[1]) : 0;
  } catch (_) {
    return 0;
  }
}

// 资料目录改名为 profile.broken（只留最近一份）后新建空目录
function resetProfile(dir, reason) {
  const broken = `${dir}.broken`;
  fs.rmSync(broken, { recursive: true, force: true });
  if (fs.existsSync(dir)) {
    fs.renameSync(dir, broken);
  }
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  console.warn(`浏览器资料目录已重置（${reason}），原目录保留为 ${path.basename(broken)}；登录状态从 cookies.json 恢复`);
}

// 撤销 resetProfile：删除新建的目录，把 profile.broken 换回来
function restoreProfile(dir) {
  const broken = `${dir}.broken`;
  if (!fs.existsSync(broken)) {
    return;
  }
  try {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.renameSync(broken, dir);
    console.warn("换成空的浏览器资料目录后仍然启动失败，问题不在资料目录，已换回原来的资料目录");
  } catch (e) {
    console.warn("换回原来的浏览器资料目录失败:", e.message);
  }
}

/**
 * 启动浏览器前整理资料目录：不存在时创建（0700）；锁属于本机仍在运行的浏览器时抛出 ProfileInUseError，否则删除残留的锁文件；
 * 记录的浏览器主版本高于当前浏览器时（例如从新镜像退回旧镜像）先重置；超过 MAX_PROFILE_BYTES 时清空缓存，仍然超过时重置。
 * 返回资料目录的路径
 */
function prepareProfile(dataDir, browserMajor, { maxBytes = MAX_PROFILE_BYTES } = {}) {
  const dir = profileDir(dataDir);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    console.info("新建浏览器资料目录");
    return dir;
  }
  try {
    fs.chmodSync(dir, 0o700);
  } catch (e) {
    // 属主变化（例如换了运行用户）时改不了权限：只记录，浏览器能用就继续
    console.warn("无法把浏览器资料目录的权限改为 0700:", e.message);
  }
  const owner = singletonOwner(dir);
  if (owner && owner.host === os.hostname() && owner.pid !== process.pid && isLiveBrowser(owner.pid)) {
    throw new ProfileInUseError(
      `浏览器资料目录正被另一个浏览器使用（进程 ${owner.pid}），同一账号可能同时在面板与命令行中运行；等它结束后再试`
    );
  }
  for (const name of SINGLETON_FILES) {
    try {
      fs.rmSync(path.join(dir, name), { force: true });
    } catch (e) {
      console.warn(`删除浏览器资料目录中的 ${name} 失败:`, e.message);
    }
  }
  const recorded = lastVersionMajor(dir);
  if (browserMajor && recorded > browserMajor) {
    resetProfile(dir, `资料由 Chromium ${recorded} 写入，当前浏览器为 ${browserMajor}，旧版本可能无法打开`);
    return dir;
  }
  const size = dirSize(dir);
  if (size > maxBytes) {
    for (const sub of CACHE_DIRS) {
      fs.rmSync(path.join(dir, sub), { recursive: true, force: true });
    }
    const after = dirSize(dir);
    const mb = (bytes) => Math.round(bytes / 1024 / 1024);
    console.info(`浏览器资料目录 ${mb(size)}MB，超过 ${mb(maxBytes)}MB，已清空缓存（现为 ${mb(after)}MB）`);
    if (after > maxBytes) {
      // 本地存储等无法单独清理的数据仍然超过上限：重置，避免一直增长、每次运行都要清理
      resetProfile(dir, `清空缓存后仍有 ${mb(after)}MB，超过 ${mb(maxBytes)}MB`);
    }
  }
  return dir;
}

module.exports = {
  DISK_CACHE_BYTES,
  MAX_PROFILE_BYTES,
  ProfileInUseError,
  dirSize,
  lastVersionMajor,
  prepareProfile,
  profileDir,
  resetProfile,
  restoreProfile,
};
