const fs = require("fs");
const path = require("path");
const { createNotifier } = require("../notify");
const { OfficialApiError, createOfficialApi } = require("../official/api");
const { fetchBookNotes, fetchNotebooks, organizeNotes, renderBookMarkdown } = require("../official/notes");
const { ensurePrivateDir, writeFileAtomic } = require("../shared/files");
const { accountDataDir, resolveAccountConfig } = require("./config");
const { dateInZone } = require("./dates");
const { buildJournal, flattenNotes } = require("./journal");

/**
 * 笔记同步：用账号的微信读书 API Key 读取本人的笔记，保存到账号数据目录的 notes/ 中：
 *   notes/index.json            有笔记的书、各书的数量、最近一次同步的时间与错误
 *   notes/books/<bookId>.json   一本书的章节、划线与想法（官方回包整理后的字段）
 *   notes/markdown/<书名>.md     同一内容的 Markdown，按章节整理，想法挂在对应划线下面
 * 只重新读取最近笔记时间（sort）或数量有变化的书；在微信读书中删光了笔记的书保留文件，标记 removed。
 * 每天到面板设置 notesSyncAt 自动同步一次（tick 每分钟调用），也可以手动同步；同一账号同一时间只同步一次。
 */

const INDEX_VERSION = 1;
const DEFAULT_DELAY_MS = 300;
const TICK_MS = 60000;

const systemClock = {
  now: () => Date.now(),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (timer) => clearInterval(timer),
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 文件名中不能出现的字符换成下划线，过长的截断
function safeFileName(title) {
  const cleaned = [...String(title)]
    .map((char) => (char.charCodeAt(0) < 32 || '\\/:*?"<>|'.includes(char) ? "_" : char))
    .join("")
    .replace(/\s+/g, " ")
    .replace(/^[.\s]+|[.\s]+$/g, "")
    .slice(0, 80);
  return cleaned || "未命名";
}

// 各书的 Markdown 文件名：书名重复时加上 bookId
function markdownNames(books) {
  const counts = new Map();
  for (const book of books) {
    const name = safeFileName(book.title);
    counts.set(name, (counts.get(name) || 0) + 1);
  }
  return new Map(books.map((book) => {
    const name = safeFileName(book.title);
    return [book.bookId, counts.get(name) > 1 ? `${name} (${book.bookId}).md` : `${name}.md`];
  }));
}

async function sendNotesFailure(config, body) {
  const notifier = createNotifier(config);
  notifier.event("failure", body);
  await notifier.flush();
}

function createNotesService({ dataDir, store, officialOptions = {}, clock = systemClock, notify = sendNotesFailure, delayMs = DEFAULT_DELAY_MS }) {
  const panelDataDir = path.resolve(dataDir);
  const running = new Map();
  // 每个账号最近一次自动同步的日期（含失败）：失败后当天不再自动重试，避免每分钟请求一次
  const autoAttempted = new Map();
  let tickTimer = null;

  const notesDir = (accountId) => path.join(accountDataDir(panelDataDir, accountId), "notes");
  const indexFile = (accountId) => path.join(notesDir(accountId), "index.json");
  const bookFile = (accountId, bookId) => path.join(notesDir(accountId), "books", `${bookId}.json`);
  const markdownDir = (accountId) => path.join(notesDir(accountId), "markdown");

  function readJson(file) {
    try {
      return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (_) {
      return null;
    }
  }

  function readIndex(accountId) {
    const index = readJson(indexFile(accountId));
    return index && typeof index === "object" && Array.isArray(index.books) ? index : null;
  }

  function writeJson(file, value) {
    ensurePrivateDir(path.dirname(file));
    writeFileAtomic(file, JSON.stringify(value, null, 2), { mode: 0o600 });
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

  // 账号的同步状态与书单（接口与页面使用）
  function status(accountId) {
    const config = configFor(accountId);
    const index = readIndex(accountId);
    return {
      configured: Boolean(config && config.wereadApiKey),
      running: running.has(accountId),
      syncedAt: index ? index.syncedAt || null : null,
      lastError: index ? index.lastError || "" : "",
      lastErrorAt: index ? index.lastErrorAt || null : null,
      totalBookCount: index ? index.totalBookCount || 0 : 0,
      totalNoteCount: index ? index.totalNoteCount || 0 : 0,
      books: index ? index.books : [],
    };
  }

  // 一本书整理后的笔记（页面使用）；没有同步过时为 null
  function book(accountId, bookId) {
    if (!/^[\w-]{1,64}$/.test(bookId)) {
      return null;
    }
    const saved = readJson(bookFile(accountId, bookId));
    if (!saved) {
      return null;
    }
    const entry = (readIndex(accountId) || { books: [] }).books.find((item) => item.bookId === bookId) || null;
    return { book: entry || { bookId, title: saved.title, author: saved.author }, syncedAt: saved.syncedAt, ...organizeNotes(saved) };
  }

  // 一本书的 Markdown 文件路径与文件名；没有时为 null
  function markdownOf(accountId, bookId) {
    const entry = (readIndex(accountId) || { books: [] }).books.find((item) => item.bookId === bookId);
    if (!entry || !entry.file) {
      return null;
    }
    const file = path.join(markdownDir(accountId), entry.file);
    return fs.existsSync(file) ? { file, name: entry.file } : null;
  }

  // 在已同步的划线与想法中搜索（不区分大小写），返回最多 limit 条：{ bookId, title, chapter, text, reviews }
  function search(accountId, query, { limit = 100 } = {}) {
    const needle = String(query || "").trim().toLowerCase();
    const hits = [];
    if (!needle) {
      return { hits, truncated: false };
    }
    const has = (text) => String(text || "").toLowerCase().includes(needle);
    for (const entry of (readIndex(accountId) || { books: [] }).books) {
      const saved = readJson(bookFile(accountId, entry.bookId));
      if (!saved || !Array.isArray(saved.highlights) || !Array.isArray(saved.reviews)) {
        continue;
      }
      const { chapters, general } = organizeNotes(saved);
      const items = [
        ...chapters.flatMap((chapter) => chapter.entries.map((item) => ({ chapter: chapter.title, text: item.text, reviews: item.reviews }))),
        ...general.map((review) => ({ chapter: "", text: review.abstract, reviews: [review] })),
      ];
      for (const item of items) {
        if (has(item.text) || item.reviews.some((review) => has(review.content))) {
          if (hits.length >= limit) {
            return { hits, truncated: true };
          }
          hits.push({
            bookId: entry.bookId,
            title: entry.title,
            chapter: item.chapter,
            text: item.text,
            reviews: item.reviews.map((review) => review.content).filter(Boolean),
          });
        }
      }
    }
    return { hits, truncated: false };
  }

  // 已同步的全部书的划线与想法（每周报告统计新增笔记用）；还没有同步过时为 null
  function syncedBooks(accountId) {
    const index = readIndex(accountId);
    if (!index || !index.syncedAt) {
      return null;
    }
    return index.books
      .map((entry) => readJson(bookFile(accountId, entry.bookId)))
      .filter((saved) => saved && Array.isArray(saved.highlights) && Array.isArray(saved.reviews));
  }

  // 读书日记：按日期排列的笔记。摊平后的笔记按账号缓存，同步（成功或失败）后与时区变化后重建
  const journalCache = new Map();
  function journal(accountId, { before = "" } = {}) {
    const index = readIndex(accountId);
    const { timezone } = store.get().settings;
    const today = dateInZone(new Date(clock.now()), timezone);
    if (!index || !index.syncedAt) {
      return { synced: false, ...buildJournal([], { today, before }) };
    }
    const key = `${index.syncedAt}|${index.lastErrorAt || ""}|${timezone}`;
    let cached = journalCache.get(accountId);
    if (!cached || cached.key !== key) {
      cached = { key, items: flattenNotes(syncedBooks(accountId) || [], timezone) };
      journalCache.set(accountId, cached);
    }
    return { synced: true, ...buildJournal(cached.items, { today, before }) };
  }

  // 全部书的 Markdown 合成一份（按书单顺序，已没有笔记的书在最后）；还没有同步过时为 null
  function allMarkdown(accountId) {
    const index = readIndex(accountId);
    if (!index) {
      return null;
    }
    const parts = [];
    for (const entry of index.books) {
      try {
        parts.push(fs.readFileSync(path.join(markdownDir(accountId), entry.file), "utf8").trimEnd());
      } catch (_) {
        // 文件缺失（例如被手工删除）：跳过，下次同步时补上
      }
    }
    return parts.length > 0 ? `${parts.join("\n\n---\n\n")}\n` : null;
  }

  async function runSync(accountId, trigger) {
    const config = configFor(accountId);
    if (!config || !config.wereadApiKey) {
      throw new OfficialApiError("key", "这个账号还没有配置微信读书 API Key");
    }
    const { timezone } = store.get().settings;
    const formatDate = (seconds) => (seconds ? dateInZone(new Date(seconds * 1000), timezone) : "");
    const api = createOfficialApi({ apiKey: config.wereadApiKey, ...officialOptions });
    const previous = readIndex(accountId) || { books: [] };
    const previousById = new Map(previous.books.map((entry) => [entry.bookId, entry]));
    const next = new Map(previousById);
    const startedAt = new Date(clock.now()).toISOString();
    let fetched = 0;
    let summary = { totalBookCount: previous.totalBookCount || 0, totalNoteCount: previous.totalNoteCount || 0 };

    const saveIndex = (extra) => {
      writeJson(indexFile(accountId), {
        version: INDEX_VERSION,
        ...summary,
        syncedAt: previous.syncedAt || null,
        lastError: "",
        lastErrorAt: null,
        ...extra,
        books: [...next.values()].sort((a, b) => Number(Boolean(a.removed)) - Number(Boolean(b.removed)) || b.sort - a.sort),
      });
    };

    try {
      const notebooks = await fetchNotebooks(api);
      summary = { totalBookCount: notebooks.totalBookCount, totalNoteCount: notebooks.totalNoteCount };
      const names = markdownNames(notebooks.books);
      const current = new Set();
      for (const item of notebooks.books) {
        current.add(item.bookId);
        const old = previousById.get(item.bookId);
        const file = names.get(item.bookId);
        const unchanged =
          old &&
          !old.removed &&
          old.sort === item.sort &&
          old.noteCount === item.noteCount &&
          old.reviewCount === item.reviewCount &&
          fs.existsSync(bookFile(accountId, item.bookId));
        if (unchanged && old.file === file && fs.existsSync(path.join(markdownDir(accountId), file))) {
          next.set(item.bookId, { ...old, ...item, file });
          continue;
        }
        let notes;
        if (unchanged) {
          notes = readJson(bookFile(accountId, item.bookId));
        } else {
          if (fetched > 0 && delayMs > 0) {
            await sleep(delayMs);
          }
          notes = await fetchBookNotes(api, item.bookId);
          fetched += 1;
          writeJson(bookFile(accountId, item.bookId), { bookId: item.bookId, title: item.title, author: item.author, syncedAt: startedAt, ...notes });
        }
        const markdown = renderBookMarkdown(item, notes, { formatDate, syncedAt: formatDate(Math.floor(clock.now() / 1000)) });
        ensurePrivateDir(markdownDir(accountId));
        writeFileAtomic(path.join(markdownDir(accountId), file), markdown, { mode: 0o600 });
        if (old && old.file && old.file !== file) {
          fs.rmSync(path.join(markdownDir(accountId), old.file), { force: true });
        }
        next.set(item.bookId, { ...item, file, highlightCount: notes.highlights.length, reviewItemCount: notes.reviews.length });
      }
      // 在微信读书中已经没有笔记的书：保留文件作为备份，标记 removed
      for (const [bookId, entry] of next) {
        if (!current.has(bookId) && !entry.removed) {
          next.set(bookId, { ...entry, removed: true, removedAt: startedAt });
        }
      }
      saveIndex({ syncedAt: startedAt });
      console.info(`笔记同步完成：账号 ${accountId}（${trigger === "auto" ? "每日自动" : "手动"}），${notebooks.books.length} 本书，重新读取 ${fetched} 本`);
      return { books: notebooks.books.length, fetched };
    } catch (e) {
      const message = e instanceof OfficialApiError ? e.message : `同步出错：${e.message}`;
      try {
        saveIndex({ lastError: message, lastErrorAt: new Date(clock.now()).toISOString() });
      } catch (writeError) {
        console.error(`保存笔记同步状态失败：账号 ${accountId}:`, writeError.message);
      }
      console.warn(`笔记同步失败：账号 ${accountId}：${message}`);
      if (trigger === "auto") {
        notify(config, `笔记同步失败：${message}`).catch((error) => console.warn("发送笔记同步失败通知出错:", error.message));
      }
      throw e instanceof OfficialApiError ? e : new OfficialApiError("api", message);
    }
  }

  // 开始同步：返回 Promise。已经在同步时返回同一个 Promise
  function sync(accountId, { trigger = "manual" } = {}) {
    if (running.has(accountId)) {
      return running.get(accountId);
    }
    const promise = runSync(accountId, trigger).finally(() => running.delete(accountId));
    running.set(accountId, promise);
    return promise;
  }

  // 每天到 notesSyncAt 之后，为配置了 API Key 的启用账号同步一次（今天已经同步或自动尝试过的跳过）
  function tick() {
    const data = store.get();
    const { timezone, notesSyncAt } = data.settings;
    const now = new Date(clock.now());
    const today = dateInZone(now, timezone);
    const time = new Intl.DateTimeFormat("en-GB", { timeZone: timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(now);
    if (time < notesSyncAt) {
      return;
    }
    for (const account of data.accounts) {
      if (!account.enabled || running.has(account.id) || autoAttempted.get(account.id) === today) {
        continue;
      }
      const config = configFor(account.id);
      if (!config || !config.wereadApiKey) {
        continue;
      }
      const index = readIndex(account.id);
      if (index && index.syncedAt && dateInZone(new Date(index.syncedAt), timezone) === today) {
        autoAttempted.set(account.id, today);
        continue;
      }
      autoAttempted.set(account.id, today);
      sync(account.id, { trigger: "auto" }).catch(() => {});
    }
  }

  return {
    status,
    book,
    markdownOf,
    allMarkdown,
    search,
    syncedBooks,
    journal,
    sync,
    tick,
    isRunning: (accountId) => running.has(accountId),
    start() {
      tickTimer = clock.setInterval(tick, TICK_MS);
      if (tickTimer && typeof tickTimer.unref === "function") {
        tickTimer.unref();
      }
    },
    // 等进行中的同步结束（面板停止时调用）
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
  createNotesService,
  safeFileName,
};
