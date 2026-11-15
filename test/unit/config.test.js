const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { SECRET_MASK, applyConfigPatch, maskValues, resolveAccountConfig } = require("../../src/panel/config");
const { coerceFieldValue, parseBooleanValue, parseIntegerValue, resolveConfig } = require("../../src/config/resolve");

describe("resolveConfig", () => {
  it("补齐默认值并冻结", () => {
    const config = resolveConfig({ duration: "30" });
    assert.equal(config.duration, 30);
    assert.equal(config.speed, "slow");
    assert.equal(Object.isFrozen(config), true);
  });

  it("拒绝超出范围、带后缀的整数与不在选项中的值", () => {
    assert.throws(() => resolveConfig({ duration: 0 }), /在 1–1440 之间/);
    assert.throws(() => resolveConfig({ duration: "10abc" }), /必须是整数/);
    assert.throws(() => resolveConfig({ speed: "turbo" }), /只能是 slow、normal、fast/);
    assert.throws(() => resolveConfig({ screenshot: "maybe" }), /只能是 true 或 false/);
  });

  it("布尔与整数解析", () => {
    assert.equal(parseBooleanValue("on"), true);
    assert.equal(parseBooleanValue("off"), false);
    assert.equal(parseBooleanValue("?", true), true);
    assert.throws(() => parseBooleanValue("?", true, true), /Invalid boolean/);
    assert.equal(parseIntegerValue(" +12 ", "n"), 12);
    assert.throws(() => parseIntegerValue("1e3", "n"), /必须是整数/);
    assert.throws(() => parseIntegerValue("99999999999999999999", "n"), /超出允许的范围/);
    assert.equal(coerceFieldValue({ type: "integer", default: 5 }, ""), 5);
  });
});

describe("applyConfigPatch", () => {
  it("null 与空字符串删除该项，其余按类型转换", () => {
    const next = applyConfigPatch({ duration: 10, speed: "fast" }, { duration: "20", speed: null });
    assert.deepEqual(next, { duration: 20 });
  });

  it("密钥提交空字符串或掩码表示不修改，null 表示清除", () => {
    const current = { barkKey: "secret-key" };
    assert.deepEqual(applyConfigPatch(current, { barkKey: "" }), current);
    assert.deepEqual(applyConfigPatch(current, { barkKey: SECRET_MASK }), current);
    assert.deepEqual(applyConfigPatch(current, { barkKey: null }), {});
    assert.deepEqual(applyConfigPatch(current, { barkKey: "new" }), { barkKey: "new" });
  });

  it("Selenium 地址中的掩码密码只能沿用到同一地址", () => {
    const current = { seleniumUrl: "http://user:pass@grid:4444" };
    const masked = `http://user:${SECRET_MASK}@grid:4444`;
    assert.deepEqual(applyConfigPatch(current, { seleniumUrl: masked }), current);
    assert.throws(() => applyConfigPatch(current, { seleniumUrl: `http://user:${SECRET_MASK}@evil:4444` }), /需要重新填写密码/);
  });

  it("地址类配置项保存时校验格式与域名", () => {
    assert.deepEqual(applyConfigPatch({}, { barkServer: " https://bark.example.com/ " }), { barkServer: "https://bark.example.com/" });
    assert.throws(() => applyConfigPatch({}, { barkServer: "bark.example.com" }), /Bark 服务器地址必须是以 http:\/\/ 或 https:\/\/ 开头的地址/);
    assert.throws(() => applyConfigPatch({}, { ntfyServer: "ftp://ntfy.example.com" }), /http:\/\//);
    // Selenium 地址可以省略协议
    assert.deepEqual(applyConfigPatch({}, { seleniumUrl: "grid:4444" }), { seleniumUrl: "grid:4444" });
    assert.throws(() => applyConfigPatch({}, { seleniumUrl: "http://" }), /Selenium 地址/);
    assert.ok(applyConfigPatch({}, { bookUrl: "https://weread.qq.com/web/reader/abc" }).bookUrl);
    assert.throws(() => applyConfigPatch({}, { bookUrl: "https://evil.example.com/web/reader/abc" }), /只能是 weread\.qq\.com 的地址/);
  });

  it("拒绝未知配置项、面板管理的配置项与非对象", () => {
    assert.throws(() => applyConfigPatch({}, { nope: 1 }), /未知的配置项：nope/);
    assert.throws(() => applyConfigPatch({}, { dataDir: "/tmp" }), /未知的配置项：dataDir/);
    assert.throws(() => applyConfigPatch({}, []), /配置必须是对象/);
  });
});

describe("maskValues", () => {
  it("密钥换成掩码，地址中的密码换成掩码，面板管理的配置项不返回", () => {
    const masked = maskValues({
      barkKey: "k",
      ntfyTopic: "",
      seleniumUrl: " http://u:p@grid:4444/wd/hub",
      dataDir: "/data",
      duration: 10,
    });
    assert.deepEqual(masked, {
      barkKey: SECRET_MASK,
      ntfyTopic: "",
      seleniumUrl: `http://u:${SECRET_MASK}@grid:4444/wd/hub`,
      duration: 10,
    });
  });
});

describe("resolveAccountConfig", () => {
  it("账号覆盖优先于全局默认，数据目录与账号名称由面板决定", () => {
    const data = { defaults: { duration: 15, speed: "fast" } };
    const account = { id: "me", name: "我", overrides: { duration: 30, dataDir: "/elsewhere" } };
    const config = resolveAccountConfig(data, account, "/panel");
    assert.equal(config.duration, 30);
    assert.equal(config.speed, "fast");
    assert.equal(config.accountName, "我");
    assert.match(config.dataDir, /[\\/]panel[\\/]accounts[\\/]me$/);
    assert.throws(() => resolveAccountConfig(data, { ...account, id: "../x" }, "/panel"), /无效的账号 ID/);
  });
});
