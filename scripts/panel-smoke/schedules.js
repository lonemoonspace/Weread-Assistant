// 面板 smoke：调度规则、调度接口、调度器与定时触发

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const { describeSchedule, nextRuns, normalizeSchedules, schedulePatterns } = require(path.resolve(__dirname, "..", "..", "src", "panel", "schedules"));
const { CSRF, tempDir, until, nextRun, runFiles, sessionCookie } = require("./helpers");

module.exports = async function schedulesScenarios({ scenario, start, login, startAuthed }) {
  await scenario("调度规则：换算为 cron 表达式，按面板时区计算接下来的触发时间（含夏令时）", async () => {
    const from = new Date("2026-10-16T00:00:00Z");
    const [daily, interval, hourly, cron] = normalizeSchedules([
      { type: "daily", times: ["18:30", "06:00", "06:00"] },
      { type: "interval", hours: 6, minute: 30 },
      { type: "interval", hours: 1 },
      { type: "cron", expression: "  30 6 *  * 1-5 " },
    ]);
    assert.deepStrictEqual(daily.times, ["06:00", "18:30"], "时间去重并排序");
    assert.deepStrictEqual(schedulePatterns(daily), ["0 6 * * *", "30 18 * * *"]);
    assert.deepStrictEqual(schedulePatterns(interval), ["30 */6 * * *"]);
    assert.deepStrictEqual([hourly.minute, schedulePatterns(hourly)], [0, ["0 * * * *"]]);
    assert.deepStrictEqual(schedulePatterns(cron), ["30 6 * * 1-5"]);
    assert.ok([daily, interval, hourly, cron].every((rule) => /^[0-9a-f]{6}$/.test(rule.id) && rule.enabled));

    // 上海时间：每天 06:00、18:30 合并排序
    assert.deepStrictEqual(nextRuns(daily, { timezone: "Asia/Shanghai", from, count: 3 }), [
      "2026-10-16T10:30:00.000Z",
      "2026-10-16T22:00:00.000Z",
      "2026-10-17T10:30:00.000Z",
    ]);
    // 每 6 小时从 00:30 起：上海时间 12:30、18:30、00:30、06:30
    assert.deepStrictEqual(nextRuns(interval, { timezone: "Asia/Shanghai", from, count: 4 }), [
      "2026-10-16T04:30:00.000Z",
      "2026-10-16T10:30:00.000Z",
      "2026-10-16T16:30:00.000Z",
      "2026-10-16T22:30:00.000Z",
    ]);
    // 纽约 2026-03-08 开始夏令时：每天 06:00 对应的 UTC 时间从 11:00 变为 10:00
    const sixAm = normalizeSchedules([{ type: "daily", times: ["06:00"] }])[0];
    assert.deepStrictEqual(nextRuns(sixAm, { timezone: "America/New_York", from: new Date("2026-03-06T12:00:00Z"), count: 3 }), [
      "2026-03-07T11:00:00.000Z",
      "2026-03-08T10:00:00.000Z",
      "2026-03-09T10:00:00.000Z",
    ]);
    // 周一至周五：2026-10-17、18 是周末
    assert.deepStrictEqual(nextRuns(cron, { timezone: "Asia/Shanghai", from: new Date("2026-10-16T12:00:00Z"), count: 2 }), [
      "2026-10-18T22:30:00.000Z",
      "2026-10-19T22:30:00.000Z",
    ]);
    assert.strictEqual(describeSchedule(daily), "每天 06:00、18:30");
    assert.strictEqual(describeSchedule(interval), "每 6 小时（从 00:30 起）");
  });

  await scenario("调度接口：校验规则、保存后返回接下来的触发时间、预览不保存", async () => {
    const panel = await startAuthed();
    await panel.call("POST", "api/accounts", { id: "me" });
    const put = (schedules) => panel.call("PUT", "api/accounts/me/schedules", { schedules });

    const invalid = [
      [{ type: "weekly" }, /类型只能是 daily、interval、cron/],
      [{ type: "daily", times: [] }, /需要 1–24 个时间/],
      [{ type: "daily", times: ["6:00"] }, /时间格式应为 HH:MM/],
      [{ type: "daily", times: ["24:00"] }, /时间格式应为 HH:MM/],
      [{ type: "interval", hours: 5 }, /间隔小时数只能是 1、2、3、4、6、8、12：5/],
      [{ type: "interval", hours: 6, minute: 60 }, /分钟必须是 0–59 的整数/],
      [{ type: "cron", expression: "0 6 * *" }, /必须是 5 段/],
      [{ type: "cron", expression: "*/5 * * * * *" }, /必须是 5 段/],
      [{ type: "cron", expression: "@daily" }, /必须是 5 段/],
      [{ type: "cron", expression: "61 * * * *" }, /cron 表达式无效/],
      [{ type: "cron", expression: "0 0 30 2 *" }, /不会触发/],
      [{ type: "daily", times: ["06:00"], extra: 1 }, /不支持的字段：extra/],
      [{ type: "daily", times: ["06:00"], enabled: "yes" }, /enabled 必须是 true 或 false/],
      [{ type: "daily", times: ["06:00"], id: "Bad ID" }, /ID 只能包含小写字母与数字/],
    ];
    for (const [rule, pattern] of invalid) {
      const res = await put([{ type: "daily", times: ["07:00"] }, rule]);
      assert.strictEqual(res.status, 400, JSON.stringify(rule));
      assert.match(res.json.message, /^第 2 条规则/);
      assert.match(res.json.message, pattern);
    }
    assert.strictEqual((await put("daily")).status, 400);
    assert.match((await put(Array.from({ length: 11 }, () => ({ type: "interval", hours: 1 })))).json.message, /最多 10 条/);
    assert.strictEqual((await panel.call("PUT", "api/accounts/me/schedules", { schedules: [], x: 1 })).status, 400);
    assert.deepStrictEqual((await panel.call("GET", "api/accounts/me/schedules")).json.schedules, [], "校验失败时不保存");

    const saved = await put([
      { id: "morning", type: "daily", times: ["06:00"] },
      { type: "interval", hours: 8, minute: 15, enabled: false },
      { id: "morning", type: "cron", expression: "0 12 * * *" },
    ]);
    assert.strictEqual(saved.status, 200);
    assert.strictEqual(saved.json.timezone, "Asia/Shanghai");
    const [morning, off, noon] = saved.json.schedules;
    assert.strictEqual(morning.id, "morning", "保留提交的 ID");
    assert.ok(noon.id !== "morning" && /^[0-9a-f]{6}$/.test(noon.id), "重复的 ID 重新分配");
    assert.strictEqual(morning.description, "每天 06:00");
    assert.strictEqual(morning.nextRuns.length, 5);
    assert.ok(morning.nextRuns.every((time) => new Date(time).getUTCHours() === 22 && Date.parse(time) > Date.now()));
    assert.deepStrictEqual(off.nextRuns, [], "停用的规则没有触发时间");
    assert.strictEqual(saved.json.nextRunAt, [morning.nextRuns[0], noon.nextRuns[0]].sort()[0]);

    const account = (await panel.call("GET", "api/accounts/me")).json.account;
    assert.deepStrictEqual(account.schedules.map((rule) => rule.id), ["morning", off.id, noon.id]);
    assert.strictEqual(account.nextRunAt, saved.json.nextRunAt);
    await panel.call("PATCH", "api/accounts/me", { enabled: false });
    assert.strictEqual((await panel.call("GET", "api/accounts/me/schedules")).json.nextRunAt, null, "停用的账号没有下一次运行");

    const preview = await panel.call("POST", "api/schedules/preview", { schedules: [{ type: "daily", times: ["23:59"] }] });
    assert.strictEqual(preview.status, 200);
    assert.strictEqual(preview.json.schedules[0].nextRuns.length, 5);
    assert.strictEqual((await panel.call("POST", "api/schedules/preview", { schedules: [{ type: "interval", hours: 7 }] })).status, 400);
    assert.strictEqual((await panel.call("GET", "api/accounts/me/schedules")).json.schedules.length, 3, "预览不保存");

    assert.strictEqual((await panel.call("PUT", "api/accounts/nobody/schedules", { schedules: [] })).status, 404);
    assert.strictEqual((await panel.request("api/accounts/me/schedules")).status, 401);
    const noCsrf = await panel.request("api/accounts/me/schedules", { method: "PUT", cookie: panel.cookie, body: { schedules: [] } });
    assert.strictEqual(noCsrf.status, 403);
  });

  await scenario("调度器：规则、账号启用状态与时区变化后立即重建定时任务；删除账号后移除", async () => {
    const panel = await startAuthed();
    const jobs = () => panel.scheduler.jobs().map((job) => `${job.accountId}/${job.ruleId}/${job.pattern}`).sort();
    await panel.call("POST", "api/accounts", { id: "me" });
    await panel.call("POST", "api/accounts", { id: "other" });
    const rules = [
      { id: "daily", type: "daily", times: ["06:00", "18:00"] },
      { id: "every6", type: "interval", hours: 6 },
    ];
    await panel.call("PUT", "api/accounts/me/schedules", { schedules: rules });
    await panel.call("PUT", "api/accounts/other/schedules", { schedules: [{ id: "noon", type: "cron", expression: "0 12 * * *" }] });
    assert.deepStrictEqual(jobs(), ["me/daily/0 18 * * *", "me/daily/0 6 * * *", "me/every6/0 */6 * * *", "other/noon/0 12 * * *"]);
    const sixAm = () => panel.scheduler.jobs().find((job) => job.pattern === "0 6 * * *").nextRun;
    assert.strictEqual(new Date(sixAm()).getUTCHours(), 22, "上海时间 06:00 为 UTC 22:00");

    await panel.call("PUT", "api/accounts/me/schedules", { schedules: [rules[0], { ...rules[1], enabled: false }] });
    assert.deepStrictEqual(jobs(), ["me/daily/0 18 * * *", "me/daily/0 6 * * *", "other/noon/0 12 * * *"], "停用的规则不调度");

    await panel.call("PATCH", "api/accounts/me", { enabled: false });
    assert.deepStrictEqual(jobs(), ["other/noon/0 12 * * *"], "停用的账号不调度");
    await panel.call("PATCH", "api/accounts/me", { enabled: true });
    assert.strictEqual(jobs().length, 3);

    await panel.call("PATCH", "api/settings", { settings: { timezone: "Europe/London" } });
    assert.ok([5, 6].includes(new Date(sixAm()).getUTCHours()), "改为伦敦时区后 06:00 对应 UTC 05:00 或 06:00");

    await panel.call("DELETE", "api/accounts/other");
    assert.deepStrictEqual(jobs(), ["me/daily/0 18 * * *", "me/daily/0 6 * * *"]);
    await panel.close();
    assert.deepStrictEqual(panel.scheduler.jobs(), [], "面板停止后不再调度");
  });

  await scenario("定时触发：到点后以定时方式加入队列；账号已在运行或排队时跳过并记录日志；无效规则跳过", async (logs) => {
    // 直接写入 panel.json：每秒触发一次（6 段 cron 只能手工写入，接口只接受 5 段），以及一条无效规则
    const dataDir = tempDir();
    fs.writeFileSync(
      path.join(dataDir, "panel.json"),
      JSON.stringify({
        version: 1,
        auth: { passwordHash: "" },
        accounts: [
          {
            id: "slow-1",
            name: "定时",
            enabled: true,
            createdAt: new Date().toISOString(),
            overrides: {},
            schedules: [
              { id: "tick", type: "cron", expression: "* * * * * *", enabled: true },
              { id: "broken", type: "cron", expression: "not a cron", enabled: true },
              { id: "notimes", type: "daily", enabled: true },
            ],
          },
        ],
      }),
      { mode: 0o600 }
    );
    const panel = await start({ dataDir, password: "correct-horse" });
    const cookie = sessionCookie(await login(panel, "correct-horse"));
    assert.ok(logs.some((line) => line.includes("跳过无效的调度规则：账号 slow-1，规则 broken")));

    const started = await nextRun(panel, (run) => run.accountId === "slow-1" && run.status === "reading", 5000);
    assert.deepStrictEqual([started.trigger, started.scheduleId], ["schedule", "tick"]);
    await until(() => logs.some((line) => /定时触发跳过：账号 slow-1，规则 tick（cron \* \* \* \* \* \*）：账号已在运行或排队/.test(line)), {
      timeoutMs: 5000,
      message: "运行中再次触发时应跳过并记录日志",
    });
    assert.ok(logs.some((line) => line.startsWith(`定时触发：账号 slow-1，规则 tick（cron * * * * * *），运行 ${started.id}`)));
    assert.strictEqual(panel.runner.list().length, 1, "同一账号只有一个运行");

    // 无效规则在接口中没有触发时间，不影响读取；缺少字段的规则说明为“无效规则”，账号列表照常返回
    const account = await panel.request("api/accounts/slow-1", { cookie });
    assert.deepStrictEqual(account.json.account.schedules.find((rule) => rule.id === "broken").nextRuns, []);
    const notimes = account.json.account.schedules.find((rule) => rule.id === "notimes");
    assert.deepStrictEqual([notimes.description, notimes.nextRuns], ["无效规则（daily）", []]);
    assert.strictEqual((await panel.request("api/accounts", { cookie })).status, 200);
    assert.strictEqual((await panel.request("api/accounts/slow-1/schedules", { cookie })).status, 200);

    const ended = nextRun(panel, (run) => run.id === started.id && Boolean(run.endedAt));
    await panel.request("api/accounts/slow-1/schedules", { method: "PUT", cookie, headers: CSRF, body: { schedules: [] } });
    panel.runner.stop("slow-1");
    await ended;
    const files = runFiles(panel, "slow-1", started.id);
    assert.deepStrictEqual([files.meta().trigger, files.meta().scheduleId], ["schedule", "tick"]);
    assert.match(await files.log(), /加入队列：定时触发（规则 tick），阅读/);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    assert.deepStrictEqual(panel.runner.list(), [], "规则删除后不再触发");
  });
};
