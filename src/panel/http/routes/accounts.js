const fs = require("fs");
const path = require("path");
const express = require("express");
const { dirSize } = require("../../../reader/profile");
const { createAccount, deleteAccount, findAccount, publicAccount, updateAccount } = require("../../accounts");
const { accountDataDir, publicEffectiveConfig, resolveAccountConfig } = require("../../config");
const { PanelError, badRequest, requireObject } = require("../../errors");
const { normalizeGoal, publicGoal } = require("../../goal");
const { lastRun } = require("../../history");
const { accountStreak, calendar, challengeProgress, todayStats } = require("../../stats");
const { nextRunInfo, normalizeSchedules, publicSchedule } = require("../../schedules");

// 浏览器资料目录大小的缓存时间
const PROFILE_SIZE_CACHE_MS = 60000;

// 账号的增删改查、调度规则、每日目标、打卡日历与等待扫码时的二维码截图
function accountRoutes({ dataDir, store, runner, planner }) {
  // 计划器中该账号的待办（重试、随机延后的定时运行）与今天的补跑次数
  const plannedView = (accountId, timezone) => (planner ? planner.accountStatus(accountId, timezone) : null);
  // 账号信息附带今天的阅读分钟数、最近一次运行与计划器的待办，供总览使用
  const accountView = (account, timezone = store.get().settings.timezone) => ({
    ...publicAccount(account, dataDir, timezone),
    today: todayStats(dataDir, account.id, { timezone }),
    streak: accountStreak(dataDir, account.id, { timezone }),
    lastRun: lastRun(dataDir, account.id),
    planned: plannedView(account.id, timezone),
  });
  const schedulesView = (account, timezone) => {
    const next = nextRunInfo(account, timezone);
    return {
      timezone,
      enabled: account.enabled,
      nextRunAt: next ? next.at : null,
      nextRunJitterMinutes: next ? next.jitterMinutes : 0,
      schedules: account.schedules.map((rule) => publicSchedule(rule, timezone)),
    };
  };
  const goalView = (account, timezone) => ({
    timezone,
    ...publicGoal(account.goal, account.challenge),
    today: todayStats(dataDir, account.id, { timezone }),
    planned: plannedView(account.id, timezone),
  });
  const schedulesFromBody = (body) => {
    const unknown = Object.keys(requireObject(body)).filter((key) => key !== "schedules");
    if (unknown.length > 0) {
      throw badRequest(`未知的字段：${unknown.join(", ")}`);
    }
    return normalizeSchedules(body.schedules);
  };
  const profileDirOf = (accountId) => path.join(accountDataDir(dataDir, accountId), "profile");
  // 浏览器资料目录是否存在与占用的大小（含重置时留下的 profile.broken）。统计大小要遍历整个目录，
  // 结果缓存一分钟，重置后立即失效；页面上的大小只是参考
  const sizeCache = new Map();
  const cachedSize = (dir) => {
    const hit = sizeCache.get(dir);
    if (hit && Date.now() - hit.at < PROFILE_SIZE_CACHE_MS) {
      return hit.bytes;
    }
    const bytes = dirSize(dir) + dirSize(`${dir}.broken`);
    sizeCache.set(dir, { at: Date.now(), bytes });
    return bytes;
  };
  const profileView = (accountId) => {
    const dir = profileDirOf(accountId);
    return { exists: fs.existsSync(dir), broken: fs.existsSync(`${dir}.broken`), bytes: cachedSize(dir) };
  };
  const router = express.Router();

  router.get("/accounts", (req, res) => {
    const data = store.get();
    res.json({ accounts: data.accounts.map((account) => accountView(account, data.settings.timezone)) });
  });

  router.post("/accounts", async (req, res) => {
    const account = await createAccount(store, dataDir, requireObject(req.body));
    console.info("新建账号:", account.id);
    res.status(201).json({ account: accountView(account) });
  });

  // 账号详情与实际生效的配置（账号覆盖 > 全局默认 > 内置默认）
  router.get("/accounts/:id", (req, res) => {
    const data = store.get();
    const account = findAccount(data, req.params.id);
    res.json({
      account: accountView(account, data.settings.timezone),
      challengeProgress: challengeProgress(dataDir, account, { timezone: data.settings.timezone }),
      effective: publicEffectiveConfig(resolveAccountConfig(data, account, dataDir)),
      profile: profileView(account.id),
    });
  });

  // 重置浏览器资料：删除账号的浏览器资料目录，下次运行从 cookies.json 恢复登录。账号正在运行或排队时拒绝
  router.delete("/accounts/:id/profile", (req, res) => {
    findAccount(store.get(), req.params.id);
    if (runner.isActive(req.params.id)) {
      throw new PanelError(409, "account_busy", "账号正在运行或排队，请先停止再重置浏览器资料");
    }
    const dir = profileDirOf(req.params.id);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(`${dir}.broken`, { recursive: true, force: true });
    sizeCache.delete(dir);
    console.info("已重置浏览器资料:", req.params.id);
    res.json({ profile: profileView(req.params.id) });
  });

  router.patch("/accounts/:id", async (req, res) => {
    const account = await updateAccount(store, req.params.id, requireObject(req.body));
    res.json({ account: accountView(account) });
  });

  // { deleteData?: boolean }：默认保留账号数据目录；账号正在运行或排队时拒绝删除
  router.delete("/accounts/:id", async (req, res) => {
    const body = req.body === undefined ? {} : requireObject(req.body);
    await deleteAccount(store, dataDir, req.params.id, {
      deleteData: body.deleteData === true,
      isBusy: (id) => runner.isActive(id),
    });
    console.info("删除账号:", req.params.id, body.deleteData === true ? "（同时删除数据）" : "");
    res.status(204).end();
  });

  // 账号的调度规则、每条规则接下来的触发时间与账号下一次定时运行的时间
  router.get("/accounts/:id/schedules", (req, res) => {
    const data = store.get();
    res.json(schedulesView(findAccount(data, req.params.id), data.settings.timezone));
  });

  // { schedules: [...] }：整体替换账号的调度规则，保存后立即生效
  router.put("/accounts/:id/schedules", async (req, res) => {
    const schedules = schedulesFromBody(req.body);
    const data = await store.update((draft) => {
      findAccount(draft, req.params.id).schedules = schedules;
    });
    console.info(`调度规则已更新：账号 ${req.params.id}，${schedules.length} 条`);
    res.json(schedulesView(findAccount(data, req.params.id), data.settings.timezone));
  });

  // 每日目标：目标设置、按挑战的建议值、检查时间太晚时的提示、今天的分钟数与补跑次数
  router.get("/accounts/:id/goal", (req, res) => {
    const data = store.get();
    res.json(goalView(findAccount(data, req.params.id), data.settings.timezone));
  });

  // { goal: { enabled, minutes, checkAt } | null }：保存每日目标，null 表示不设置
  router.put("/accounts/:id/goal", async (req, res) => {
    const body = requireObject(req.body);
    const unknown = Object.keys(body).filter((key) => key !== "goal");
    if (unknown.length > 0 || body.goal === undefined) {
      throw badRequest("只能提交 { goal: {...} | null }");
    }
    const goal = normalizeGoal(body.goal);
    const data = await store.update((draft) => {
      findAccount(draft, req.params.id).goal = goal;
    });
    console.info(`每日目标已更新：账号 ${req.params.id}，${goal ? `${goal.enabled ? "" : "（未启用）"}${goal.minutes} 分钟，${goal.checkAt} 检查` : "不设置"}`);
    res.json(goalView(findAccount(data, req.params.id), data.settings.timezone));
  });

  // { schedules: [...] }：校验规则并预览接下来的触发时间，不保存
  router.post("/schedules/preview", (req, res) => {
    const { timezone } = store.get().settings;
    res.json({ timezone, schedules: schedulesFromBody(req.body).map((rule) => publicSchedule(rule, timezone)) });
  });

  // 等待扫码时的二维码截图，二维码解析不出登录链接时页面用它代替本地生成的二维码
  router.get("/accounts/:id/login-qr", (req, res) => {
    findAccount(store.get(), req.params.id);
    const image = runner.loginQrImage(req.params.id);
    if (!image) {
      throw new PanelError(404, "login_qr_not_found", "当前没有等待扫码的二维码截图");
    }
    res.set("Content-Type", "image/png");
    res.sendFile(image.name, { root: image.dir });
  });

  // 打卡日历：?month=YYYY-MM（默认本月，按面板时区）
  router.get("/accounts/:id/calendar", (req, res) => {
    const data = store.get();
    const account = findAccount(data, req.params.id);
    res.json(calendar(dataDir, account, { timezone: data.settings.timezone, month: req.query.month }));
  });

  return router;
}

module.exports = { accountRoutes };
