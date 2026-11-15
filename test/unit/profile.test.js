const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { ProfileInUseError, dirSize, lastVersionMajor, prepareProfile, resetProfile, restoreProfile } = require("../../src/reader/profile");

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

  it("锁属于本机仍在运行的浏览器时拒绝启动；进程号被别的进程重新使用或进程已退出时删除锁", { skip: !fs.existsSync("/proc/self") }, async () => {
    const dir = dataDir();
    const profile = path.join(dir, "profile");
    fs.mkdirSync(profile);
    // 用改了进程名的 node 模拟浏览器与 chromedriver。不用改名的 sleep（有的系统上是按程序名分派的多合一程序，
    // 换了名字就立即退出），也不靠符号链接改名（Node 24 启动后会把主线程改名为 MainThread）：
    // 子进程自己设置 process.title，并且定时重设
    const named = (name) =>
      spawn(process.execPath, ["-e", `const t = () => { process.title = ${JSON.stringify(name)}; }; t(); setInterval(t, 20);`], {
        stdio: "ignore",
      });
    const browser = named("chromium-test");
    const driver = named("chromedriver");
    const other = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" });
    try {
      const comm = (pid) => fs.readFileSync(`/proc/${pid}/comm`, "utf8").trim();
      const waitName = async (child, name) => {
        for (let i = 0; i < 100 && comm(child.pid) !== name; i += 1) {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        assert.equal(comm(child.pid), name, "模拟进程的进程名应已生效");
      };
      await waitName(browser, "chromium-test");
      await waitName(driver, "chromedriver");
      fs.symlinkSync(`${os.hostname()}-${browser.pid}`, path.join(profile, "SingletonLock"));
      assert.throws(() => quietly(() => prepareProfile(dir, 153)), ProfileInUseError);
      assert.ok(fs.lstatSync(path.join(profile, "SingletonLock")).isSymbolicLink(), "拒绝时不删除锁");

      fs.rmSync(path.join(profile, "SingletonLock"));
      fs.symlinkSync(`${os.hostname()}-${other.pid}`, path.join(profile, "SingletonLock"));
      quietly(() => prepareProfile(dir, 153));
      assert.equal(fs.existsSync(path.join(profile, "SingletonLock")), false, "进程不是浏览器时视为残留");

      // chromedriver 进程名也以 chrom 开头，但不是浏览器
      fs.symlinkSync(`${os.hostname()}-${driver.pid}`, path.join(profile, "SingletonLock"));
      quietly(() => prepareProfile(dir, 153));
      assert.equal(fs.existsSync(path.join(profile, "SingletonLock")), false, "chromedriver 不算正在运行的浏览器");
    } finally {
      browser.kill();
      other.kill();
      driver.kill();
    }
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

  it("清空缓存后仍然超过上限时重置", () => {
    const dir = dataDir();
    const profile = path.join(dir, "profile");
    fs.mkdirSync(path.join(profile, "Default", "Local Storage"), { recursive: true });
    fs.writeFileSync(path.join(profile, "Default", "Local Storage", "big"), Buffer.alloc(4096));
    const { logs } = quietly(() => prepareProfile(dir, 153, { maxBytes: 1000 }));
    assert.deepEqual(fs.readdirSync(profile), []);
    assert.ok(fs.existsSync(`${profile}.broken`));
    assert.ok(logs.some((line) => line.includes("清空缓存后仍有")));
  });

  it("restoreProfile 撤销重置，换回原来的资料目录", () => {
    const dir = dataDir();
    const profile = path.join(dir, "profile");
    fs.mkdirSync(profile);
    fs.writeFileSync(path.join(profile, "Cookies"), "x");
    quietly(() => resetProfile(profile, "测试"));
    fs.writeFileSync(path.join(profile, "new"), "y");
    quietly(() => restoreProfile(profile));
    assert.deepEqual(fs.readdirSync(profile), ["Cookies"]);
    assert.equal(fs.existsSync(`${profile}.broken`), false);
  });
});
