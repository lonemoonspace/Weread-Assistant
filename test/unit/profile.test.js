const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { dirSize, lastVersionMajor, prepareProfile } = require("../../src/reader/profile");

function quietly(fn) {
  const saved = { info: console.info, warn: console.warn };
  const logs = [];
  console.info = console.warn = (...args) => logs.push(args.join(" "));
  try {
    return { result: fn(), logs };
  } finally {
    Object.assign(console, saved);
  }
}

function dataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "profile-test-"));
}

describe("prepareProfile", () => {
  it("不存在时新建 0700 的资料目录", () => {
    const dir = dataDir();
    const { result } = quietly(() => prepareProfile(dir, 153));
    assert.equal(result, path.join(dir, "profile"));
    assert.equal(fs.statSync(result).mode & 0o777, 0o700);
  });

  it("删除残留的锁文件，其他文件保留", () => {
    const dir = dataDir();
    const profile = path.join(dir, "profile");
    fs.mkdirSync(path.join(profile, "Default"), { recursive: true });
    fs.symlinkSync("other-host-123", path.join(profile, "SingletonLock"));
    fs.writeFileSync(path.join(profile, "SingletonCookie"), "x");
    fs.writeFileSync(path.join(profile, "Default", "Preferences"), "{}");
    quietly(() => prepareProfile(dir, 153));
    assert.deepEqual(fs.readdirSync(profile).sort(), ["Default"]);
    assert.ok(fs.existsSync(path.join(profile, "Default", "Preferences")));
  });

  it("资料由更高主版本的浏览器写入时重置，原目录保留为 profile.broken（只留一份）", () => {
    const dir = dataDir();
    const profile = path.join(dir, "profile");
    fs.mkdirSync(profile);
    fs.mkdirSync(`${profile}.broken`);
    fs.writeFileSync(path.join(`${profile}.broken`, "old"), "x");
    fs.writeFileSync(path.join(profile, "Last Version"), "160.0.1.2");
    assert.equal(lastVersionMajor(profile), 160);
    const { logs } = quietly(() => prepareProfile(dir, 153));
    assert.deepEqual(fs.readdirSync(profile), []);
    assert.deepEqual(fs.readdirSync(`${profile}.broken`), ["Last Version"]);
    assert.ok(logs.some((line) => line.includes("Chromium 160")));

    // 同一或更低版本写入的不重置
    fs.writeFileSync(path.join(profile, "Last Version"), "153.0.1.2");
    quietly(() => prepareProfile(dir, 153));
    assert.ok(fs.existsSync(path.join(profile, "Last Version")));
  });

  it("超过大小上限时清空缓存子目录", () => {
    const dir = dataDir();
    const profile = path.join(dir, "profile");
    fs.mkdirSync(path.join(profile, "Default", "Cache"), { recursive: true });
    fs.writeFileSync(path.join(profile, "Default", "Cache", "data_1"), Buffer.alloc(4096));
    fs.writeFileSync(path.join(profile, "Default", "Cookies"), Buffer.alloc(100));
    assert.equal(dirSize(profile), 4196);
    quietly(() => prepareProfile(dir, 153, { maxBytes: 1000 }));
    assert.equal(fs.existsSync(path.join(profile, "Default", "Cache")), false);
    assert.ok(fs.existsSync(path.join(profile, "Default", "Cookies")));
  });
});
