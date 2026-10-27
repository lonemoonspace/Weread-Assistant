const fs = require("fs");
const path = require("path");
const readline = require("readline");
const { fork } = require("child_process");
const { CONFIG_SCHEMA } = require("../config/schema");
const { formatLocalTimestamp } = require("../shared/log");
const { ensurePrivateDir } = require("../shared/files");
const { normalizeSeleniumUrl } = require("../shared/selenium");
const { findAccount } = require("./accounts");
const { SECRET_MASK, accountDataDir, resolveAccountConfig } = require("./config");
const { PanelError, badRequest } = require("./errors");
const { newRunId, runDir, writeRunMeta } = require("./runs");

const WORKER_PATH = path.resolve(__dirname, "..", "reader", "worker.js");
// 停止时先发 SIGTERM，子进程在这段时间内没有退出就强制结束
const KILL_TIMEOUT_MS = 15000;
// 子进程上报结果后应很快退出（关闭浏览器、发送通知）；超过这段时间仍未退出就结束它
const EXIT_AFTER_RESULT_MS = 3 * 60000;
// 运行时长上限 = 等待扫码时长 + 阅读时长 + 余量；Selenium 卡住时防止一直占用并发槽位
const RUN_TIMEOUT_MARGIN_MS = 30 * 60000;
const SESSION_DELETE_TIMEOUT_MS = 5000;
// 实时推送时附带的最近日志行数，供中途打开页面时显示
const LOG_TAIL_LINES = 200;
const MAX_LOG_LINE_LENGTH = 8000;

// 写入运行日志、推送日志与错误信息之前替换为掩码：配置中的密钥值，以及微信读书扫码登录链接中的 uid
// （有效期内可用于完成这次登录）。阅读流程本身不打印这些内容，这里是兜底
const SECRET_KEYS = CONFIG_SCHEMA.filter((field) => field.secret).map((field) => field.key);
const MIN_SECRET_LENGTH = 4;
const LOGIN_URL_UID = /(weread\.qq\.com\/web\/confirm\?[^\s"'<>]*?\buid=)[^&\s"'<>]+/g;

function createRedactor(config = {}) {
  const secrets = SECRET_KEYS.map((key) => config[key])
    .filter((value) => typeof value === "string" && value.length >= MIN_SECRET_LENGTH)
    .sort((a, b) => b.length - a.length);
  return (text) => {
    let result = String(text).replace(LOGIN_URL_UID, `$1${SECRET_MASK}`);
    for (const secret of secrets) {
      result = result.split(secret).join(SECRET_MASK);
    }
    return result;
  };
}

const RUN_MODES = ["read", "login"];
const MODE_LABELS = { read: "阅读", login: "仅登录" };
const TRIGGER_LABELS = { manual: "手动", schedule: "定时" };

// 子进程只继承运行 Node 与联网所需的环境变量（白名单，另加 LC_*）。运行配置与密钥经 IPC 下发，
// 面板所在环境中的 PANEL_PASSWORD、BARK_KEY、EMAIL_PASS 等变量都不会传给子进程
const CHILD_ENV_KEYS = new Set([
  "PATH",
  "HOME",
  "USER",
  "TZ",
  "TMPDIR",
  "LANG",
  "LANGUAGE",
  "NODE_OPTIONS",
  "NODE_EXTRA_CA_CERTS",
  "NODE_USE_ENV_PROXY",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  // 内置浏览器的路径
  "CHROME_BIN",
  "CHROMEDRIVER_PATH",
]);

function childEnv() {
  return Object.fromEntries(
    Object.entries(process.env).filter(([key]) => CHILD_ENV_KEYS.has(key) || key.startsWith("LC_"))
  );
}

function publicRun(run, { withLog = false } = {}) {
  const view = {
    id: run.id,
    accountId: run.accountId,
    accountName: run.accountName,
    mode: run.mode,
    trigger: run.trigger,
    scheduleId: run.scheduleId,
    status: run.status,
    stopRequested: run.stopRequested,
    queuedAt: run.queuedAt,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    book: run.book,
    readingStartedAt: run.readingStartedAt,
    minutes: run.minutes,
    plannedMinutes: run.plannedMinutes,
    screenshot: run.screenshot,
    loginUrl: run.loginUrl,
    // 最近一次出现二维码的时间：二维码解析不出登录链接时，页面据此加载二维码截图
    loginQrAt: run.loginQrAt,
    error: run.error,
  };
  if (withLog) {
    view.log = [...run.logTail];
  }
  return view;
}

// 写入 meta.json 的运行记录：不含登录链接（一次性且很快过期）。
// minuteMarks 为每一分钟阅读完成的时间，按天统计时用它把跨天的运行拆到各自的日期
function runMeta(run) {
  const { loginUrl, loginQrAt, stopRequested, ...meta } = publicRun(run);
  return { ...meta, minuteMarks: run.minuteMarks, exitCode: run.exitCode, exitSignal: run.exitSignal };
}

// 补齐到 count 个分钟记录（进度事件跳过了某些分钟，或最后一分钟没来得及上报）。补记的分钟在上一条记录
// （没有时为开始阅读的时间）与现在之间均匀分布，最后一条为现在：跨午夜时仍能大致归到各自的日期
function fillMinuteMarks(run, count) {
  const missing = count - run.minuteMarks.length;
  if (missing <= 0) {
    return;
  }
  const now = Date.now();
  const last = Date.parse(run.minuteMarks.at(-1) || run.readingStartedAt || "");
  const from = Number.isNaN(last) || last > now ? now : last;
  const step = (now - from) / missing;
  for (let i = 1; i <= missing; i += 1) {
    run.minuteMarks.push(new Date(from + step * i).toISOString());
  }
}

// fetch 不接受带用户名与密码的地址：从地址中取出，改用 Authorization 请求头（与连接浏览器时一致）
async function deleteSeleniumSession(seleniumUrl, sessionId) {
  const url = new URL(`${normalizeSeleniumUrl(seleniumUrl)}/session/${encodeURIComponent(sessionId)}`);
  const headers = {};
  if (url.username || url.password) {
    const credentials = `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`;
    headers.Authorization = `Basic ${Buffer.from(credentials).toString("base64")}`;
    url.username = "";
    url.password = "";
  }
  const res = await fetch(url, { method: "DELETE", headers, signal: AbortSignal.timeout(SESSION_DELETE_TIMEOUT_MS) });
  return res.status;
}

function killProcessGroup(child) {
  if (!child || !child.pid) {
    return;
  }
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch (_) {
    // 组内已没有进程
  }
}

/**
 * 运行队列：每次运行 fork 一个阅读子进程（src/reader/worker.js），经 IPC 下发配置、接收事件，
 * 日志取自子进程的标准输出并写入运行目录。同一账号同时只有一个运行（排队或进行中），
 * 同时运行的数量由面板设置 maxConcurrentRuns 决定。
 *
 * options.publicUrl：面板的外网地址（PANEL_PUBLIC_URL），用于扫码推送中的面板链接
 * options.workerPath / killTimeoutMs / runTimeoutMs / startOptions 供测试替换子进程与缩短等待
 */
function createRunner({
  dataDir,
  store,
  workerPath = WORKER_PATH,
  killTimeoutMs = KILL_TIMEOUT_MS,
  exitAfterResultMs = EXIT_AFTER_RESULT_MS,
  runTimeoutMs,
  publicUrl = "",
  startOptions = {},
  onFinish = () => {},
}) {
  const panelDataDir = path.resolve(dataDir);
  const queue = [];
  const running = new Set();
  // 账号 ID → 排队中或进行中的运行
  const active = new Map();
  const listeners = new Set();
  let closing = false;

  function emit(type, payload) {
    for (const listener of listeners) {
      try {
        listener(type, payload);
      } catch (e) {
        console.error("推送运行事件失败:", e);
      }
    }
  }

  function appendLog(run, line) {
    if (run.logStream.writableEnded) {
      return;
    }
    const redacted = run.redact(line);
    const text = redacted.length > MAX_LOG_LINE_LENGTH ? `${redacted.slice(0, MAX_LOG_LINE_LENGTH)}…` : redacted;
    run.logStream.write(`${text}\n`);
    run.logTail.push(text);
    if (run.logTail.length > LOG_TAIL_LINES) {
      run.logTail.shift();
    }
    emit("log", { runId: run.id, accountId: run.accountId, line: text });
  }

  // 面板自己写入运行日志的行，与子进程的日志格式一致
  function panelLog(run, message) {
    appendLog(run, `[PANEL][${formatLocalTimestamp()}]: ${message}`);
  }

  function changed(run) {
    try {
      writeRunMeta(run.dir, runMeta(run));
    } catch (e) {
      console.error("写入运行记录失败:", run.dir, e.message);
    }
    emit("run", publicRun(run));
  }

  function clearTimers(run) {
    clearTimeout(run.killTimer);
    clearTimeout(run.watchdog);
    clearTimeout(run.exitTimer);
  }

  // 结束一次运行：写入最终状态、关闭日志、释放账号，然后尝试启动排队中的运行
  function finish(run, status, error = "") {
    clearTimers(run);
    run.status = status;
    run.error = error;
    run.loginUrl = "";
    run.loginQrAt = "";
    run.endedAt = new Date().toISOString();
    const summary = { success: "成功", failed: "失败", stopped: "已停止", interrupted: "中断" }[status];
    panelLog(run, `运行结束：${summary}${error ? `（${error}）` : ""}`);
    console.info(`运行结束：${run.accountId} ${run.id} ${summary}${error ? `（${error}）` : ""}`);
    changed(run);
    run.logStream.end();
    running.delete(run);
    active.delete(run.accountId);
    run.resolveClosed();
    try {
      onFinish(publicRun(run));
    } catch (e) {
      console.error("处理运行结束失败:", e);
    }
    pump();
  }

  // SIGTERM，超时后 SIGKILL。已经在结束子进程，不再按运行超时处理：
  // 停止或面板关闭后、子进程退出前看门狗到点时，结果仍记为已停止或中断
  function terminate(run) {
    clearTimeout(run.watchdog);
    if (run.killTimer) {
      return;
    }
    run.child.kill("SIGTERM");
    run.killTimer = setTimeout(() => {
      panelLog(run, `阅读子进程 ${Math.round(killTimeoutMs / 1000)} 秒内未退出，强制结束`);
      run.child.kill("SIGKILL");
    }, killTimeoutMs);
  }

  function setResult(run, status, error = "") {
    if (run.result) {
      return;
    }
    run.result = { status, error };
    run.status = status;
    run.error = error;
    run.loginUrl = "";
    run.loginQrAt = "";
    clearTimeout(run.watchdog);
    run.exitTimer = setTimeout(() => {
      panelLog(run, `运行已结束但子进程 ${Math.round(exitAfterResultMs / 1000)} 秒内未退出，正在结束`);
      terminate(run);
    }, exitAfterResultMs);
  }

  function toCount(value) {
    const number = Number(value);
    return Number.isSafeInteger(number) && number >= 0 ? number : 0;
  }

  function handleEvent(run, message) {
    if (!message || typeof message.event !== "string" || run.result || run.exited) {
      return;
    }
    const data = message.data && typeof message.data === "object" ? message.data : {};
    switch (message.event) {
      case "started":
        break;
      case "session":
        run.sessionId = String(data.sessionId || "");
        break;
      case "login-required":
        run.status = "waiting-login";
        run.loginUrl = String(data.url || "");
        run.loginQrAt = new Date().toISOString();
        break;
      case "login-ok":
        run.status = "starting";
        run.loginUrl = "";
        run.loginQrAt = "";
        break;
      case "book-opened":
        run.status = "reading";
        run.book = String(data.title || "");
        run.readingStartedAt = new Date().toISOString();
        break;
      case "reading-minute":
        run.minutes = Math.min(toCount(data.minute), run.maxMinutes);
        fillMinuteMarks(run, run.minutes);
        run.plannedMinutes = toCount(data.total) || run.plannedMinutes;
        run.screenshot = path.basename(String(data.screenshot || ""));
        break;
      case "done":
        // 以较大者为准：最后一分钟的进度可能没来得及上报
        run.minutes = Math.min(Math.max(run.minutes, toCount(data.minutes)), run.maxMinutes);
        fillMinuteMarks(run, run.minutes);
        setResult(run, "success");
        break;
      case "login-timeout":
        setResult(run, "failed", "等待扫码超时");
        break;
      case "error":
        setResult(run, "failed", run.redact(data.message || "未知错误"));
        break;
      default:
        return;
    }
    changed(run);
  }

  // 子进程退出：结果以事件为准，退出前没有上报结果按失败处理
  async function onClose(run, code, signal) {
    if (run.exited) {
      return;
    }
    run.exited = true;
    clearTimers(run);
    run.exitCode = code;
    run.exitSignal = signal;
    const exitText = signal ? `信号 ${signal}` : code === null ? "未能启动" : `退出码 ${code}`;
    panelLog(run, `阅读子进程已退出（${exitText}）`);

    // 子进程是进程组的组长，内置浏览器（chromedriver 与 Chromium）在同一进程组中。子进程被强制结束时
    // 它们不会随之退出，这里结束组内剩下的进程；正常退出时组内已没有进程
    killProcessGroup(run.child);

    // 删除子进程可能留在 Selenium 中的会话，避免一直占用会话槽位。正常退出时浏览器通常已经关闭（会话已不存在），
    // 但子进程关闭浏览器失败时只记录日志、仍以退出码 0 退出，所以只要建立过会话就请求删除一次
    if (run.sessionId && run.seleniumUrl) {
      try {
        const status = await deleteSeleniumSession(run.seleniumUrl, run.sessionId);
        panelLog(run, `已请求 Selenium 删除会话 ${run.sessionId}（HTTP ${status}）`);
      } catch (e) {
        panelLog(run, `删除 Selenium 会话 ${run.sessionId} 失败：${e.message}`);
      }
    }

    if (run.result) {
      finish(run, run.result.status, run.result.error);
    } else if (run.timedOut) {
      finish(run, "failed", "运行超时，已强制结束");
    } else if (run.shutdown) {
      finish(run, "interrupted", "面板停止时运行被中断");
    } else if (run.stopRequested) {
      finish(run, "stopped");
    } else {
      finish(run, "failed", `阅读子进程异常退出（${exitText}）`);
    }
  }

  function start(run) {
    const data = store.get();
    const account = data.accounts.find((item) => item.id === run.accountId);
    if (!account) {
      finish(run, "failed", "账号已删除");
      return;
    }
    if (!account.enabled) {
      finish(run, "stopped", "账号已停用，本次未运行");
      return;
    }
    let config;
    try {
      config = resolveAccountConfig(data, account, panelDataDir);
    } catch (e) {
      finish(run, "failed", `配置无效：${e.message}`);
      return;
    }
    try {
      ensurePrivateDir(accountDataDir(panelDataDir, account.id));
    } catch (e) {
      finish(run, "failed", `无法创建账号数据目录：${e.message}`);
      return;
    }

    run.accountName = account.name;
    run.redact = createRedactor(config);
    run.seleniumUrl = config.seleniumUrl;
    run.plannedMinutes = run.mode === "read" ? config.duration : 0;
    // 子进程上报的分钟数不超过本次的阅读时长（读完时按四舍五入计，留 1 分钟余量）：
    // 异常值不会让分钟记录变长，也不会把大量补记的分钟挤到同一时刻
    run.maxMinutes = run.mode === "read" ? config.duration + 1 : 0;
    run.status = "starting";
    run.startedAt = new Date().toISOString();

    let child;
    try {
      child = fork(workerPath, [], {
        // 单独的进程组，退出后可以结束它留下的浏览器进程
        detached: true,
        stdio: ["ignore", "pipe", "pipe", "ipc"],
        env: childEnv(),
        serialization: "json",
      });
    } catch (e) {
      finish(run, "failed", `无法启动阅读子进程：${e.message}`);
      return;
    }
    run.child = child;
    running.add(run);
    panelLog(run, `启动阅读子进程（进程 ${child.pid}）`);

    for (const stream of [child.stdout, child.stderr]) {
      readline.createInterface({ input: stream, crlfDelay: Infinity }).on("line", (line) => appendLog(run, line));
    }
    child.on("message", (message) => handleEvent(run, message));
    child.on("error", (error) => {
      panelLog(run, `阅读子进程出错：${error.message}`);
      // 没能启动时不会再有 close 事件
      if (child.pid === undefined) {
        onClose(run, null, null).catch((e) => console.error("处理子进程退出失败:", e));
      }
    });
    child.once("close", (code, signal) => {
      onClose(run, code, signal).catch((e) => console.error("处理子进程退出失败:", e));
    });
    // 阅读截图直接写入运行目录
    // 配置了面板外网地址时，扫码推送附带该账号实时页面的链接
    const panelLink = publicUrl ? `${publicUrl}#/accounts/${run.accountId}/live` : "";
    child.send({ type: "start", mode: run.mode, config, screenshotDir: run.dir, panelLink, ...startOptions });

    const limitMs =
      runTimeoutMs || (config.loginTimeout + (run.mode === "read" ? config.duration : 0)) * 60000 + RUN_TIMEOUT_MARGIN_MS;
    run.watchdog = setTimeout(() => {
      run.timedOut = true;
      panelLog(run, `运行超过 ${Math.round(limitMs / 60000)} 分钟仍未结束，正在结束`);
      terminate(run);
    }, limitMs);

    console.info(`运行开始：${run.accountId} ${run.id}（${MODE_LABELS[run.mode]}）`);
    changed(run);
  }

  // 按并发上限启动排队中的运行；并发上限每次实时读取，修改设置后立即生效
  function pump() {
    if (closing) {
      return;
    }
    const limit = store.get().settings.maxConcurrentRuns;
    while (running.size < limit && queue.length > 0) {
      const run = queue.shift();
      try {
        start(run);
      } catch (e) {
        // 启动过程中的意外错误也要结束这次运行，否则它会一直停在排队状态并占用账号
        console.error("启动运行失败:", run.accountId, run.id, e);
        if (run.child) {
          setResult(run, "failed", `无法启动运行：${e.message}`);
          terminate(run);
        } else if (active.get(run.accountId) === run) {
          finish(run, "failed", `无法启动运行：${e.message}`);
        }
      }
    }
  }

  return {
    // 加入队列。账号不存在 404；已停用、已在运行或排队 409
    // scheduleId：定时触发时为调度规则 ID
    enqueue(accountId, { mode = "read", trigger = "manual", scheduleId = null } = {}) {
      if (closing) {
        throw new PanelError(503, "panel_closing", "面板正在停止");
      }
      if (!RUN_MODES.includes(mode)) {
        throw badRequest(`运行方式只能是 ${RUN_MODES.join("、")}：${mode}`);
      }
      const account = findAccount(store.get(), accountId);
      if (!account.enabled) {
        throw new PanelError(409, "account_disabled", `账号已停用：${accountId}`);
      }
      if (active.has(accountId)) {
        throw new PanelError(409, "run_active", `账号已在运行或排队：${accountId}`);
      }

      let id = newRunId();
      while (fs.existsSync(runDir(panelDataDir, accountId, id))) {
        id = newRunId();
      }
      const run = {
        id,
        accountId,
        accountName: account.name,
        mode,
        trigger,
        scheduleId,
        status: "queued",
        stopRequested: false,
        queuedAt: new Date().toISOString(),
        startedAt: null,
        endedAt: null,
        book: "",
        readingStartedAt: null,
        minutes: 0,
        maxMinutes: 0,
        minuteMarks: [],
        plannedMinutes: 0,
        screenshot: "",
        loginUrl: "",
        loginQrAt: "",
        error: "",
        exitCode: null,
        exitSignal: null,
        dir: runDir(panelDataDir, accountId, id),
        logTail: [],
        // 开始运行、拿到配置后换成同时替换密钥值的版本
        redact: createRedactor(),
        sessionId: "",
      };
      run.closed = new Promise((resolve) => {
        run.resolveClosed = resolve;
      });
      // 运行日志与阅读截图只允许属主访问，与账号数据目录一致
      ensurePrivateDir(path.dirname(run.dir));
      ensurePrivateDir(run.dir);
      run.logStream = fs.createWriteStream(path.join(run.dir, "output.log"), { flags: "a", mode: 0o600 });
      run.logStream.on("error", (e) => console.error("写入运行日志失败:", run.dir, e.message));
      active.set(accountId, run);
      queue.push(run);
      const triggerText = `${TRIGGER_LABELS[trigger] || trigger}触发${scheduleId ? `（规则 ${scheduleId}）` : ""}`;
      panelLog(run, `加入队列：${triggerText}，${MODE_LABELS[mode]}`);
      changed(run);
      pump();
      return publicRun(run);
    },

    // 停止账号当前的运行：排队中的直接取消；进行中的结束子进程（子进程会先关闭浏览器）
    stop(accountId) {
      const run = active.get(accountId);
      if (!run) {
        throw new PanelError(404, "run_not_active", `账号没有正在运行或排队的任务：${accountId}`);
      }
      if (run.status === "queued") {
        const index = queue.indexOf(run);
        if (index >= 0) {
          queue.splice(index, 1);
        }
        panelLog(run, "已取消排队");
        finish(run, "stopped");
        return publicRun(run);
      }
      // 已上报结果或子进程已退出（正在清理）时不再改变结果
      if (!run.stopRequested && !run.result && !run.exited) {
        run.stopRequested = true;
        panelLog(run, "收到停止请求，正在结束阅读子进程");
        terminate(run);
        changed(run);
      }
      return publicRun(run);
    },

    // 正在等待扫码的运行这一次保存的二维码截图（只含二维码的优先，没有或比整页截图旧时用整页截图）；没有时返回 null。
    // 二维码解析不出登录链接时由页面显示，之前运行留下的截图不会返回
    loginQrImage(accountId) {
      const run = active.get(accountId);
      if (!run || run.status !== "waiting-login" || !run.startedAt) {
        return null;
      }
      const dir = accountDataDir(panelDataDir, accountId);
      const mtime = (name) => {
        try {
          return fs.statSync(path.join(dir, name)).mtimeMs;
        } catch (_) {
          return -1;
        }
      };
      // 每次截图先写整页再写二维码区域：二维码截图早于整页截图时是之前某次截下的，不再代表当前页面
      const startedAt = Date.parse(run.startedAt);
      const qrAt = mtime("login-qr.png");
      const pageAt = mtime("login.png");
      if (qrAt >= startedAt && qrAt >= pageAt) {
        return { dir, name: "login-qr.png" };
      }
      return pageAt >= startedAt ? { dir, name: "login.png" } : null;
    },

    isActive(accountId) {
      return active.has(accountId);
    },

    // 已启动子进程的运行所用的 Selenium 地址（每个运行占用一个会话），供 Selenium 状态区分会话是否属于面板
    seleniumUrls() {
      return [...running].map((run) => run.seleniumUrl);
    },

    // 排队中与进行中的运行，按加入队列的顺序
    list({ withLog = false } = {}) {
      return [...active.values()]
        .sort((a, b) => a.queuedAt.localeCompare(b.queuedAt))
        .map((run) => publicRun(run, { withLog }));
    },

    pump,

    // listener(type, payload)：type 为 "run"（运行状态变化）或 "log"（新的日志行）
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    // 面板停止：取消排队，结束所有子进程并等待退出，这些运行记为中断
    async close() {
      closing = true;
      for (const run of queue.splice(0)) {
        finish(run, "interrupted", "面板停止时仍在排队");
      }
      const pending = [...running];
      for (const run of pending) {
        run.shutdown = true;
        panelLog(run, "面板正在停止，结束阅读子进程");
        terminate(run);
      }
      await Promise.all(pending.map((run) => run.closed));
    },
  };
}

module.exports = {
  CHILD_ENV_KEYS,
  KILL_TIMEOUT_MS,
  createRunner,
};
