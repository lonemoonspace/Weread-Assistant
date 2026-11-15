const fs = require("fs");
const path = require("path");

// 内置浏览器按账号保留的浏览器资料目录（data/accounts/<id>/profile/，0700）。
// 页面缓存、本地存储、登录状态与阅读器设置跨运行保留；cookies.json 仍然保留，作为资料目录被重置后的备份

// HTTP 缓存的上限（--disk-cache-size）
const DISK_CACHE_BYTES = 50 * 1024 * 1024;
// 运行开始前资料目录超过这个大小时清空其中的缓存
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
// Chromium 防止同一资料目录被两个浏览器同时使用的锁。进程被强制结束或容器重建后会残留，
// 下次启动时浏览器会认为资料目录正被占用。面板保证同一账号同时只有一个运行，启动前直接删除
const SINGLETON_FILES = ["SingletonLock", "SingletonSocket", "SingletonCookie"];

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

/**
 * 启动浏览器前整理资料目录：不存在时创建（0700）；删除残留的锁文件；记录的浏览器主版本高于当前浏览器时
 * （例如从新镜像退回旧镜像）先重置；超过 MAX_PROFILE_BYTES 时清空缓存。返回资料目录的路径
 */
function prepareProfile(dataDir, browserMajor, { maxBytes = MAX_PROFILE_BYTES } = {}) {
  const dir = profileDir(dataDir);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    console.info("新建浏览器资料目录");
    return dir;
  }
  fs.chmodSync(dir, 0o700);
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
    console.info(
      `浏览器资料目录 ${Math.round(size / 1024 / 1024)}MB，超过 ${Math.round(maxBytes / 1024 / 1024)}MB，已清空缓存（现为 ${Math.round(dirSize(dir) / 1024 / 1024)}MB）`
    );
  }
  return dir;
}

module.exports = {
  DISK_CACHE_BYTES,
  MAX_PROFILE_BYTES,
  dirSize,
  lastVersionMajor,
  prepareProfile,
  profileDir,
  resetProfile,
};
