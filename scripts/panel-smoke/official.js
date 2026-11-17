// 面板 smoke：微信读书官方 API（API Key 配置与测试、笔记同步）。网关为 scripts/fixtures/mock-official.js

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { until } = require("./helpers");
const { startMockOfficial } = require("../fixtures/mock-official");

const KEY = "wrk-smoke-key-123456";

const BOOKS = [
  {
    bookId: "100001",
    title: "测试之书",
    author: "某作者",
    sort: 1763000000,
    noteCount: 2,
    reviewCount: 1,
    bookmarkCount: 1,
    chapters: [
      { chapterUid: 1, chapterIdx: 1, title: "第一章" },
      { chapterUid: 2, chapterIdx: 2, title: "第二章" },
    ],
    bookmarks: [
      { bookmarkId: "100001_1_10-20", bookId: "100001", chapterUid: 1, markText: "第一段划线", createTime: 1762000000, type: 1, range: "10-20", colorStyle: 1 },
      { bookmarkId: "100001_2_5-9", bookId: "100001", chapterUid: 2, markText: "第二段划线", createTime: 1762100000, type: 1, range: "5-9", colorStyle: 2 },
    ],
    reviews: [
      { reviewId: "r1", content: "我的想法", abstract: "第一段划线", range: "10-20", chapterUid: 1, chapterIdx: 1, createTime: 1762000100, star: -1, chapterName: "第一章" },
    ],
  },
];

module.exports = async function officialScenarios({ scenario, startAuthed }) {
  await scenario("微信读书 API Key：只能在账号中设置、格式校验、只返回掩码；测试 API Key 成功与失败", async () => {
    const gateway = await startMockOfficial({ key: KEY, data: { books: BOOKS } });
    try {
      const panel = await startAuthed({ officialApi: { gatewayUrl: gateway.url, retryDelayMs: 1 } });
      await panel.call("POST", "api/accounts", { id: "me" });

      const schema = (await panel.call("GET", "api/schema")).json;
      const field = schema.fields.find((item) => item.key === "wereadApiKey");
      assert.deepStrictEqual([field.secret, field.accountOnly, field.group], [true, true, "official"]);
      assert.strictEqual((await panel.call("PATCH", "api/settings", { defaults: { wereadApiKey: KEY } })).status, 400, "全局默认中不能设置");
      assert.strictEqual((await panel.call("PATCH", "api/accounts/me", { overrides: { wereadApiKey: "sk-123" } })).status, 400, "格式不对");

      // 没有配置时 400
      assert.strictEqual((await panel.call("POST", "api/accounts/me/official/test", {})).status, 400);

      assert.strictEqual((await panel.call("PATCH", "api/accounts/me", { overrides: { wereadApiKey: KEY } })).status, 200);
      const account = (await panel.call("GET", "api/accounts/me")).json.account;
      assert.strictEqual(account.overrides.wereadApiKey, "••••••", "只返回掩码");

      const tested = await panel.call("POST", "api/accounts/me/official/test", {});
      assert.deepStrictEqual(tested.json, { ok: true, totalBookCount: 1, totalNoteCount: 4, upgradeInfo: "" });
      const last = gateway.requests.at(-1);
      assert.deepStrictEqual([last.api_name, last.count, typeof last.skill_version], ["/user/notebooks", 1, "string"]);

      // 换成网关不认的 key：返回失败原因，不出现 key
      const wrong = "wrk-wrong-key-123456";
      await panel.call("PATCH", "api/accounts/me", { overrides: { wereadApiKey: wrong } });
      const failed = (await panel.call("POST", "api/accounts/me/official/test", {})).json;
      assert.deepStrictEqual([failed.ok, failed.kind], [false, "key"]);
      assert.ok(!failed.error.includes(wrong));
    } finally {
      await gateway.close();
    }
  });

  await scenario("笔记同步：写入 index.json、每本书的 JSON 与 Markdown；只重新读取有变化的书；删光笔记的书保留并标记；失败时记下原因", async () => {
    const books = JSON.parse(JSON.stringify(BOOKS));
    books.push({ ...JSON.parse(JSON.stringify(BOOKS[0])), bookId: "100002", title: "另一本/书", sort: 1762000000, noteCount: 1, reviewCount: 0, bookmarkCount: 0, reviews: [] });
    books[1].bookmarks = [books[1].bookmarks[0]];
    const gateway = await startMockOfficial({ key: KEY, data: { books } });
    try {
      const panel = await startAuthed({ officialApi: { gatewayUrl: gateway.url, retryDelayMs: 1 }, notes: { delayMs: 0 } });
      await panel.call("POST", "api/accounts", { id: "me" });
      assert.strictEqual((await panel.call("POST", "api/accounts/me/notes/sync", {})).status, 400, "没有 API Key 时 400");
      await panel.call("PATCH", "api/accounts/me", { overrides: { wereadApiKey: KEY } });

      const started = await panel.call("POST", "api/accounts/me/notes/sync", {});
      assert.strictEqual(started.status, 202);
      await until(async () => {
        const status = (await panel.call("GET", "api/accounts/me/notes")).json;
        return !status.running && status.syncedAt;
      }, { message: "笔记同步应完成" });
      const status = (await panel.call("GET", "api/accounts/me/notes")).json;
      assert.deepStrictEqual(
        [status.configured, status.totalBookCount, status.lastError, status.books.map((book) => [book.bookId, book.file, book.highlightCount, book.reviewItemCount])],
        [true, 2, "", [["100001", "测试之书.md", 2, 1], ["100002", "另一本_书.md", 1, 0]]]
      );

      const notesDir = path.join(panel.options.dataDir, "accounts", "me", "notes");
      const markdown = fs.readFileSync(path.join(notesDir, "markdown", "测试之书.md"), "utf8");
      assert.match(markdown, /^# 测试之书\n/);
      assert.match(markdown, /## 第一章\n\n> 第一段划线\n\n我的想法\n/);
      assert.match(markdown, /## 第二章\n\n> 第二段划线\n/);
      assert.strictEqual(fs.statSync(path.join(notesDir, "index.json")).mode & 0o777, 0o600);
      const detail = (await panel.call("GET", "api/accounts/me/notes/books/100001")).json;
      assert.deepStrictEqual(detail.chapters.map((chapter) => chapter.entries.length), [1, 1]);
      assert.strictEqual((await panel.call("GET", "api/accounts/me/notes/books/nope")).status, 404);

      // 再同步一次：没有变化的书不再读取；第二本删光了笔记：保留并标记 removed
      const before = gateway.requests.length;
      gateway.data.books.pop();
      await panel.notes.sync("me");
      const fetchedAgain = gateway.requests.slice(before).filter((request) => request.api_name !== "/user/notebooks");
      assert.deepStrictEqual(fetchedAgain, [], "没有变化时只读取概览");
      const after = (await panel.call("GET", "api/accounts/me/notes")).json;
      assert.deepStrictEqual(after.books.map((book) => [book.bookId, Boolean(book.removed)]), [["100001", false], ["100002", true]]);
      assert.ok(fs.existsSync(path.join(notesDir, "markdown", "另一本_书.md")), "删光笔记的书保留文件");

      // 有新想法：只重新读取这本书
      gateway.data.books[0].sort += 100;
      gateway.data.books[0].reviewCount += 1;
      gateway.data.books[0].reviews.push({ reviewId: "r2", content: "新想法", createTime: 1763000000, star: 5 });
      const mark = gateway.requests.length;
      await panel.notes.sync("me");
      assert.deepStrictEqual(
        [...new Set(gateway.requests.slice(mark).map((request) => request.api_name))],
        ["/user/notebooks", "/book/bookmarklist", "/review/list/mine"]
      );
      assert.match(fs.readFileSync(path.join(notesDir, "markdown", "测试之书.md"), "utf8"), /## 书评与其他想法\n\n新想法/);

      // API Key 失效：记下原因，保留已同步的内容
      await panel.call("PATCH", "api/accounts/me", { overrides: { wereadApiKey: "wrk-expired-key-1234" } });
      await assert.rejects(panel.notes.sync("me"));
      const failed = (await panel.call("GET", "api/accounts/me/notes")).json;
      assert.match(failed.lastError, /API Key/);
      assert.strictEqual(failed.books.length, 2);
    } finally {
      await gateway.close();
    }
  });

  await scenario("笔记同步：每天到设定时间自动同步一次；失败时按账号的通知配置发送失败通知，当天不再自动重试", async () => {
    const gateway = await startMockOfficial({ key: KEY, data: { books: JSON.parse(JSON.stringify(BOOKS)) } });
    const sent = [];
    const clock = { offset: 0, now: () => Date.now() + clock.offset, setInterval: () => null, clearInterval: () => {} };
    try {
      const panel = await startAuthed({
        officialApi: { gatewayUrl: gateway.url, retryDelayMs: 1 },
        notes: { delayMs: 0, clock, notify: async (config, body) => sent.push(body) },
      });
      await panel.call("PATCH", "api/settings", { settings: { notesSyncAt: "04:30" } });
      assert.strictEqual((await panel.call("PATCH", "api/settings", { settings: { notesSyncAt: "4:30" } })).status, 400);
      for (const id of ["ok-a", "bad-b", "none-c"]) {
        await panel.call("POST", "api/accounts", { id });
      }
      await panel.call("PATCH", "api/accounts/ok-a", { overrides: { wereadApiKey: KEY } });
      await panel.call("PATCH", "api/accounts/bad-b", { overrides: { wereadApiKey: "wrk-wrong-key-123456" } });
      const { zonedTime } = require("../../src/panel/planner");
      const { dateInZone } = require("../../src/panel/dates");
      const today = dateInZone(new Date(), "Asia/Shanghai");
      clock.offset = zonedTime(today, "04:29", "Asia/Shanghai") - Date.now();
      panel.notes.tick();
      assert.strictEqual(gateway.requests.length, 0, "时间没到不同步");
      clock.offset = zonedTime(today, "04:31", "Asia/Shanghai") - Date.now();
      panel.notes.tick();
      await until(() => !panel.notes.isRunning("ok-a") && !panel.notes.isRunning("bad-b") && sent.length === 1, { message: "两个账号都应同步完" });
      assert.ok(panel.notes.status("ok-a").syncedAt);
      assert.match(sent[0], /^笔记同步失败：.*API Key/);
      const count = gateway.requests.length;
      panel.notes.tick();
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.strictEqual(gateway.requests.length, count, "当天不再自动同步");
      assert.strictEqual(panel.notes.status("none-c").syncedAt, null);
    } finally {
      await gateway.close();
    }
  });
};
