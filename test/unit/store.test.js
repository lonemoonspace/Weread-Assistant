const { after, describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createStore } = require("../../src/panel/store");

const tempDirs = [];
after(() => tempDirs.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

function dataDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wa-store-"));
  tempDirs.push(dir);
  return dir;
}

// 静默启动时的恢复提示
function quietly(fn) {
  const warn = console.warn;
  console.warn = () => {};
  try {
    return fn();
  } finally {
    console.warn = warn;
  }
}

describe("createStore", () => {
  it("首次启动写入默认结构，权限为 0600", () => {
    const dir = dataDir();
    const store = createStore(dir, { seedDefaults: { seleniumUrl: "http://grid:4444" } });
    const data = store.get();
    assert.deepEqual(data.accounts, []);
    assert.equal(data.defaults.seleniumUrl, "http://grid:4444");
    assert.equal(data.auth.passwordLogin, true);
    if (process.platform !== "win32") {
      assert.equal(fs.statSync(store.filePath).mode & 0o777, 0o600);
    }
  });

  it("写入按顺序执行，保留上一版；mutator 出错时不写入", async () => {
    const dir = dataDir();
    const store = createStore(dir);
    const changes = [];
    store.subscribe(() => changes.push(store.get().settings.maxConcurrentRuns));
    await Promise.all([
      store.update((data) => (data.settings.maxConcurrentRuns = 2)),
      store.update((data) => (data.settings.maxConcurrentRuns = 3)),
    ]);
    assert.deepEqual(changes, [2, 3]);
    assert.equal(JSON.parse(fs.readFileSync(`${store.filePath}.bak`, "utf8")).settings.maxConcurrentRuns, 2);
    await assert.rejects(
      store.update(() => {
        throw new Error("boom");
      }),
      /boom/
    );
    assert.equal(store.get().settings.maxConcurrentRuns, 3);
    // get() 返回副本
    store.get().settings.maxConcurrentRuns = 9;
    assert.equal(store.get().settings.maxConcurrentRuns, 3);
  });

  it("panel.json 损坏时从上一版恢复并保留损坏的副本", async () => {
    const dir = dataDir();
    const store = createStore(dir);
    await store.update((data) => (data.settings.maxConcurrentRuns = 4));
    await store.update((data) => (data.settings.maxConcurrentRuns = 5));
    fs.writeFileSync(store.filePath, "{not json");
    const restored = quietly(() => createStore(dir));
    assert.equal(restored.get().settings.maxConcurrentRuns, 4);
    assert.equal(fs.readdirSync(dir).filter((name) => name.startsWith("panel.json.corrupt-")).length, 1);
  });

  it("结构不对的文件当作损坏，没有上一版时拒绝启动", () => {
    const dir = dataDir();
    fs.writeFileSync(path.join(dir, "panel.json"), JSON.stringify({ accounts: { a: 1 } }));
    assert.throws(() => quietly(() => createStore(dir)), /也没有可用的上一版/);
  });

  it("拒绝无效的账号 ID", () => {
    const dir = dataDir();
    fs.writeFileSync(path.join(dir, "panel.json"), JSON.stringify({ accounts: [{ id: "../etc" }] }));
    assert.throws(() => createStore(dir), /无效的账号 ID/);
  });

  it("只读模式不写入", async () => {
    const dir = dataDir();
    createStore(dir);
    const before = fs.readFileSync(path.join(dir, "panel.json"), "utf8");
    const store = createStore(dir, { readOnly: true });
    await assert.rejects(store.update(() => {}), /只读模式/);
    assert.equal(fs.readFileSync(path.join(dir, "panel.json"), "utf8"), before);
  });
});
