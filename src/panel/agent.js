const { findAccount } = require("./accounts");
const { PanelError, badRequest } = require("./errors");
const { lastRun, listRuns } = require("./history");
const { nextRunInfo } = require("./schedules");
const { accountStreak, challengeProgress, todayStats } = require("./stats");
const { SCOPES, canAccess } = require("./tokens");

/**
 * 令牌可以调用的操作（api/v1 与 MCP 共用）。每个操作先检查令牌的权限与能访问的账号；
 * 返回的内容经过挑选：不含配置、密钥、cookies、登录链接与截图。
 */

const RUN_FIELDS = ["id", "mode", "trigger", "status", "queuedAt", "startedAt", "endedAt", "minutes", "plannedMinutes", "book", "error", "attempt"];

const pick = (source, fields) => (source ? Object.fromEntries(fields.filter((key) => source[key] !== undefined).map((key) => [key, source[key]])) : null);

function forbidden(message) {
  return new PanelError(403, "forbidden", message);
}

function createAgent({ dataDir, store, runner, planner = null, notes = null, reports = null }) {
  function requireScope(token, scope) {
    if (!token.scopes.includes(scope)) {
      throw forbidden(`这个令牌没有“${SCOPES[scope]}”的权限`);
    }
  }

  // 令牌能访问的账号；不能访问的账号与不存在的一样返回 404，不透露账号是否存在
  function accountFor(token, accountId) {
    if (typeof accountId !== "string" || !canAccess(token, accountId)) {
      throw new PanelError(404, "account_not_found", `账号不存在：${accountId}`);
    }
    return findAccount(store.get(), accountId);
  }

  const activeRun = (accountId) => {
    const run = runner.list().find((item) => item.accountId === accountId);
    return run ? pick(run, RUN_FIELDS) : null;
  };

  function accountSummary(account, timezone) {
    const next = nextRunInfo(account, timezone);
    return {
      id: account.id,
      name: account.name,
      enabled: account.enabled,
      today: todayStats(dataDir, account.id, { timezone }),
      streak: accountStreak(dataDir, account.id, { timezone }),
      activeRun: activeRun(account.id),
      lastRun: pick(lastRun(dataDir, account.id), RUN_FIELDS),
      nextRunAt: next ? next.at : null,
    };
  }

  return {
    // 令牌自身的信息：名称、权限与能访问的账号
    whoami(token) {
      return { name: token.name, scopes: token.scopes, accounts: token.accounts };
    },

    listAccounts(token) {
      requireScope(token, "read");
      const data = store.get();
      const { timezone } = data.settings;
      return { timezone, accounts: data.accounts.filter((account) => canAccess(token, account.id)).map((account) => accountSummary(account, timezone)) };
    },

    accountStatus(token, accountId) {
      requireScope(token, "read");
      const account = accountFor(token, accountId);
      const { timezone } = store.get().settings;
      const planned = planner ? planner.accountStatus(account.id, timezone) : null;
      return {
        timezone,
        ...accountSummary(account, timezone),
        goal: account.goal || null,
        challenge: challengeProgress(dataDir, account, { timezone }),
        // 计划器的待办（重试、随机延后的定时运行、补跑）与今天的分段阅读
        planned: planned ? { pending: planned.pending, split: planned.split, waitingLogin: planned.catchups.waitingLogin } : null,
      };
    },

    recentRuns(token, accountId, { limit = 10 } = {}) {
      requireScope(token, "read");
      const account = accountFor(token, accountId);
      const size = Number(limit);
      if (!Number.isInteger(size) || size < 1 || size > 50) {
        throw badRequest("limit 必须是 1–50 的整数");
      }
      const { runs } = listRuns(dataDir, account.id, { limit: size, timezone: store.get().settings.timezone });
      return { runs: runs.map((run) => pick(run, RUN_FIELDS)) };
    },

    startRun(token, accountId, { mode = "read" } = {}) {
      requireScope(token, "run");
      const account = accountFor(token, accountId);
      if (!["read", "login"].includes(mode)) {
        throw badRequest("mode 只能是 read 或 login");
      }
      const run = runner.enqueue(account.id, { mode });
      console.info(`令牌 ${token.name} 开始运行：账号 ${account.id}（${mode === "login" ? "仅登录" : "阅读"}）`);
      return { run: pick(run, RUN_FIELDS) };
    },

    stopRun(token, accountId) {
      requireScope(token, "run");
      const account = accountFor(token, accountId);
      const run = runner.stop(account.id);
      console.info(`令牌 ${token.name} 停止运行：账号 ${account.id}`);
      return { run: pick(run, RUN_FIELDS) };
    },

    notesStatus(token, accountId) {
      requireScope(token, "notes");
      const account = accountFor(token, accountId);
      const status = notes.status(account.id);
      return {
        ...status,
        books: status.books.map((book) =>
          pick(book, ["bookId", "title", "author", "highlightCount", "reviewItemCount", "readingProgress", "finished", "sort", "removed"])
        ),
      };
    },

    notesBook(token, accountId, bookId) {
      requireScope(token, "notes");
      const account = accountFor(token, accountId);
      const result = notes.book(account.id, String(bookId || ""));
      if (!result) {
        throw new PanelError(404, "not_found", "没有这本书的笔记");
      }
      return result;
    },

    notesMarkdown(token, accountId, bookId) {
      requireScope(token, "notes");
      const account = accountFor(token, accountId);
      const markdown = bookId ? notes.markdownText(account.id, String(bookId)) : notes.allMarkdown(account.id);
      if (!markdown) {
        throw new PanelError(404, "not_found", bookId ? "没有这本书的 Markdown" : "还没有同步过笔记");
      }
      return markdown;
    },

    searchNotes(token, accountId, query) {
      requireScope(token, "notes");
      const account = accountFor(token, accountId);
      const text = typeof query === "string" ? query : "";
      if (!text.trim() || text.length > 100) {
        throw badRequest("搜索内容为 1–100 个字");
      }
      return notes.search(account.id, text);
    },

    syncNotes(token, accountId) {
      requireScope(token, "notes");
      const account = accountFor(token, accountId);
      if (!notes.status(account.id).configured) {
        throw badRequest("这个账号还没有配置微信读书 API Key");
      }
      notes.sync(account.id, { trigger: "manual" }).catch(() => {});
      return { running: true };
    },

    async weeklyReport(token, accountId) {
      requireScope(token, "notes");
      const account = accountFor(token, accountId);
      const report = await reports.build(account.id);
      return { weekStart: report.weekStart, weekEnd: report.weekEnd, text: report.text };
    },
  };
}

module.exports = {
  createAgent,
};
