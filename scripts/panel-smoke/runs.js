// 面板 smoke：运行队列、子进程、停止、失败与实时推送

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const { SECRET_MASK } = require(path.resolve(__dirname, "..", "..", "src", "panel", "config"));
const { CHILD_ENV_KEYS } = require(path.resolve(__dirname, "..", "..", "src", "panel", "runner"));
const { startMockSelenium } = require("../fixtures/mock-selenium");
const { CSRF, STUB_WORKER, tempDir, until, nextRun, ended, runFiles, openEvents, sessionCookie } = require("./helpers");

module.exports = async function runsScenarios({ scenario, start, login, startAuthed }) {
  await scenario("运行：子进程经 IPC 收到账号配置，按事件更新状态，日志与运行记录写入运行目录；子进程只继承白名单环境变量", async () => {
    // 面板所在环境中的密钥与运行配置变量都不应传给子进程
    const leaking = {
      PANEL_SMOKE_SECRET: "panel-secret",
      BARK_KEY: "env-bark-key",
      NTFY_TOKEN: "env-ntfy-token",
      EMAIL_PASS: "env-email-pass",
      WEREAD_DURATION: "5",
      SOME_API_TOKEN: "env-api-token",
    };
    Object.assign(process.env, leaking);
    try {
      const panel = await startAuthed();
      await panel.call("PATCH", "api/settings", { defaults: { barkKey: "secret-bark-key" } });
      await panel.call("POST", "api/accounts", { id: "ok-1", name: "测试" });
      const statuses = [];
      const unsubscribe = panel.runner.subscribe((type, run) => {
        if (type === "run" && statuses[statuses.length - 1] !== run.status) {
          statuses.push(run.status);
        }
      });
      const finished = nextRun(panel, ended("ok-1"));
      const res = await panel.call("POST", "api/accounts/ok-1/runs");
      assert.strictEqual(res.status, 202);
      assert.strictEqual(res.json.run.mode, "read");
      assert.strictEqual(res.json.run.trigger, "manual");
      assert.strictEqual(res.json.run.accountName, "测试");
      const run = await finished;
      unsubscribe();
      assert.deepStrictEqual(statuses, ["queued", "starting", "reading", "success"]);
      assert.strictEqual(run.minutes, 2);
      assert.strictEqual(run.book, "测试书");
      assert.strictEqual(run.screenshot, "screenshot-2.png");
      assert.match(run.id, /^\d{8}T\d{9}Z-[0-9a-f]{4}$/);

      const files = runFiles(panel, "ok-1", run.id);
      const log = await files.log();
      const meta = files.meta();
      // 运行日志与阅读截图属于阅读隐私，只允许属主访问
      assert.strictEqual(fs.statSync(files.dir).mode & 0o777, 0o700);
      assert.strictEqual(fs.statSync(path.dirname(files.dir)).mode & 0o777, 0o700);
      for (const name of ["output.log", "meta.json"]) {
        assert.strictEqual(fs.statSync(path.join(files.dir, name)).mode & 0o777, 0o600, name);
      }
      assert.strictEqual(meta.status, "success");
      assert.strictEqual(meta.exitCode, 0);
      assert.strictEqual(meta.minutes, 2);
      assert.ok(!("loginUrl" in meta));
      assert.match(log, /\[PANEL\]\[[^\]]+\]: 加入队列：手动触发，阅读/);
      assert.match(log, /Reading minute: 2/);
      assert.ok(log.includes(`dataDir=${path.join(panel.options.dataDir, "accounts", "ok-1")}`), "子进程应收到账号的数据目录");
      const envKeys = JSON.parse(log.match(/环境变量: (\[.*\])/)[1]);
      assert.ok(envKeys.includes("PATH"), "子进程应保留 PATH");
      for (const key of Object.keys(leaking)) {
        assert.ok(!envKeys.includes(key), `子进程环境变量中不应有 ${key}`);
      }
      // NODE_CHANNEL_* 由 Node 为 IPC 添加
      const unexpected = envKeys.filter(
        (key) => !CHILD_ENV_KEYS.has(key) && !key.startsWith("LC_") && !key.startsWith("NODE_CHANNEL_")
      );
      assert.deepStrictEqual(unexpected, [], "子进程只继承白名单中的环境变量");
      for (const [key, value] of Object.entries(leaking)) {
        if (key !== "WEREAD_DURATION") {
          assert.ok(!log.includes(value), `日志中不应出现 ${key} 的值`);
        }
      }
      assert.match(log, /barkKey 已下发: true/, "密钥经 IPC 下发");
      assert.ok(!log.includes("secret-bark-key"));
      // 子进程打印的密钥值与登录链接中的 uid 在写入日志前替换为掩码
      assert.ok(
        log.includes(`模拟泄露: https://api.day.app/${SECRET_MASK} https://weread.qq.com/web/confirm?uid=${SECRET_MASK}&from=stub`),
        "日志中的密钥与登录链接应替换为掩码"
      );
      assert.ok(!log.includes("ok-1-uid"));

      const viewed = await panel.call("GET", `api/accounts/ok-1/runs/${run.id}/log`);
      assert.strictEqual(viewed.status, 200);
      assert.match(viewed.headers.get("content-type"), /^text\/plain; charset=utf-8/);
      assert.strictEqual(viewed.headers.get("content-disposition"), null);
      assert.ok(viewed.text.includes("运行结束：成功"));
      const download = await panel.call("GET", `api/accounts/ok-1/runs/${run.id}/log?download=1`);
      assert.match(download.headers.get("content-disposition"), new RegExp(`attachment; filename="ok-1-${run.id}.log"`));
      for (const bad of ["../../panel.json", "20261015T000000Z-zzzz", "nope"]) {
        assert.strictEqual((await panel.call("GET", `api/accounts/ok-1/runs/${encodeURIComponent(bad)}/log`)).status, 404, bad);
      }
      assert.strictEqual((await panel.request(`api/accounts/ok-1/runs/${run.id}/log`)).status, 401);
      assert.deepStrictEqual((await panel.call("GET", "api/runs")).json.runs, []);
    } finally {
      for (const key of Object.keys(leaking)) {
        delete process.env[key];
      }
    }
  });

  await scenario("队列：同一账号不能重复运行；按并发数依次启动，调大并发数后立即启动排队中的运行；可取消排队", async () => {
    const panel = await startAuthed();
    for (const id of ["slow-a", "slow-b", "slow-c", "off-1"]) {
      await panel.call("POST", "api/accounts", { id });
    }
    await panel.call("PATCH", "api/accounts/off-1", { enabled: false });

    const a = await panel.call("POST", "api/accounts/slow-a/runs");
    assert.strictEqual(a.json.run.status, "starting");
    const again = await panel.call("POST", "api/accounts/slow-a/runs", { mode: "login" });
    assert.strictEqual(again.status, 409);
    assert.strictEqual(again.json.error, "run_active");
    assert.strictEqual((await panel.call("POST", "api/accounts/slow-b/runs")).json.run.status, "queued");
    assert.strictEqual((await panel.call("POST", "api/accounts/slow-c/runs")).json.run.status, "queued");
    assert.strictEqual((await panel.call("POST", "api/accounts/off-1/runs")).json.error, "account_disabled");
    assert.strictEqual((await panel.call("POST", "api/accounts/nobody/runs")).status, 404);
    assert.strictEqual((await panel.call("POST", "api/accounts/off-1/runs", { mode: "fast" })).status, 400);
    assert.strictEqual((await panel.call("POST", "api/accounts/off-1/runs", { mode: "read", x: 1 })).status, 400);
    assert.strictEqual((await panel.request("api/accounts/slow-c/runs", { method: "POST", cookie: panel.cookie })).status, 403);

    const listed = (await panel.call("GET", "api/runs")).json.runs;
    assert.deepStrictEqual(listed.map((run) => [run.accountId, run.status]), [
      ["slow-a", "starting"],
      ["slow-b", "queued"],
      ["slow-c", "queued"],
    ]);
    assert.ok(listed[1].log.some((line) => line.includes("加入队列")));

    const cancelled = await panel.call("POST", "api/accounts/slow-c/stop");
    assert.strictEqual(cancelled.status, 202);
    assert.strictEqual(cancelled.json.run.status, "stopped");
    assert.match(await runFiles(panel, "slow-c", cancelled.json.run.id).log(), /已取消排队/);

    const bStarted = nextRun(panel, (run) => run.accountId === "slow-b" && run.status === "starting");
    await panel.call("PATCH", "api/settings", { settings: { maxConcurrentRuns: 2 } });
    await bStarted;

    const stopped = Promise.all([nextRun(panel, ended("slow-a")), nextRun(panel, ended("slow-b"))]);
    await panel.call("POST", "api/accounts/slow-a/stop");
    await panel.call("POST", "api/accounts/slow-b/stop");
    assert.deepStrictEqual((await stopped).map((run) => run.status), ["stopped", "stopped"]);
    assert.deepStrictEqual((await panel.call("GET", "api/runs")).json.runs, []);
  });

  await scenario("失败：上报错误、等待扫码超时、未上报结果就退出都记为失败；错误信息中的密钥替换为掩码", async () => {
    const panel = await startAuthed();
    // 桩子进程上报的错误信息中带有 Bark Key
    await panel.call("PATCH", "api/settings", { settings: { maxConcurrentRuns: 3 }, defaults: { barkKey: "fail-secret-key" } });
    const ids = ["fail-1", "timeout-1", "crash-1"];
    const finished = Promise.all(ids.map((id) => nextRun(panel, ended(id))));
    for (const id of ids) {
      await panel.call("POST", "api/accounts", { id });
      assert.strictEqual((await panel.call("POST", `api/accounts/${id}/runs`)).status, 202);
    }
    const [fail, timeout, crash] = await finished;
    assert.deepStrictEqual([fail.status, fail.error], ["failed", `模拟的页面错误 ${SECRET_MASK}`]);
    assert.strictEqual(runFiles(panel, "fail-1", fail.id).meta().error, `模拟的页面错误 ${SECRET_MASK}`);
    assert.deepStrictEqual([timeout.status, timeout.error], ["failed", "等待扫码超时"]);
    assert.deepStrictEqual([crash.status, crash.error], ["failed", "阅读子进程异常退出（退出码 3）"]);
    assert.strictEqual(runFiles(panel, "crash-1", crash.id).meta().exitCode, 3);
  });

  await scenario("停止：子进程收到 SIGTERM 后退出记为已停止；不响应时超时强制结束；两种情况都删除 Selenium 会话", async () => {
    const selenium = await startMockSelenium();
    try {
      const panel = await startAuthed();
      await panel.call("PATCH", "api/settings", {
        settings: { maxConcurrentRuns: 2 },
        defaults: { seleniumUrl: selenium.url },
      });
      const reading = Promise.all(
        ["slow-1", "stubborn-1"].map((id) => nextRun(panel, (run) => run.accountId === id && run.status === "reading"))
      );
      for (const id of ["slow-1", "stubborn-1"]) {
        await panel.call("POST", "api/accounts", { id });
        await panel.call("POST", `api/accounts/${id}/runs`);
      }
      await reading;

      const slowEnded = nextRun(panel, ended("slow-1"));
      const stopping = await panel.call("POST", "api/accounts/slow-1/stop");
      assert.strictEqual(stopping.status, 202);
      assert.strictEqual(stopping.json.run.stopRequested, true);
      const slow = await slowEnded;
      assert.strictEqual(slow.status, "stopped");
      const slowLog = await runFiles(panel, "slow-1", slow.id).log();
      assert.match(slowLog, /收到 SIGTERM，关闭浏览器/);
      // 正常退出的子进程通常已经关闭了浏览器，仍请求删除一次会话：关闭浏览器失败时会话也不会残留
      assert.match(slowLog, /已请求 Selenium 删除会话 stub-session-slow-1（HTTP 200）/);

      const stubbornEnded = nextRun(panel, ended("stubborn-1"));
      await panel.call("POST", "api/accounts/stubborn-1/stop");
      const stubborn = await stubbornEnded;
      assert.strictEqual(stubborn.status, "stopped");
      const files = runFiles(panel, "stubborn-1", stubborn.id);
      assert.strictEqual(files.meta().exitSignal, "SIGKILL");
      const log = await files.log();
      assert.match(log, /忽略 SIGTERM/);
      assert.match(log, /秒内未退出，强制结束/);
      assert.match(log, /已请求 Selenium 删除会话 stub-session-stubborn-1/);
      // 顺序是确定的：面板删除会话后才把 slow-1 记为结束，上面等到它结束后才停止 stubborn-1
      assert.deepStrictEqual(selenium.requests, ["DELETE /session/stub-session-slow-1", "DELETE /session/stub-session-stubborn-1"]);
      assert.strictEqual(selenium.state.sessionAuthorization, "");

      // Selenium 地址带用户名与密码时，删除会话改用 Authorization 请求头
      await panel.call("PATCH", "api/settings", {
        defaults: { seleniumUrl: selenium.url.replace("://", "://robot:p%40ss@") },
      });
      const authReading = nextRun(panel, (run) => run.accountId === "stubborn-2" && run.status === "reading");
      await panel.call("POST", "api/accounts", { id: "stubborn-2" });
      await panel.call("POST", "api/accounts/stubborn-2/runs");
      await authReading;
      const authEnded = nextRun(panel, ended("stubborn-2"));
      await panel.call("POST", "api/accounts/stubborn-2/stop");
      const authRun = await authEnded;
      assert.match(await runFiles(panel, "stubborn-2", authRun.id).log(), /已请求 Selenium 删除会话 stub-session-stubborn-2（HTTP 200）/);
      assert.strictEqual(selenium.requests.at(-1), "DELETE /session/stub-session-stubborn-2");
      assert.strictEqual(selenium.state.sessionAuthorization, `Basic ${Buffer.from("robot:p@ss").toString("base64")}`);

      const idle = await panel.call("POST", "api/accounts/slow-1/stop");
      assert.strictEqual(idle.status, 404);
      assert.strictEqual(idle.json.error, "run_not_active");
    } finally {
      await selenium.close();
    }
  });

  await scenario("仅登录：等待扫码时提供登录链接，登录后清除；运行记录不保存登录链接", async () => {
    const panel = await startAuthed();
    await panel.call("POST", "api/accounts", { id: "login-1" });
    const waiting = nextRun(panel, (run) => run.accountId === "login-1" && run.status === "waiting-login");
    const finished = nextRun(panel, ended("login-1"));
    const res = await panel.call("POST", "api/accounts/login-1/runs", { mode: "login" });
    assert.strictEqual(res.json.run.mode, "login");
    assert.strictEqual((await waiting).loginUrl, "https://weread.qq.com/web/confirm?uid=login-1");
    const run = await finished;
    assert.strictEqual(run.status, "success");
    assert.strictEqual(run.loginUrl, "");
    assert.strictEqual(run.plannedMinutes, 0);
    const files = runFiles(panel, "login-1", run.id);
    await files.log();
    assert.ok(!fs.readFileSync(path.join(files.dir, "meta.json"), "utf8").includes("confirm?uid"));
  });

  await scenario("二维码解析不出登录链接时提供这次运行的二维码截图；没有等待扫码时返回 404；面板地址下发给子进程", async () => {
    const panel = await startAuthed({ publicUrl: "https://example.com/weread/" });
    await panel.call("POST", "api/accounts", { id: "qrimg-1" });
    // 之前运行留下的截图不返回
    const stale = path.join(panel.options.dataDir, "accounts", "qrimg-1", "login.png");
    fs.writeFileSync(stale, "old");
    fs.utimesSync(stale, new Date(Date.now() - 3600000), new Date(Date.now() - 3600000));
    assert.strictEqual((await panel.call("GET", "api/accounts/qrimg-1/login-qr")).status, 404);
    const waiting = nextRun(panel, (run) => run.accountId === "qrimg-1" && run.status === "waiting-login");
    await panel.call("POST", "api/accounts/qrimg-1/runs", { mode: "login" });
    const run = await waiting;
    assert.strictEqual(run.loginUrl, "");
    assert.ok(run.loginQrAt);
    const image = await panel.call("GET", "api/accounts/qrimg-1/login-qr");
    assert.strictEqual(image.status, 200);
    assert.strictEqual(image.headers.get("content-type"), "image/png");
    assert.strictEqual(image.headers.get("cache-control"), "no-store");
    assert.strictEqual((await panel.request("api/accounts/qrimg-1/login-qr")).status, 401);
    assert.strictEqual((await panel.call("GET", "api/accounts/nobody/login-qr")).status, 404);
    // 之后只更新了整页截图（例如刷新后二维码图片还没加载）：不再返回旧的二维码区域截图
    const later = new Date(Date.now() + 5000);
    fs.writeFileSync(stale, "page");
    fs.utimesSync(stale, later, later);
    const pageImage = await panel.call("GET", "api/accounts/qrimg-1/login-qr");
    assert.strictEqual(pageImage.text, "page");
    const finished = nextRun(panel, ended("qrimg-1"));
    await panel.call("POST", "api/accounts/qrimg-1/stop");
    await finished;
    assert.match(await runFiles(panel, "qrimg-1", run.id).log(), /panelLink=https:\/\/example\.com\/weread\/#\/accounts\/qrimg-1\/live/);
    assert.strictEqual((await panel.call("GET", "api/accounts/qrimg-1/login-qr")).status, 404);
    assert.ok(!("loginQrAt" in runFiles(panel, "qrimg-1", run.id).meta()));
  });

  await scenario("进度跳过的分钟按时间均匀补记；分钟数不超过本次阅读时长（含 1 分钟余量）", async () => {
    const panel = await startAuthed();
    await panel.call("POST", "api/accounts", { id: "skip-1" });
    await panel.call("PATCH", "api/accounts/skip-1", { overrides: { duration: 5 } });
    const finished = nextRun(panel, ended("skip-1"));
    await panel.call("POST", "api/accounts/skip-1/runs");
    const run = await finished;
    assert.strictEqual(run.minutes, 6);
    const marks = runFiles(panel, "skip-1", run.id).meta().minuteMarks.map((mark) => Date.parse(mark));
    assert.strictEqual(marks.length, 6);
    // 第 2–4 分钟在第 1 分钟与第 5 分钟之间，各不相同
    assert.ok(marks[0] < marks[1] && marks[1] < marks[2] && marks[2] < marks[3] && marks[3] < marks[4], "补记的分钟应递增");
    assert.ok(marks.every((mark, i) => i === 0 || mark >= marks[i - 1]));
  });

  await scenario("超过运行时长上限时结束子进程并记为失败", async () => {
    const panel = await startAuthed({ runner: { workerPath: STUB_WORKER, killTimeoutMs: 500, runTimeoutMs: 300 } });
    await panel.call("POST", "api/accounts", { id: "hang-1" });
    const finished = nextRun(panel, ended("hang-1"));
    await panel.call("POST", "api/accounts/hang-1/runs");
    const run = await finished;
    assert.deepStrictEqual([run.status, run.error], ["failed", "运行超时，已强制结束"]);
  });

  await scenario("停止后、子进程退出前到达运行时长上限时仍记为已停止", async () => {
    const panel = await startAuthed({ runner: { workerPath: STUB_WORKER, killTimeoutMs: 1500, runTimeoutMs: 1000 } });
    await panel.call("POST", "api/accounts", { id: "stubborn-1" });
    const reading = nextRun(panel, (run) => run.accountId === "stubborn-1" && run.status === "reading");
    await panel.call("POST", "api/accounts/stubborn-1/runs");
    await reading;
    const finished = nextRun(panel, ended("stubborn-1"));
    await panel.call("POST", "api/accounts/stubborn-1/stop");
    const run = await finished;
    assert.deepStrictEqual([run.status, run.error], ["stopped", ""]);
    assert.strictEqual(runFiles(panel, "stubborn-1", run.id).meta().exitSignal, "SIGKILL");
  });

  await scenario("启动运行出错时记为失败并释放账号，不会一直排队", async () => {
    const panel = await startAuthed();
    await panel.call("POST", "api/accounts", { id: "broken-1" });
    // 账号数据目录被同名文件占用，启动时无法创建
    const dir = path.join(panel.options.dataDir, "accounts", "broken-1");
    fs.rmSync(dir, { recursive: true, force: true });
    fs.writeFileSync(dir, "not a directory");
    const res = await panel.call("POST", "api/accounts/broken-1/runs");
    assert.strictEqual(res.status, 202);
    assert.strictEqual(res.json.run.status, "failed");
    assert.match(res.json.run.error, /无法创建账号数据目录/);
    assert.deepStrictEqual((await panel.call("GET", "api/runs")).json.runs, []);
    assert.strictEqual((await panel.call("POST", "api/accounts/broken-1/runs")).json.run.status, "failed");
  });

  await scenario("面板停止时进行中与排队中的运行记为中断；启动时把遗留的进行中记录标为中断", async () => {
    const panel = await startAuthed();
    const reading = nextRun(panel, (run) => run.accountId === "slow-1" && run.status === "reading");
    for (const id of ["slow-1", "slow-2"]) {
      await panel.call("POST", "api/accounts", { id });
    }
    const first = (await panel.call("POST", "api/accounts/slow-1/runs")).json.run;
    const second = (await panel.call("POST", "api/accounts/slow-2/runs")).json.run;
    await reading;
    await panel.close();
    const firstMeta = runFiles(panel, "slow-1", first.id).meta();
    assert.deepStrictEqual([firstMeta.status, firstMeta.error], ["interrupted", "面板停止时运行被中断"]);
    const secondMeta = runFiles(panel, "slow-2", second.id).meta();
    assert.deepStrictEqual([secondMeta.status, secondMeta.error], ["interrupted", "面板停止时仍在排队"]);
    // close() 返回时运行日志已经写入磁盘，最后一行是结束原因
    for (const [accountId, run] of [["slow-1", first], ["slow-2", second]]) {
      const lines = fs.readFileSync(path.join(runFiles(panel, accountId, run.id).dir, "output.log"), "utf8").trim().split("\n");
      assert.match(lines.at(-1), /运行结束：中断/, accountId);
    }

    // 断电等情况下面板来不及处理，记录停留在进行中
    const leftover = runFiles(panel, "slow-1", "20261001T000000Z-abcd");
    fs.mkdirSync(leftover.dir, { recursive: true });
    fs.writeFileSync(path.join(leftover.dir, "meta.json"), JSON.stringify({ id: "20261001T000000Z-abcd", status: "reading", minutes: 7 }));
    fs.writeFileSync(path.join(leftover.dir, "output.log"), "");
    await start({ dataDir: panel.options.dataDir, password: "correct-horse" });
    const meta = leftover.meta();
    assert.deepStrictEqual([meta.status, meta.minutes], ["interrupted", 7]);
    assert.ok(meta.endedAt);
    assert.match(fs.readFileSync(path.join(leftover.dir, "output.log"), "utf8"), /标记为中断/);
    assert.strictEqual(runFiles(panel, "slow-1", first.id).meta().error, "面板停止时运行被中断", "已结束的记录不应改动");
  });

  await scenario("实时推送：需要登录；连接后先收到完整状态，之后收到运行状态与日志；会话失效后断开", async () => {
    const panel = await startAuthed();
    assert.strictEqual((await panel.request("api/events")).status, 401);
    await panel.call("POST", "api/accounts", { id: "ok-1" });

    const stream = await openEvents(panel.port, panel.cookie);
    assert.strictEqual(stream.status, 200);
    assert.match(stream.headers.get("content-type"), /^text\/event-stream/);
    assert.strictEqual(stream.headers.get("cache-control"), "no-cache");
    assert.strictEqual(stream.headers.get("x-accel-buffering"), "no");
    await until(() => stream.events.some((event) => event.event === "snapshot"));
    assert.deepStrictEqual(stream.events.find((event) => event.event === "snapshot").data, { runs: [] });

    await panel.call("POST", "api/accounts/ok-1/runs");
    await until(() => stream.events.some((event) => event.event === "run" && event.data.status === "success"));
    await until(() => stream.events.some((event) => event.event === "log" && event.data.line.includes("Reading minute: 2")));
    const logEvent = stream.events.find((event) => event.event === "log");
    assert.strictEqual(logEvent.data.accountId, "ok-1");
    const leak = stream.events.find((event) => event.event === "log" && event.data.line.includes("模拟泄露"));
    assert.ok(leak && !leak.data.line.includes("ok-1-uid") && leak.data.line.includes(`uid=${SECRET_MASK}`), "推送的日志同样替换掩码");
    await until(() => stream.events.some((event) => event.event === "ping"), { message: "没有收到心跳" });

    // 进行中的运行带最近的日志，供中途连接时显示
    await panel.call("POST", "api/accounts", { id: "slow-1" });
    const reading = nextRun(panel, (run) => run.accountId === "slow-1" && run.status === "reading");
    await panel.call("POST", "api/accounts/slow-1/runs");
    await reading;
    const late = await openEvents(panel.port, panel.cookie);
    await until(() => late.events.some((event) => event.event === "snapshot"));
    const [snapshotRun] = late.events.find((event) => event.event === "snapshot").data.runs;
    assert.strictEqual(snapshotRun.status, "reading");
    assert.ok(snapshotRun.log.some((line) => line.includes("启动阅读子进程")));

    assert.strictEqual((await panel.call("POST", "api/auth/logout")).status, 204);
    await Promise.race([
      Promise.all([stream.closed, late.closed]),
      new Promise((_, reject) => setTimeout(() => reject(new Error("退出登录后推送连接没有断开")), 3000)),
    ]);
    const finished = nextRun(panel, ended("slow-1"));
    panel.runner.stop("slow-1");
    await finished;
  });

  await scenario("实时推送：退出登录、修改密码时立即断开，不等心跳；其他会话的连接不受退出登录影响", async () => {
    // 心跳间隔设得很长，确保断开来自会话结束而不是心跳检查
    // 密码来自环境变量时不能修改，这里使用首次启动生成的密码
    const panel = await start({ sseHeartbeatMs: 60000 });
    const password = panel.generatedPassword;
    const myCookie = sessionCookie(await login(panel, password));
    const other = sessionCookie(await login(panel, password));
    const mine = await openEvents(panel.port, myCookie);
    const theirs = await openEvents(panel.port, other);
    await until(() => mine.events.length > 0 && theirs.events.length > 0);
    const closedWithin = (stream, ms, message) =>
      Promise.race([
        stream.closed,
        new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms)),
      ]);
    let theirsClosed = false;
    theirs.closed.then(() => {
      theirsClosed = true;
    });

    const logout = await panel.request("api/auth/logout", { method: "POST", cookie: myCookie, headers: CSRF });
    assert.strictEqual(logout.status, 204);
    await closedWithin(mine, 1000, "退出登录后推送连接没有立即断开");
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.strictEqual(theirsClosed, false, "其他会话的连接不应断开");

    const changed = await panel.request("api/auth/password", {
      method: "POST",
      cookie: other,
      headers: CSRF,
      body: { current: password, next: "battery-staple" },
    });
    assert.strictEqual(changed.status, 204);
    await closedWithin(theirs, 1000, "修改密码后旧会话的推送连接没有立即断开");

    // 会话已失效时直接返回 401，不建立连接
    assert.strictEqual((await panel.request("api/events", { cookie: other })).status, 401);
  });

  await scenario("升级前创建的运行记录目录在启动时收紧为 0700", async () => {
    const dataDir = tempDir();
    const oldRun = path.join(dataDir, "runs", "old-1", "20261001T000000Z-abcd");
    fs.mkdirSync(oldRun, { recursive: true, mode: 0o755 });
    fs.chmodSync(path.join(dataDir, "runs"), 0o755);
    fs.chmodSync(path.join(dataDir, "runs", "old-1"), 0o755);
    fs.writeFileSync(path.join(oldRun, "output.log"), "old\n", { mode: 0o644 });
    await start({ dataDir, password: "correct-horse" });
    for (const dir of ["runs", path.join("runs", "old-1")]) {
      assert.strictEqual(fs.statSync(path.join(dataDir, dir)).mode & 0o777, 0o700, dir);
    }
  });
};
