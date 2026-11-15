const { after, describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { closeLogFile, initLogFile } = require("../../src/shared/log");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wa-log-"));
after(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("initLogFile", () => {
  it("启动时把上一次的日志改名为 .1，只保留一份", async () => {
    const file = path.join(dir, "panel.log");
    fs.writeFileSync(file, "older\n");
    fs.writeFileSync(`${file}.1`, "oldest\n");
    const saved = { info: console.info, warn: console.warn, error: console.error, debug: console.debug };
    const write = process.stdout.write;
    process.stdout.write = () => true;
    try {
      initLogFile(file);
      console.info("current");
      await closeLogFile();
    } finally {
      Object.assign(console, saved);
      process.stdout.write = write;
    }
    assert.equal(fs.readFileSync(`${file}.1`, "utf8"), "older\n");
    assert.match(fs.readFileSync(file, "utf8"), /current/);
    if (process.platform !== "win32") {
      assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    }
  });
});
