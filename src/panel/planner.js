const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { createNotifier } = require("../notify");
const { writeFileAtomic } = require("../shared/files");
const { PanelError } = require("./errors");
const { MAX_CATCHUPS_PER_DAY } = require("./goal");
const { dateInZone } = require("./dates");
const { todayStats } = require("./stats");
const { AUTO_TRIGGERS, RETRYABLE_ERROR_KINDS, RETRY_DELAYS_MS, retriesLeftFor, retryDelayMs } = require("./retry");
const { describeSchedule, jitterOf, nextRuns } = require("./schedules");

/**
 * 计划器：调度器到点触发之外的自动运行都在这里安排。
 *
 * - 失败重试：自动触发的运行因出错、超时或子进程异常退出而失败时，按 5、15、30 分钟的间隔重试，只读剩余的分钟（retry.js）
 * - 调度随机延后：规则带 jitterMinutes 时，到点后随机延后 0 到该值分钟再加入队列
 * - 每日目标：每天到账号的 goal.checkAt，当天分钟数不够时补跑差额（不跨过零点，每天最多 3 次）
 * - 启动时恢复：面板启动 startupDelayMs 后，恢复上次停止时被中断的自动运行、补触发停机期间错过的调度、执行过期的待办，
 *   都只处理宽限时间（面板设置 catchupGraceMinutes）以内的
 *
 * 待办与每天补跑的次数保存在 data/planner.json（0600，原子写入），面板重启后不丢；文件丢失或损坏时当作没有待办。
 * 时钟与定时器经 clock 注入，测试可以直接调用 tick() 与 recover()。
 */

const STATE_VERSION = 1;
const STARTUP_DELAY_MS = 2 * 60000;
const TICK_MS = 60000;
// 补跑最晚读到当天的 23:57
const DAY_END_TIME = "23:57";
// 计算停机期间错过的触发时间时，每条规则最多看这么多次
const MAX_MISSED_LOOKUP = 500;

const systemClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (timer) => clearTimeout(timer),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (timer) => clearInterval(timer),
};

const zoneFormatters = new Map();

// 某个时刻在时区中的墙上时间与 UTC 的差（毫秒）
function zoneOffsetMs(ts, timezone) {
  let formatter = zoneFormatters.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    zoneFormatters.set(timezone, formatter);
  }
  const parts = Object.fromEntries(formatter.formatToParts(new Date(ts)).map((part) => [part.type, Number(part.value)]));
  const wall = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return wall - Math.floor(ts / 1000) * 1000;
}

// 时区中某天某个时刻（HH:MM）对应的时间戳。夏令时跳过的时刻取跳过之后
function zonedTime(date, time, timezone) {
  const [y, m, d] = date.split("-").map(Number);
  const [hour, minute] = time.split(":").map(Number);
  const wall = Date.UTC(y, m - 1, d, hour, minute);
  const guess = wall - zoneOffsetMs(wall, timezone);
  return wall - zoneOffsetMs(guess, timezone);
}

function emptyState() {
  return { version: STATE_VERSION, lastCheckAt: null, pending: [], catchups: {} };
}

const isPlainObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const PENDING_KINDS = ["retry", "schedule", "resume"];

function loadState(file) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    if (e.code !== "ENOENT") {
      console.warn(`无法读取 ${file}（${e.message}），当作没有待办`);
    }
    return emptyState();
  }
  if (!isPlainObject(raw)) {
    console.warn(`${file} 的内容不是对象，当作没有待办`);
    return emptyState();
  }
  const pending = Array.isArray(raw.pending)
    ? raw.pending.filter((item) => isPlainObject(item) && PENDING_KINDS.includes(item.kind) && typeof item.accountId === "string")
    : [];
  return {
    version: STATE_VERSION,
    lastCheckAt: typeof raw.lastCheckAt === "string" && !Number.isNaN(Date.parse(raw.lastCheckAt)) ? raw.lastCheckAt : null,
    pending,
    catchups: isPlainObject(raw.catchups) ? raw.catchups : {},
  };
}

const minutesBetween = (from, to) => Math.max(0, Math.round((to - from) / 60000));
const formatTime = (ts) => new Date(ts).toISOString();

// 恢复被中断的运行时补读的分钟数：开始过的运行为计划时长减去已读，还没开始的（排队时被中断）为 0，表示按配置的时长
function remainingMinutes(run) {
  if (!run.startedAt) {
    return 0;
  }
  return Math.max(0, (Number(run.plannedMinutes) || 0) - (Number(run.minutes) || 0));
}

// 面板代发失败通知：子进程崩溃或超时被结束时自己来不及发
async function sendFailureNotice(config, body) {
  const notifier = createNotifier(config);
  notifier.event("failure", body);
  await notifier.flush();
}

function createPlanner({
  dataDir,
  store,
  runner,
  interrupted = [],
  clock = systemClock,
  random = Math.random,
  startupDelayMs = STARTUP_DELAY_MS,
  tickMs = TICK_MS,
  retryDelaysMs = RETRY_DELAYS_MS,
  notify = sendFailureNotice,
}) {
  const panelDataDir = path.resolve(dataDir);
  const file = path.join(panelDataDir, "planner.json");
  const state = loadState(file);
  const startedAt = clock.now();
  // 上次停止前最后一次检查的时间：启动后调度器照常触发并更新 lastCheckAt，计算停机期间错过的调度要用启动时的值
  const lastCheckAtBefore = state.lastCheckAt;
  // 启动恢复完成之前不执行待办：等网络与浏览器环境稳定，也避开连续重启
  let ready = false;
  let closing = false;
  let startupTimer = null;
  let tickTimer = null;

  function save() {
    try {
      writeFileAtomic(file, JSON.stringify(state, null, 2), { mode: 0o600 });
    } catch (e) {
      console.error(`保存 ${file} 失败:`, e.message);
    }
  }

  const settings = () => store.get().settings;
  const graceMs = () => settings().catchupGraceMinutes * 60000;
  const findAccount = (data, id) => data.accounts.find((account) => account.id === id) || null;

  function addPending(item) {
    state.pending.push({ id: crypto.randomBytes(4).toString("hex"), ...item });
    save();
  }

  function enqueue(accountId, options, label) {
    try {
      const run = runner.enqueue(accountId, { mode: "read", ...options });
      console.info(`${label}：账号 ${accountId}，运行 ${run.id}`);
      return run;
    } catch (e) {
      if (e instanceof PanelError) {
        console.info(`${label}跳过：账号 ${accountId}：${e.message}`);
        return null;
      }
      console.error(`${label}失败：账号 ${accountId}:`, e);
      return null;
    }
  }

  // ---------- 调度触发 ----------

  // 调度器到点后调用。规则带 jitterMinutes 时随机延后，等待中的项目写入 planner.json
  function fireSchedule(accountId, rule) {
    state.lastCheckAt = formatTime(clock.now());
    const label = `定时触发：账号 ${accountId}，规则 ${rule.id}（${describeSchedule(rule)}）`;
    const jitter = jitterOf(rule);
    const delay = jitter > 0 ? Math.floor(random() * (jitter + 1)) : 0;
    if (delay === 0) {
      save();
      try {
        const run = runner.enqueue(accountId, { mode: "read", trigger: "schedule", scheduleId: rule.id });
        console.info(`${label}，运行 ${run.id}`);
      } catch (e) {
        if (e instanceof PanelError) {
          console.info(`定时触发跳过：账号 ${accountId}，规则 ${rule.id}（${describeSchedule(rule)}）：${e.message}`);
          return;
        }
        console.error(`定时触发失败：账号 ${accountId}，规则 ${rule.id}:`, e);
      }
      return;
    }
    const dueAt = clock.now() + delay * 60000;
    addPending({ kind: "schedule", accountId, scheduleId: rule.id, dueAt: formatTime(dueAt), delayedMinutes: delay });
    console.info(`${label}，随机延后 ${delay} 分钟，${formatTime(dueAt)} 加入队列`);
  }

  // ---------- 运行结束 ----------

  function failureNotice(run) {
    const retried = run.attempt > 1 ? `（已重试 ${run.attempt - 1} 次）` : "";
    return `运行失败：${run.error}${retried}`;
  }

  // 运行队列每次运行结束后调用
  function handleFinished(run, { config = null } = {}) {
    if (run.mode !== "read") {
      return;
    }
    if (run.status === "interrupted") {
      // 面板停止时被中断的自动运行：记下来，下次启动时恢复。手动运行不恢复；恢复出来的运行再被中断时不再恢复，
      // 每次被中断的运行只恢复一次，连续重启不会一直接力下去
      if (!AUTO_TRIGGERS.includes(run.trigger) || run.trigger === "resume") {
        return;
      }
      addPending({
        kind: "resume",
        accountId: run.accountId,
        runId: run.id,
        trigger: run.trigger,
        originRunId: run.originRunId || run.id,
        attempt: run.attempt || 1,
        minutes: remainingMinutes(run),
        endedAt: run.endedAt,
      });
      return;
    }
    if (run.status === "failed") {
      handleFailure(run, config);
    }
    if (run.status === "stopped" && AUTO_TRIGGERS.includes(run.trigger)) {
      // 手动停止了自动运行：当天不再补跑，避免刚停下又被补跑拉起来
      blockCatchups(run.accountId);
      return;
    }
    if (ready && !closing) {
      checkGoal(run.accountId);
    }
  }

  function handleFailure(run, config) {
    const data = store.get();
    const account = findAccount(data, run.accountId);
    const attempt = run.attempt || 1;
    const left = retriesLeftFor(run.trigger, attempt, data.settings.retryCount);
    if (run.errorKind === "login-timeout" && AUTO_TRIGGERS.includes(run.trigger)) {
      // 需要人扫码：当天不再补跑
      blockCatchups(run.accountId);
    }
    if (RETRYABLE_ERROR_KINDS.includes(run.errorKind) && left > 0 && !closing && account && account.enabled) {
      const delay = retryDelayMs(attempt, retryDelaysMs);
      const dueAt = clock.now() + delay;
      addPending({
        kind: "retry",
        accountId: run.accountId,
        failedRunId: run.id,
        originRunId: run.originRunId || run.id,
        attempt: attempt + 1,
        minutes: remainingMinutes(run),
        dueAt: formatTime(dueAt),
      });
      console.info(`运行失败，${Math.round(delay / 60000)} 分钟后第 ${attempt} 次重试：账号 ${run.accountId}，运行 ${run.id}`);
      return;
    }
    // 子进程崩溃或超时被结束时来不及发通知，由面板代发；不再重试时才发
    if ((run.errorKind === "timeout" || run.errorKind === "crash") && config) {
      notify(config, failureNotice(run)).catch((e) => console.warn("发送失败通知出错:", e.message));
    }
  }

  // ---------- 每日目标 ----------

  function blockCatchups(accountId) {
    const today = dateInZone(new Date(clock.now()), settings().timezone);
    state.catchups[accountId] = { ...catchupsOf(accountId, today), blocked: true };
    save();
  }

  function catchupsOf(accountId, today) {
    const record = state.catchups[accountId];
    return record && record.date === today ? record : { date: today, count: 0, blocked: false };
  }

  function checkGoal(accountId) {
    const data = store.get();
    const account = findAccount(data, accountId);
    if (!account || !account.enabled || !account.goal || !account.goal.enabled) {
      return;
    }
    const { timezone } = data.settings;
    const now = clock.now();
    const today = dateInZone(new Date(now), timezone);
    if (now < zonedTime(today, account.goal.checkAt, timezone)) {
      return;
    }
    // 正在运行或还有待办（重试、延后的定时运行）：等它们结束后再检查
    if (runner.isActive(accountId) || state.pending.some((item) => item.accountId === accountId)) {
      return;
    }
    const record = catchupsOf(accountId, today);
    if (record.blocked || record.count >= MAX_CATCHUPS_PER_DAY) {
      return;
    }
    const window = Math.floor((zonedTime(today, DAY_END_TIME, timezone) - now) / 60000);
    if (window < 1) {
      return;
    }
    const read = todayStats(panelDataDir, accountId, { timezone, now: new Date(now) }).minutes;
    const deficit = account.goal.minutes - read;
    if (deficit <= 0) {
      return;
    }
    const minutes = Math.min(deficit, window);
    state.catchups[accountId] = { ...record, count: record.count + 1 };
    save();
    enqueue(
      accountId,
      { trigger: "catchup", minutes, goalDeficit: deficit },
      `每日目标补跑（今天已读 ${read}/${account.goal.minutes} 分钟，补 ${minutes} 分钟，今天第 ${record.count + 1} 次）`
    );
  }

  // ---------- 待办 ----------

  function runPending(item) {
    const data = store.get();
    const account = findAccount(data, item.accountId);
    if (!account || !account.enabled) {
      console.info(`账号 ${item.accountId} 已删除或停用，丢弃待办（${item.kind}）`);
      return;
    }
    if (runner.isActive(item.accountId)) {
      console.info(`账号 ${item.accountId} 正在运行或排队，放弃这次${item.kind === "retry" ? "重试" : "延后的定时运行"}`);
      return;
    }
    if (item.kind === "retry") {
      enqueue(
        item.accountId,
        { trigger: "retry", minutes: item.minutes, attempt: item.attempt, originRunId: item.originRunId },
        `失败重试（第 ${item.attempt} 次尝试，最初运行 ${item.originRunId}）`
      );
    } else if (item.kind === "schedule") {
      const late = minutesBetween(Date.parse(item.dueAt), clock.now());
      enqueue(
        item.accountId,
        { trigger: "schedule", scheduleId: item.scheduleId, delayedMinutes: item.delayedMinutes + late },
        `定时触发（规则 ${item.scheduleId}，随机延后 ${item.delayedMinutes} 分钟）`
      );
    }
  }

  function tick() {
    if (!ready || closing) {
      return;
    }
    const now = clock.now();
    const due = state.pending.filter((item) => item.kind !== "resume" && Date.parse(item.dueAt) <= now);
    if (due.length > 0) {
      state.pending = state.pending.filter((item) => !due.includes(item));
      save();
      for (const item of due.sort((a, b) => a.dueAt.localeCompare(b.dueAt))) {
        runPending(item);
      }
    }
    for (const account of store.get().accounts) {
      checkGoal(account.id);
    }
    state.lastCheckAt = formatTime(now);
    save();
  }

  // ---------- 启动恢复 ----------

  // 上次启动以来被中断的运行（面板停止时由运行队列标记，或崩溃后由 markInterruptedRuns 标记）
  for (const { meta } of interrupted) {
    if (meta && meta.mode === "read") {
      handleFinished({ ...meta, status: "interrupted" });
    }
  }

  function recoverInterrupted(now, grace) {
    const items = state.pending.filter((item) => item.kind === "resume");
    state.pending = state.pending.filter((item) => item.kind !== "resume");
    save();
    for (const item of items) {
      const endedAt = Date.parse(item.endedAt);
      if (!AUTO_TRIGGERS.includes(item.trigger)) {
        continue;
      }
      if (grace === 0 || Number.isNaN(endedAt) || now - endedAt > grace) {
        console.info(`被中断的运行 ${item.runId}（账号 ${item.accountId}）已超过补触发宽限时间，不恢复`);
        continue;
      }
      const account = findAccount(store.get(), item.accountId);
      if (!account || !account.enabled) {
        continue;
      }
      enqueue(
        item.accountId,
        { trigger: "resume", minutes: item.minutes, attempt: item.attempt, originRunId: item.originRunId },
        `恢复被中断的运行 ${item.runId}${item.minutes > 0 ? `（补读剩余 ${item.minutes} 分钟）` : ""}`
      );
    }
  }

  // 停机期间错过的调度：每条规则只补触发最近错过的一次，并且要在宽限时间以内
  function recoverMissedSchedules(now, grace) {
    if (!lastCheckAtBefore || grace === 0) {
      return;
    }
    const from = new Date(lastCheckAtBefore);
    const data = store.get();
    const { timezone } = data.settings;
    for (const account of data.accounts) {
      if (!account.enabled) {
        continue;
      }
      for (const rule of account.schedules || []) {
        if (!rule.enabled) {
          continue;
        }
        const missed = nextRuns(rule, { timezone, from, count: MAX_MISSED_LOOKUP })
          .map((time) => Date.parse(time))
          .filter((time) => time < startedAt);
        if (missed.length === 0) {
          continue;
        }
        const latest = missed.at(-1);
        const label = `账号 ${account.id}，规则 ${rule.id}（${describeSchedule(rule)}）`;
        if (now - latest > grace) {
          console.info(`停机期间错过了调度 ${label} 的 ${formatTime(latest)}，已超过补触发宽限时间，不补触发`);
          continue;
        }
        enqueue(
          account.id,
          { trigger: "schedule", scheduleId: rule.id, delayedMinutes: minutesBetween(latest, now) },
          `补触发停机期间错过的调度（${label}，原定 ${formatTime(latest)}）`
        );
      }
    }
  }

  // 过期的待办：停机期间到期、超过宽限时间的丢弃，其余由随后的 tick 执行
  function dropExpired(now, grace) {
    const expired = state.pending.filter((item) => item.kind !== "resume" && now - Date.parse(item.dueAt) > Math.max(grace, tickMs));
    if (expired.length === 0) {
      return;
    }
    state.pending = state.pending.filter((item) => !expired.includes(item));
    save();
    for (const item of expired) {
      console.info(`账号 ${item.accountId} 的待办（${item.kind}，原定 ${item.dueAt}）已超过补触发宽限时间，不再执行`);
    }
  }

  function recover() {
    if (ready || closing) {
      return;
    }
    const now = clock.now();
    const grace = graceMs();
    recoverInterrupted(now, grace);
    recoverMissedSchedules(now, grace);
    dropExpired(now, grace);
    ready = true;
    tick();
  }

  // 账号被删除或停用时丢弃它的全部待办
  const unsubscribe = store.subscribe(() => {
    const data = store.get();
    const keep = state.pending.filter((item) => {
      const account = findAccount(data, item.accountId);
      return item.kind === "resume" || (account && account.enabled);
    });
    if (keep.length !== state.pending.length) {
      state.pending = keep;
      save();
    }
  });

  save();

  return {
    fireSchedule,
    handleFinished,
    tick,
    recover,

    start() {
      startupTimer = clock.setTimeout(() => {
        startupTimer = null;
        recover();
        tickTimer = clock.setInterval(tick, tickMs);
      }, startupDelayMs);
    },

    // 账号的待办与今天的补跑次数，供页面显示
    accountStatus(accountId, timezone = settings().timezone) {
      const today = dateInZone(new Date(clock.now()), timezone);
      const pending = state.pending
        .filter((item) => item.accountId === accountId && item.kind !== "resume")
        .map(({ kind, dueAt, attempt, minutes, scheduleId }) => ({ kind, dueAt, attempt, minutes, scheduleId }))
        .sort((a, b) => a.dueAt.localeCompare(b.dueAt));
      const { count, blocked } = catchupsOf(accountId, today);
      return { pending, catchups: { count, max: MAX_CATCHUPS_PER_DAY, blocked } };
    },

    // 面板开始停止：不再安排新的重试与补跑，被中断的运行仍会记下
    beginClose() {
      closing = true;
      if (startupTimer) {
        clock.clearTimeout(startupTimer);
      }
      if (tickTimer) {
        clock.clearInterval(tickTimer);
      }
    },

    close() {
      this.beginClose();
      unsubscribe();
      if (ready) {
        state.lastCheckAt = formatTime(clock.now());
      }
      save();
    },
  };
}

module.exports = {
  STARTUP_DELAY_MS,
  createPlanner,
  zonedTime,
};
