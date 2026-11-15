const express = require("express");
const { createAccount, deleteAccount, findAccount, publicAccount, updateAccount } = require("../../accounts");
const { publicEffectiveConfig, resolveAccountConfig } = require("../../config");
const { PanelError, badRequest, requireObject } = require("../../errors");
const { calendar, challengeProgress, lastRun, todayStats } = require("../../history");
const { nextRunAt, normalizeSchedules, publicSchedule } = require("../../schedules");

// 账号的增删改查、调度规则、打卡日历与等待扫码时的二维码截图
function accountRoutes({ dataDir, store, runner }) {
  // 账号信息附带今天的阅读分钟数与最近一次运行，供总览使用
  const accountView = (account, timezone = store.get().settings.timezone) => ({
    ...publicAccount(account, dataDir, timezone),
    today: todayStats(dataDir, account.id, { timezone }),
    lastRun: lastRun(dataDir, account.id),
  });
  const schedulesView = (account, timezone) => ({
    timezone,
    enabled: account.enabled,
    nextRunAt: nextRunAt(account, timezone),
    schedules: account.schedules.map((rule) => publicSchedule(rule, timezone)),
  });
  const schedulesFromBody = (body) => {
    const unknown = Object.keys(requireObject(body)).filter((key) => key !== "schedules");
    if (unknown.length > 0) {
      throw badRequest(`未知的字段：${unknown.join(", ")}`);
    }
    return normalizeSchedules(body.schedules);
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
    });
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
