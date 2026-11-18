const path = require("path");
const fs = require("fs");
const { createNotifier, getEnabledNotificationChannels } = require("../notify");
const { canSendEmail } = require("../notify/email");
const { OfficialApiError, createOfficialApi } = require("../official/api");
const { countNewNotes, fetchWeeklyReport, renderWeeklyReport } = require("../official/report");
const { writeFileAtomic } = require("../shared/files");
const { resolveAccountConfig } = require("./config");
const { badRequest } = require("./errors");
const { addDays, dateInZone, weekdayIndex } = require("./dates");

/**
 * 每周阅读报告：每周一到面板设置 weeklyReportAt（面板时区）之后，为开启了 notifyOnWeeklyReport、填写了微信读书 API Key 的启用账号
 * 读取上周的阅读统计，经通知渠道推送一次。已发送的周记在 reports.json 中，重启后不重复发送；
 * 周一没发出去（面板停机、接口出错）时，本周内之后的日子每天再试一次。也可以在账号配置中预览与立即发送。
 */

const TICK_MS = 60000;

const systemClock = {
  now: () => Date.now(),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (timer) => clearInterval(timer),
};

async function sendWeeklyReport(config, body, url = "") {
  const notifier = createNotifier(config);
  notifier.event("weeklyReport", body, url ? { url, actions: [{ action: "view", label: "打开面板", url, clear: true }] } : {});
  await notifier.flush();
}

// MM-DD
const monthDay = (date) => date.slice(5);

function createReportService({ dataDir, store, notes = null, officialOptions = {}, clock = systemClock, send = sendWeeklyReport, publicUrl = "" }) {
  const panelDataDir = path.resolve(dataDir);
  const file = path.join(panelDataDir, "reports.json");
  // 每个账号最近一次自动尝试的日期：失败后当天不再重试
  const attempted = new Map();
  const running = new Map();
  let tickTimer = null;

  function loadState() {
    try {
      const saved = JSON.parse(fs.readFileSync(file, "utf8"));
      if (saved && typeof saved === "object" && saved.sent && typeof saved.sent === "object") {
        return saved;
      }
    } catch (_) {
      // 没有或损坏：从头开始（最多重复发送一次上周的报告）
    }
    return { version: 1, sent: {} };
  }
  const state = loadState();

  function save() {
    try {
      writeFileAtomic(file, JSON.stringify(state, null, 2), { mode: 0o600 });
    } catch (e) {
      console.error(`保存 ${file} 失败:`, e.message);
    }
  }

  function configFor(accountId) {
    const data = store.get();
    const account = data.accounts.find((item) => item.id === accountId);
    if (!account) {
      return null;
    }
    try {
      return resolveAccountConfig(data, account, panelDataDir);
    } catch (_) {
      return null;
    }
  }

  // 面板时区中上周的周一
  function lastWeekStart() {
    const today = dateInZone(new Date(clock.now()), store.get().settings.timezone);
    return addDays(today, -weekdayIndex(today) - 7);
  }

  // 生成一个账号某一周（默认上周）的报告：{ weekStart, weekEnd, text, newNotes, current, previous }
  async function build(accountId, weekStart = lastWeekStart()) {
    const config = configFor(accountId);
    if (!config || !config.wereadApiKey) {
      throw new OfficialApiError("key", "这个账号还没有配置微信读书 API Key");
    }
    const api = createOfficialApi({ apiKey: config.wereadApiKey, ...officialOptions });
    const report = await fetchWeeklyReport(api, weekStart);
    const weekEnd = addDays(weekStart, 6);
    const books = notes ? notes.syncedBooks(accountId) : null;
    const newNotes = books ? countNewNotes(books, report.startSeconds) : null;
    const text = renderWeeklyReport(report, { weekLabel: `${monthDay(weekStart)} 至 ${monthDay(weekEnd)}`, newNotes });
    return { weekStart, weekEnd, text, newNotes, current: report.current, previous: report.previous, config };
  }

  const panelLink = (accountId) => (publicUrl ? new URL(`#/accounts/${encodeURIComponent(accountId)}/notes`, publicUrl).href : "");

  // 立即发送（账号配置中的按钮）：不看开关，向账号已启用的通知渠道发送
  async function sendNow(accountId) {
    const config = configFor(accountId);
    if (config && getEnabledNotificationChannels(config).length === 0 && !canSendEmail(config, { quiet: true })) {
      throw badRequest("这个账号没有启用任何通知渠道（Bark、ntfy、Webhook、Telegram 或邮件）");
    }
    const report = await build(accountId);
    const resolved = report.config;
    delete report.config;
    await send({ ...resolved, notifyOnWeeklyReport: true }, report.text, panelLink(accountId));
    return report;
  }

  async function runAuto(accountId, weekStart) {
    try {
      const { config, text } = await build(accountId, weekStart);
      await send(config, text, panelLink(accountId));
      state.sent[accountId] = weekStart;
      save();
      console.info(`每周阅读报告已发送：账号 ${accountId}，${weekStart} 起的一周`);
    } catch (e) {
      console.warn(`每周阅读报告失败：账号 ${accountId}：${e.message}`);
    }
  }

  // 每分钟检查：本周一的 weeklyReportAt 之后，上周的报告还没发送的账号发送一次（每天最多尝试一次）
  function tick() {
    const data = store.get();
    const { timezone, weeklyReportAt } = data.settings;
    const now = new Date(clock.now());
    const today = dateInZone(now, timezone);
    const time = new Intl.DateTimeFormat("en-GB", { timeZone: timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(now);
    if (weekdayIndex(today) === 0 && time < weeklyReportAt) {
      return;
    }
    const weekStart = addDays(today, -weekdayIndex(today) - 7);
    for (const account of data.accounts) {
      if (!account.enabled || running.has(account.id) || attempted.get(account.id) === today || state.sent[account.id] === weekStart) {
        continue;
      }
      const config = configFor(account.id);
      if (!config || !config.wereadApiKey || !config.notifyOnWeeklyReport) {
        continue;
      }
      attempted.set(account.id, today);
      const promise = runAuto(account.id, weekStart).finally(() => running.delete(account.id));
      running.set(account.id, promise);
    }
  }

  return {
    // 预览：不含账号配置
    build: async (accountId, weekStart) => {
      const report = await build(accountId, weekStart);
      delete report.config;
      return report;
    },
    sendNow,
    tick,
    // 等进行中的自动发送结束（测试用）
    idle: () => Promise.allSettled([...running.values()]),
    start() {
      tickTimer = clock.setInterval(tick, TICK_MS);
      if (tickTimer && typeof tickTimer.unref === "function") {
        tickTimer.unref();
      }
    },
    async close() {
      if (tickTimer) {
        clock.clearInterval(tickTimer);
        tickTimer = null;
      }
      await Promise.allSettled([...running.values()]);
    },
  };
}

module.exports = {
  createReportService,
};
