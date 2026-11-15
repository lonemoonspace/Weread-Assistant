const { after, describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { resolveConfig } = require("../../src/config/resolve");
const { resolveTiming } = require("../../src/reader/timing");
const { createLocalBrowserChecker } = require("../../src/shared/local-browser");

const tempDirs = [];
after(() => tempDirs.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

describe("resolveTiming", () => {
  it("默认等待 10 秒与 20 秒，按页面等待倍率放大；可能不存在的元素不放大", () => {
    const base = resolveTiming(resolveConfig({}));
    assert.equal(base.elementWaitMs, 10000);
    assert.equal(base.pageWaitMs, 20000);
    const slow = resolveTiming(resolveConfig({ pageWaitMultiplier: 3 }));
    assert.equal(slow.elementWaitMs, 30000);
    assert.equal(slow.pageWaitMs, 60000);
    assert.equal(slow.optionalWaitMs, base.optionalWaitMs);
    assert.throws(() => resolveConfig({ pageWaitMultiplier: 6 }), /1–5/);
  });
});

describe("createLocalBrowserChecker", { skip: process.platform === "win32" }, () => {
  // 用输出版本号的脚本代替 chromedriver 与 Chromium
  function fakeBrowser(version) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wa-browser-"));
    tempDirs.push(dir);
    const write = (name, text) => {
      const file = path.join(dir, name);
      fs.writeFileSync(file, `#!/bin/sh\necho "${text}"\n`, { mode: 0o755 });
      return file;
    };
    return {
      env: {
        PATH: "",
        CHROME_BIN: write("chromium", `Chromium ${version}.0.1.2`),
        CHROMEDRIVER_PATH: write("chromedriver", `ChromeDriver ${version}.0.1.2 (abc)`),
      },
      write,
    };
  }

  it("检查过且文件没变时 cached() 返回结果，文件变化后为 null", async () => {
    const { env, write } = fakeBrowser(150);
    const check = createLocalBrowserChecker(env);
    assert.equal(check.cached(), null);
    const status = await check();
    assert.equal(status.ready, true);
    assert.deepEqual(check.cached(), status);
    // 模拟浏览器升级：文件内容（大小）变化
    write("chromium", "Chromium 151.0.1.2 upgraded");
    assert.equal(check.cached(), null);
  });

  it("未就绪的结果不缓存", async () => {
    const { env, write } = fakeBrowser(150);
    write("chromedriver", "ChromeDriver 149.0.1.2");
    const check = createLocalBrowserChecker(env);
    assert.equal((await check()).ready, false);
    assert.equal(check.cached(), null);
  });
});
