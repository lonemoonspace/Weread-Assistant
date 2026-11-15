// 面板 smoke：账号增删改查与删除账号

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const { CSRF, nextRun, ended } = require("./helpers");

module.exports = async function accountsScenarios({ scenario, startAuthed }) {
  await scenario("账号增删改查：ID 校验、重复检测、删除时可选保留数据", async () => {
    const panel = await startAuthed();
    const accountsDir = path.join(panel.options.dataDir, "accounts");

    const created = await panel.call("POST", "api/accounts", { id: "me", name: "我" });
    assert.strictEqual(created.status, 201);
    assert.deepStrictEqual(
      { id: created.json.account.id, name: created.json.account.name, enabled: created.json.account.enabled },
      { id: "me", name: "我", enabled: true }
    );
    assert.strictEqual(created.json.account.hasCookies, false);
    // 账号目录保存 cookies 与登录二维码，只允许属主访问
    assert.strictEqual(fs.statSync(path.join(accountsDir, "me")).mode & 0o777, 0o700);

    assert.strictEqual((await panel.call("POST", "api/accounts", { id: "me" })).status, 409);
    for (const id of ["Bad_ID", "-x", "x-", "a".repeat(33), "../etc"]) {
      assert.strictEqual((await panel.call("POST", "api/accounts", { id })).status, 400, id);
    }
    assert.strictEqual((await panel.call("POST", "api/accounts", { id: "long", name: "名".repeat(33) })).status, 400);
    // 名称会进入推送标题与日志：换行、控制字符与文字方向控制符都拒绝
    for (const name of ["我\r\n伪造", "a\u0000b", "abc\u202Efdp"]) {
      const bad = await panel.call("POST", "api/accounts", { id: "ctrl", name });
      assert.strictEqual(bad.status, 400, JSON.stringify(name));
      assert.match(bad.json.message, /账号名称不能包含换行/);
    }
    assert.strictEqual((await panel.call("PATCH", "api/accounts/me", { name: "我\n你" })).status, 400);
    assert.strictEqual((await panel.call("POST", "api/accounts", "null")).status, 400);
    const typo = await panel.call("POST", "api/accounts", { id: "typo", nmae: "拼错" });
    assert.deepStrictEqual([typo.status, typo.json.message], [400, "不支持的字段：nmae"]);
    const defaultName = await panel.call("POST", "api/accounts", { id: "second" });
    assert.strictEqual(defaultName.json.account.name, "second");

    const list = await panel.call("GET", "api/accounts");
    assert.deepStrictEqual(list.json.accounts.map((account) => account.id), ["me", "second"]);

    const patched = await panel.call("PATCH", "api/accounts/me", { name: "小明", enabled: false });
    assert.strictEqual(patched.json.account.name, "小明");
    assert.strictEqual(patched.json.account.enabled, false);
    assert.strictEqual((await panel.call("PATCH", "api/accounts/me", { id: "other" })).status, 400);
    assert.strictEqual((await panel.call("PATCH", "api/accounts/me", { enabled: "yes" })).status, 400);
    assert.strictEqual((await panel.call("GET", "api/accounts/nobody")).status, 404);
    assert.strictEqual((await panel.call("PATCH", "api/accounts/nobody", { name: "x" })).status, 404);

    // 默认保留数据目录；重新添加同 ID 账号时沿用其中的 cookies
    fs.writeFileSync(path.join(accountsDir, "me", "cookies.json"), "[]");
    const noCsrf = await panel.request("api/accounts/me", { method: "DELETE", body: {}, cookie: panel.cookie });
    assert.strictEqual(noCsrf.status, 403);
    // deleteData 可选：不带请求体、只带自定义请求头也能删除
    const noBody = await panel.request("api/accounts/me", { method: "DELETE", headers: CSRF, cookie: panel.cookie });
    assert.strictEqual(noBody.status, 204);
    assert.strictEqual((await panel.call("GET", "api/accounts/me")).status, 404);
    assert.ok(fs.existsSync(path.join(accountsDir, "me", "cookies.json")));
    const readded = await panel.call("POST", "api/accounts", { id: "me" });
    assert.strictEqual(readded.json.account.hasCookies, true);

    assert.strictEqual((await panel.call("DELETE", "api/accounts/me", { deleteData: true })).status, 204);
    assert.ok(!fs.existsSync(path.join(accountsDir, "me")));
    assert.ok(fs.existsSync(path.join(accountsDir, "second")));

    // 数据目录建不出来时接口失败且不保存账号，修正后可以重试
    fs.writeFileSync(path.join(accountsDir, "blocked"), "not a directory");
    const blocked = await panel.call("POST", "api/accounts", { id: "blocked" });
    assert.deepStrictEqual([blocked.status, blocked.json.error], [500, "account_dir_failed"]);
    assert.strictEqual((await panel.call("GET", "api/accounts/blocked")).status, 404);
    fs.rmSync(path.join(accountsDir, "blocked"));
    assert.strictEqual((await panel.call("POST", "api/accounts", { id: "blocked" })).status, 201);
  });

  await scenario("删除账号：运行或排队时拒绝；同时删除数据时一并删除运行记录", async () => {
    const panel = await startAuthed();
    await panel.call("POST", "api/accounts", { id: "slow-1" });
    await panel.call("POST", "api/accounts/slow-1/runs");
    const busy = await panel.call("DELETE", "api/accounts/slow-1");
    assert.strictEqual(busy.status, 409);
    assert.strictEqual(busy.json.error, "account_busy");
    const finished = nextRun(panel, ended("slow-1"));
    await panel.call("POST", "api/accounts/slow-1/stop");
    await finished;
    const runsDir = path.join(panel.options.dataDir, "runs", "slow-1");
    assert.ok(fs.existsSync(runsDir));
    assert.strictEqual((await panel.call("DELETE", "api/accounts/slow-1", { deleteData: true })).status, 204);
    assert.ok(!fs.existsSync(runsDir));
    assert.ok(!fs.existsSync(path.join(panel.options.dataDir, "accounts", "slow-1")));
    // 移开第二个目录（运行记录）失败时，已移开的账号目录改回原名，账号与数据都保留，可以重试
    await panel.call("POST", "api/accounts", { id: "slow-2" });
    await panel.call("POST", "api/accounts/slow-2/runs");
    const stopped = nextRun(panel, ended("slow-2"));
    await panel.call("POST", "api/accounts/slow-2/stop");
    await stopped;
    const rename = fs.renameSync;
    fs.renameSync = (from, to) => {
      if (from === path.join(panel.options.dataDir, "runs", "slow-2")) {
        throw Object.assign(new Error("EIO: simulated"), { code: "EIO" });
      }
      return rename(from, to);
    };
    let failed;
    try {
      failed = await panel.call("DELETE", "api/accounts/slow-2", { deleteData: true });
    } finally {
      fs.renameSync = rename;
    }
    assert.deepStrictEqual([failed.status, failed.json.error], [500, "delete_data_failed"]);
    assert.strictEqual((await panel.call("GET", "api/accounts/slow-2")).status, 200);
    assert.ok(fs.existsSync(path.join(panel.options.dataDir, "accounts", "slow-2")), "账号目录应改回原名");
    assert.ok(fs.existsSync(path.join(panel.options.dataDir, "runs", "slow-2")));
    assert.strictEqual((await panel.call("DELETE", "api/accounts/slow-2", { deleteData: true })).status, 204);
    // 数据目录先移开、写入后再删除，不留下临时目录
    for (const dir of ["accounts", "runs"]) {
      assert.deepStrictEqual(fs.readdirSync(path.join(panel.options.dataDir, dir)).filter((name) => name.startsWith(".deleting-")), [], dir);
    }
  });
};
