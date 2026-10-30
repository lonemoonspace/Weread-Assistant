import { reactive } from "../vendor/vue.esm-browser.prod.js";
import { api, apiText } from "./api.js";

// 全局状态：会话、表单清单、设置、账号，以及经实时推送维护的运行状态
export const state = reactive({
  ready: false,
  loadError: "",
  session: null,
  schema: null,
  settings: null,
  defaults: null,
  accounts: [],
  // 账号 ID → 排队中或进行中的运行（含最近的日志 log）
  runs: {},
  // 账号 ID → 本次打开页面后结束的最近一次运行，结束后实时页面仍能看到结果与日志
  finished: {},
  connection: "connecting",
  notice: null,
  // 账号 ID → 运行或停止请求在途，期间按钮不可点，避免双击时第二次请求报错
  pending: {},
});

const LOG_LINES = 500;

export function timezone() {
  return state.settings ? state.settings.timezone : undefined;
}

let noticeTimer = null;

// 页面底部的提示，type 为 success 或 error
export function notify(text, type = "success") {
  state.notice = { text, type };
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => {
    state.notice = null;
  }, type === "error" ? 8000 : 4000);
}

export async function refreshAccounts() {
  state.accounts = (await api("accounts")).accounts;
}

export async function refreshSettings() {
  const data = await api("settings");
  state.settings = data.settings;
  state.defaults = data.defaults;
}

let refreshTimer = null;
let lastRefresh = 0;

// 运行状态变化后刷新账号列表（今天的分钟数、最近一次运行）。进度事件每分钟一次，限制刷新频率
function requestAccountsRefresh(urgent) {
  const wait = urgent ? 300 : Math.max(0, 30000 - (Date.now() - lastRefresh));
  if (refreshTimer && !urgent) {
    return;
  }
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    lastRefresh = Date.now();
    refreshAccounts().catch(() => {});
  }, wait);
}

// 运行的第一行日志（加入队列）先于它的状态推送到达，暂存到状态到达时
const pendingLogs = new Map();

function applyRun(run) {
  const current = state.runs[run.accountId];
  let log = current && current.id === run.id ? current.log : null;
  if (!log) {
    log = pendingLogs.get(run.id) || [];
    pendingLogs.delete(run.id);
  }
  if (run.endedAt) {
    state.finished[run.accountId] = { ...run, log };
    delete state.runs[run.accountId];
    requestAccountsRefresh(true);
    return;
  }
  const statusChanged = !current || current.status !== run.status;
  state.runs[run.accountId] = { ...run, log };
  requestAccountsRefresh(statusChanged);
}

function appendLog({ runId, accountId, line }) {
  const run = state.runs[accountId];
  if (!run || run.id !== runId) {
    if (!pendingLogs.has(runId)) {
      if (pendingLogs.size > 20) {
        pendingLogs.clear();
      }
      pendingLogs.set(runId, []);
    }
    pendingLogs.get(runId).push(line);
    return;
  }
  run.log.push(line);
  if (run.log.length > LOG_LINES) {
    run.log.splice(0, run.log.length - LOG_LINES);
  }
}

// 断线期间结束的运行没有收到结束事件，重连后的完整状态中也没有它：从接口取回最终记录与日志
async function recoverFinished(accountId, run) {
  try {
    const { run: record } = await api(`accounts/${accountId}/runs/${run.id}`);
    let log = run.log;
    if (record.hasLog) {
      log = (await apiText(`accounts/${accountId}/runs/${run.id}/log`)).split("\n").filter(Boolean).slice(-LOG_LINES);
    }
    const current = state.finished[accountId];
    // 期间如果又有运行结束，保留较新的那次
    if (!current || current.id <= run.id) {
      state.finished[accountId] = { ...record, loginUrl: "", log };
    }
  } catch (_) {
    // 运行记录读取失败时不显示；历史页面仍可查看
  }
}

let source = null;
let retryTimer = null;
let idleTimer = null;
// 服务端每 15 秒发送一次心跳 ping（server.js 的 SSE_HEARTBEAT_MS），这里取它的 3 倍：这段时间内什么都没收到时
// 认为连接已经半开（代理静默丢包、休眠唤醒），主动重连。修改心跳间隔时同步修改这里
const EVENTS_IDLE_MS = 45000;

function resetIdleTimer() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    state.connection = "reconnecting";
    connectEvents();
  }, EVENTS_IDLE_MS);
}

// 实时推送。连接后先收到完整状态（snapshot）；断开后浏览器自动重连，
// 服务端拒绝（例如会话失效）时先确认会话，再重新连接
export function connectEvents() {
  clearTimeout(retryTimer);
  if (source) {
    source.close();
  }
  source = new EventSource("api/events");
  resetIdleTimer();
  source.addEventListener("open", () => {
    state.connection = "connected";
    resetIdleTimer();
  });
  for (const name of ["snapshot", "run", "log", "ping"]) {
    source.addEventListener(name, resetIdleTimer);
  }
  source.addEventListener("snapshot", (event) => {
    const { runs } = JSON.parse(event.data);
    const next = {};
    for (const run of runs) {
      next[run.accountId] = { ...run, log: run.log || [] };
    }
    const previous = state.runs;
    state.runs = next;
    for (const [accountId, run] of Object.entries(previous)) {
      if (!next[accountId] || next[accountId].id !== run.id) {
        recoverFinished(accountId, run);
      }
    }
    state.connection = "connected";
    requestAccountsRefresh(true);
  });
  source.addEventListener("run", (event) => applyRun(JSON.parse(event.data)));
  source.addEventListener("log", (event) => appendLog(JSON.parse(event.data)));
  source.addEventListener("error", () => {
    state.connection = "reconnecting";
    if (source.readyState === EventSource.CLOSED) {
      retryTimer = setTimeout(async () => {
        try {
          await api("auth/session");
        } catch (_) {
          // 会话失效时 api() 已跳转到登录页；网络错误时稍后重试
        }
        connectEvents();
      }, 3000);
    }
  });
}

export async function loadAll() {
  try {
    const [session, schema] = await Promise.all([api("auth/session"), api("schema")]);
    state.session = session;
    state.schema = schema;
    await Promise.all([refreshSettings(), refreshAccounts()]);
    state.ready = true;
    connectEvents();
  } catch (error) {
    state.loadError = error.message;
  }
}

export async function logout() {
  try {
    await api("auth/logout", { method: "POST" });
  } finally {
    location.href = "login";
  }
}

// 启动运行或停止；出错时提示
export async function startRun(accountId, mode) {
  if (state.pending[accountId]) {
    return;
  }
  state.pending[accountId] = true;
  try {
    const { run } = await api(`accounts/${accountId}/runs`, { method: "POST", body: { mode } });
    // 实时推送可能先于响应到达，甚至运行已经结束
    const known = [state.runs[accountId], state.finished[accountId]].some((item) => item && item.id === run.id);
    if (!known) {
      state.runs[accountId] = { ...run, log: pendingLogs.get(run.id) || [] };
      pendingLogs.delete(run.id);
    }
    notify(mode === "login" ? "已开始登录，稍后显示二维码" : "已加入运行队列");
  } catch (error) {
    notify(error.message, "error");
  } finally {
    delete state.pending[accountId];
  }
}

export async function stopRun(accountId) {
  if (state.pending[accountId]) {
    return;
  }
  state.pending[accountId] = true;
  try {
    await api(`accounts/${accountId}/stop`, { method: "POST" });
    notify("正在停止");
  } catch (error) {
    notify(error.message, "error");
  } finally {
    delete state.pending[accountId];
  }
}
