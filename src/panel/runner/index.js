const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const readline = require("readline");
const { fork } = require("child_process");
const { CONFIG_SCHEMA } = require("../../config/schema");
const { formatLocalTimestamp } = require("../../shared/log");
const { ensurePrivateDir } = require("../../shared/files");
const { findAccount } = require("../accounts");
const { accountDataDir, resolveAccountConfig } = require("../config");
const { PanelError, badRequest } = require("../errors");
const { AUTO_TRIGGERS, retriesLeftFor } = require("../retry");
const { newRunId, runDir, writeRunMeta } = require("../runs");
const { applyWorkerEvent, exitOutcome, fillMinuteMarks } = require("./events");
const {
  CHILD_ENV_KEYS,
  EXIT_AFTER_RESULT_MS,
  KILL_TIMEOUT_MS,
  RUN_TIMEOUT_MARGIN_MS,
  WORKER_PATH,
  childEnv,
  createRunTempDir,
  deleteSeleniumSession,
  killProcessGroup,
  removeRunTempDir,
} = require("./process");
const { MODE_LABELS, TRIGGER_LABELS, createRedactor, publicRun, runMeta } = require("./view");

// 实时推送时附带的最近日志行数，供中途打开页面时显示
const LOG_TAIL_LINES = 200;
const MAX_LOG_LINE_LENGTH = 8000;
const RUN_MODES = ["read", "login"];
const MAX_DURATION = CONFIG_SCHEMA.find((field) => field.key === "duration").max;

/**
 * 运行队列：每次运行 fork 一个阅读子进程（src/reader/worker.js），经 IPC 下发配置、接收事件，
 * 日志取自子进程的标准输出并写入运行目录。同一账号同时只有一个运行（排队或进行中），
 * 同时运行的数量由面板设置 maxConcurrentRuns 决定。
 *
 * options.publicUrl：面板的外网地址（PANEL_PUBLIC_URL），用于扫码推送中的面板链接
 * options.localBrowserStatus()：已缓存的内置浏览器状态（见 createLocalBrowserChecker 的 cached），随运行配置下发
 * options.onFinish(run, { config, retriesLeft })：每次运行结束后调用，run 为对外的运行信息，config 为这次运行实际使用的配置（没能解析时为 null），
 * retriesLeft 为启动时下发给子进程的剩余重试次数（没有启动时为 0）
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
  localBrowserStatus = () => null,
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
  function finish(run, status, error = "", errorKind = "") {
    clearTimers(run);
    run.status = status;
    run.error = error;
    run.errorKind = status === "failed" ? errorKind || "error" : "";
    run.loginUrl = "";
    run.loginQrAt = "";
    run.endedAt = new Date().toISOString();
    const summary = { success: "成功", failed: "失败", stopped: "已停止", interrupted: "中断" }[status];
    panelLog(run, `运行结束：${summary}${error ? `（${error}）` : ""}`);
    console.info(`运行结束：${run.accountId} ${run.id} ${summary}${error ? `（${error}）` : ""}`);
    changed(run);
    // 日志写入磁盘后才算结束：面板停止时等这里完成再退出进程，运行日志不会缺最后几行
    const stream = run.logStream;
    if (stream.closed || stream.destroyed) {
      run.resolveClosed();
    } else {
      stream.once("close", run.resolveClosed);
    }
    stream.end();
    running.delete(run);
    active.delete(run.accountId);
    try {
      onFinish(publicRun(run), { config: run.config || null, retriesLeft: run.retriesLeft || 0 });
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

  function setResult(run, status, error = "", errorKind = "") {
    if (run.result) {
      return;
    }
    run.result = { status, error, errorKind };
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

  function handleEvent(run, message) {
    if (!message || typeof message.event !== "string" || run.result || run.exited) {
      return;
    }
    const outcome = applyWorkerEvent(run, message);
    if (!outcome) {
      return;
    }
    if (outcome.result) {
      setResult(run, outcome.result.status, outcome.result.error, outcome.result.errorKind);
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
    removeRunTempDir(run.tmpDir);

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

    const outcome = exitOutcome(run, exitText);
    finish(run, outcome.status, outcome.error, outcome.errorKind);
  }

  function start(run) {
    const data = store.get();
    const account = data.accounts.find((item) => item.id === run.accountId);
    if (!account) {
      finish(run, "failed", "账号已删除", "account");
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
      finish(run, "failed", `配置无效：${e.message}`, "config");
      return;
    }
    try {
      ensurePrivateDir(accountDataDir(panelDataDir, account.id));
    } catch (e) {
      finish(run, "failed", `无法创建账号数据目录：${e.message}`);
      return;
    }

    // 重试、补跑与恢复按计划器给出的分钟数读；其他运行在设定时长之上随机多读 0 到 durationJitter 分钟
    if (run.mode === "read") {
      const override = run.minutesOverride != null;
      const extra = !override && config.durationJitter > 0 ? crypto.randomInt(config.durationJitter + 1) : 0;
      // 不超过配置允许的最大时长，子进程会再校验一次配置
      config = Object.freeze({ ...config, duration: Math.min(override ? run.minutesOverride : config.duration + extra, MAX_DURATION) });
      if (extra > 0) {
        panelLog(run, `本次阅读时长随机增加 ${extra} 分钟，共 ${config.duration} 分钟`);
      }
    }
    run.config = config;
    run.retriesLeft = retriesLeftFor(run.trigger, run.attempt, data.settings.retryCount);
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
      run.tmpDir = createRunTempDir(panelDataDir);
      child = fork(workerPath, [], {
        // 单独的进程组，退出后可以结束它留下的浏览器进程
        detached: true,
        stdio: ["ignore", "pipe", "pipe", "ipc"],
        env: childEnv({ TMPDIR: run.tmpDir }),
        serialization: "json",
      });
    } catch (e) {
      removeRunTempDir(run.tmpDir);
      finish(run, "failed", `无法启动阅读子进程：${e.message}`, "crash");
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
    const browserStatus = config.seleniumUrl ? null : localBrowserStatus();
    // retry：子进程据此决定失败时是否发送通知（还会重试时不发）；goalDeficit：补跑时当天还差的分钟数，写进扫码超时的通知；
    // resumeAfterLogin：自动触发的阅读扫码超时后，计划器会在重新登录后补读（planner.js 的 waitForLogin），通知里提示
    const retry = { attempt: run.attempt, retriesLeft: run.retriesLeft };
    child.send({
      type: "start",
      mode: run.mode,
      config,
      screenshotDir: run.dir,
      panelLink,
      browserStatus,
      retry,
      goalDeficit: run.goalDeficit,
      resumeAfterLogin: run.mode === "read" && AUTO_TRIGGERS.includes(run.trigger),
      ...startOptions,
    });

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
          setResult(run, "failed", `无法启动运行：${e.message}`, "crash");
          terminate(run);
        } else if (active.get(run.accountId) === run) {
          finish(run, "failed", `无法启动运行：${e.message}`, "crash");
        }
      }
    }
  }

  return {
    // 加入队列。账号不存在 404；已停用、已在运行或排队 409
    // scheduleId：定时触发时为调度规则 ID。以下由计划器使用：minutes 为本次阅读的分钟数（正整数，覆盖配置的时长，不再随机增加；null 为按配置）；
    // attempt 与 originRunId 为第几次尝试与最初那次运行；delayedMinutes 为随机延后或补触发造成的延迟；
    // goalDeficit 为补跑时当天还差的分钟数
    enqueue(
      accountId,
      { mode = "read", trigger = "manual", scheduleId = null, minutes = null, attempt = 1, originRunId = null, delayedMinutes = 0, goalDeficit = 0 } = {}
    ) {
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
        errorKind: "",
        attempt,
        originRunId,
        delayedMinutes,
        minutesOverride: minutes,
        goalDeficit,
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
      const details = [
        scheduleId ? `规则 ${scheduleId}` : "",
        attempt > 1 ? `第 ${attempt} 次尝试` : "",
        delayedMinutes > 0 ? `延后 ${delayedMinutes} 分钟` : "",
        minutes > 0 ? `读 ${minutes} 分钟` : "",
      ].filter(Boolean);
      const triggerText = `${TRIGGER_LABELS[trigger] || trigger}触发${details.length > 0 ? `（${details.join("，")}）` : ""}`;
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
      const queued = queue.splice(0);
      for (const run of queued) {
        finish(run, "interrupted", "面板停止时仍在排队");
      }
      const pending = [...running];
      for (const run of pending) {
        run.shutdown = true;
        panelLog(run, "面板正在停止，结束阅读子进程");
        terminate(run);
      }
      await Promise.all([...queued, ...pending].map((run) => run.closed));
    },
  };
}

module.exports = {
  CHILD_ENV_KEYS,
  KILL_TIMEOUT_MS,
  createRedactor,
  createRunner,
  fillMinuteMarks,
};
