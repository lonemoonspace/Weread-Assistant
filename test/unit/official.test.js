const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { OfficialApiError, SKILL_VERSION, createOfficialApi } = require("../../src/official/api");

const KEY = "wrk-test1234567890";

// 依次返回 responses 中的结果，并记录请求
function fakePost(responses) {
  const calls = [];
  const post = async (url, payload, headers, timeoutMs, options) => {
    calls.push({ url, payload, headers, timeoutMs, options });
    const next = responses.shift();
    return typeof next === "function" ? next() : next;
  };
  return { post, calls };
}

const ok = (body) => ({ ok: true, status: 200, body: JSON.stringify(body), error: "" });

describe("微信读书官方 API 客户端", () => {
  it("参数平铺在顶层，带 api_name、skill_version 与 Bearer 鉴权", async () => {
    const { post, calls } = fakePost([ok({ errcode: 0, totalBookCount: 3 })]);
    const api = createOfficialApi({ apiKey: KEY, post, gatewayUrl: "http://gateway.test/api" });
    const body = await api.call("/user/notebooks", { count: 20, lastSort: 123 });
    assert.equal(body.totalBookCount, 3);
    assert.deepEqual(calls[0].payload, { count: 20, lastSort: 123, api_name: "/user/notebooks", skill_version: SKILL_VERSION });
    assert.equal(calls[0].headers.Authorization, `Bearer ${KEY}`);
    assert.equal(calls[0].url, "http://gateway.test/api");
    assert.ok(calls[0].options.maxBytes > 1024 * 1024);
  });

  it("没有 API Key 或格式不对时报错", () => {
    assert.throws(() => createOfficialApi({ apiKey: "" }), (e) => e instanceof OfficialApiError && e.kind === "key");
    assert.throws(() => createOfficialApi({ apiKey: "sk-123456789" }), /wrk-/);
  });

  it("errcode 非 0、HTTP 401、回包不是 JSON 时报出类别；错误信息中不出现 API Key", async () => {
    const cases = [
      [{ ok: true, status: 200, body: JSON.stringify({ errcode: -2012, errmsg: `登录超时 ${KEY}` }), error: "" }, "key"],
      [{ ok: true, status: 200, body: JSON.stringify({ errcode: 100, errmsg: "参数错误" }), error: "" }, "api"],
      [{ ok: false, status: 401, body: "", error: "" }, "key"],
      [{ ok: true, status: 200, body: "<html>", error: "" }, "format"],
      [{ ok: false, status: 400, body: "", error: "" }, "network"],
    ];
    for (const [response, kind] of cases) {
      const { post } = fakePost([response]);
      const api = createOfficialApi({ apiKey: KEY, post });
      await assert.rejects(api.call("/user/notebooks"), (e) => {
        assert.equal(e.kind, kind, JSON.stringify(response));
        assert.ok(!e.message.includes(KEY));
        return true;
      });
    }
  });

  it("499、5xx 与网络错误时重试，最多 3 次", async () => {
    const { post, calls } = fakePost([
      { ok: false, status: 499, body: "", error: "" },
      { ok: false, status: 0, body: "", error: "socket hang up" },
      ok({ errcode: 0, books: [] }),
    ]);
    const api = createOfficialApi({ apiKey: KEY, post, retryDelayMs: 1 });
    assert.deepEqual((await api.call("/user/notebooks")).books, []);
    assert.equal(calls.length, 3);

    const failing = fakePost([
      { ok: false, status: 503, body: "", error: "" },
      { ok: false, status: 503, body: "", error: "" },
      { ok: false, status: 503, body: "", error: "" },
    ]);
    const api2 = createOfficialApi({ apiKey: KEY, post: failing.post, retryDelayMs: 1 });
    await assert.rejects(api2.call("/user/notebooks"), /HTTP 503/);
    assert.equal(failing.calls.length, 3);
  });
});

const { fetchBookNotes, fetchNotebooks, organizeNotes, renderBookMarkdown } = require("../../src/official/notes");

// 按 api_name 返回预设回包的假客户端
function fakeApi(handlers) {
  const calls = [];
  return {
    calls,
    async call(apiName, params) {
      calls.push({ apiName, params });
      return handlers[apiName](params);
    },
  };
}

describe("笔记读取与整理", () => {
  it("笔记本概览按 lastSort 翻页到 hasMore 为 0", async () => {
    const pages = [
      { totalBookCount: 3, totalNoteCount: 9, hasMore: 1, books: [{ bookId: "a", book: { title: "甲" }, sort: 30, noteCount: 1, reviewCount: 1, bookmarkCount: 0 }, { bookId: "b", book: { title: "乙" }, sort: 20 }] },
      { hasMore: 0, books: [{ bookId: "c", book: { title: "丙", author: "作者" }, sort: 10, markedStatus: 1 }] },
    ];
    const api = fakeApi({ "/user/notebooks": () => pages.shift() });
    const result = await fetchNotebooks(api);
    assert.deepEqual(result.books.map((book) => book.bookId), ["a", "b", "c"]);
    assert.deepEqual([result.totalBookCount, result.totalNoteCount, result.books[2].finished, result.books[2].author], [3, 9, true, "作者"]);
    assert.deepEqual(api.calls.map((call) => call.params), [{ count: 50 }, { count: 50, lastSort: 20 }]);
  });

  it("想法按 synckey 翻页；跳过书签；按章节整理，想法挂在对应划线下面", async () => {
    const reviewPages = [
      { hasMore: 1, synckey: 2, reviews: [
        { review: { reviewId: "r1", content: "想法一", abstract: "划线二", range: "50-60", chapterUid: 1, chapterIdx: 1, createTime: 3 } },
        { review: { reviewId: "r2", content: "章节点评", chapterUid: 2, chapterIdx: 2, chapterName: "第二章", createTime: 4 } },
      ] },
      { hasMore: 0, synckey: 3, reviews: [{ review: { reviewId: "r3", content: "整本书评", star: 4, createTime: 5 } }] },
    ];
    const api = fakeApi({
      "/book/bookmarklist": () => ({
        chapters: [{ chapterUid: 1, chapterIdx: 1, title: "第一章" }],
        updated: [
          { bookmarkId: "m2", chapterUid: 1, range: "50-60", markText: "划线二", createTime: 2, type: 1 },
          { bookmarkId: "m1", chapterUid: 1, range: "5-9", markText: "划线一", createTime: 1, type: 1 },
          { bookmarkId: "bm", chapterUid: 1, range: "1-1", markText: "", createTime: 1, type: 0 },
        ],
      }),
      "/review/list/mine": () => reviewPages.shift(),
    });
    const notes = await fetchBookNotes(api, "book1");
    assert.equal(notes.highlights.length, 2, "书签不算划线");
    assert.equal(notes.reviews.length, 3);
    assert.deepEqual(api.calls.filter((call) => call.apiName === "/review/list/mine").map((call) => call.params.synckey), [0, 2]);

    const { chapters, general } = organizeNotes(notes);
    assert.deepEqual(chapters.map((chapter) => chapter.title), ["第一章", "第二章"]);
    assert.deepEqual(chapters[0].entries.map((entry) => [entry.text, entry.reviews.map((review) => review.content)]), [["划线一", []], ["划线二", ["想法一"]]]);
    assert.deepEqual(chapters[1].entries.map((entry) => entry.reviews[0].content), ["章节点评"]);
    assert.deepEqual(general.map((review) => review.content), ["整本书评"]);

    const markdown = renderBookMarkdown({ title: "测试之书", author: "某人" }, notes, { formatDate: (seconds) => `D${seconds}`, syncedAt: "2026-11-18" });
    assert.match(markdown, /^# 测试之书\n\n作者：某人 · 划线 2 条，想法与点评 3 条 · 同步于 2026-11-18\n/);
    assert.match(markdown, /## 第一章\n\n> 划线一\n\n\*D1\*\n\n> 划线二\n\n想法一\n\n\*D2\*/);
    assert.match(markdown, /## 书评与其他想法\n\n整本书评\n\n\*D5 · ★★★★\*/);
  });
});

const { countNewNotes, fetchWeeklyReport, formatDuration, renderWeeklyReport } = require("../../src/official/report");

describe("每周阅读报告", () => {
  it("时长按秒换算为小时与分钟", () => {
    assert.deepEqual([formatDuration(0), formatDuration(59), formatDuration(600), formatDuration(3600), formatDuration(3600 * 5 + 720)], [
      "0 分钟",
      "0 分钟",
      "10 分钟",
      "1 小时",
      "5 小时 12 分钟",
    ]);
  });

  it("读取这一周与前一周（baseTime 取周四正午），渲染时长、天数、对比与读得最多的书", async () => {
    const weeks = {
      current: {
        baseTime: 1762704000,
        totalReadTime: 3600 * 5 + 720,
        readDays: 6,
        dayAverageReadTime: 2674,
        readLongest: [
          { book: { title: "置身事内" }, readTime: 7800 },
          { albumInfo: { title: "有声书" }, readTime: 3900 },
          { book: { title: "没有时长" }, readTime: 0 },
          { book: { title: "第三本" }, readTime: 600 },
          { book: { title: "第四本" }, readTime: 300 },
        ],
      },
      previous: { totalReadTime: 3600 * 4 + 540 },
    };
    const api = fakeApi({ "/readdata/detail": (params) => (params.baseTime === Date.UTC(2025, 10, 13, 12) / 1000 ? weeks.current : weeks.previous) });
    const report = await fetchWeeklyReport(api, "2025-11-10");
    assert.deepEqual(api.calls.map((call) => call.params), [
      { mode: "weekly", baseTime: Date.UTC(2025, 10, 13, 12) / 1000 },
      { mode: "weekly", baseTime: Date.UTC(2025, 10, 6, 12) / 1000 },
    ]);
    assert.equal(report.startSeconds, 1762704000);
    assert.deepEqual(report.current.longest.map((item) => item.title), ["置身事内", "有声书", "第三本"]);
    const text = renderWeeklyReport(report, { weekLabel: "11-10 至 11-16", newNotes: { highlights: 12, reviews: 3, books: 2 } });
    assert.equal(
      text,
      [
        "11-10 至 11-16 阅读 5 小时 12 分钟，读了 6 天，日均 44 分钟",
        "比前一周多 1 小时 3 分钟（+25%）",
        "读得最多：《置身事内》2 小时 10 分钟；《有声书》1 小时 5 分钟；《第三本》10 分钟",
        "新增划线 12 条、想法 3 条（2 本书）",
        "数据来自微信读书 API，包含在手机上的阅读。",
      ].join("\n")
    );
  });

  it("没有阅读、前一周没有阅读、持平与减少；没有同步过笔记时不写笔记一行；回包没有 baseTime 时按北京时间周一零点", async () => {
    const make = (current, previous) => ({ current: { totalReadTime: 0, readDays: 0, dayAverageReadTime: 0, longest: [], ...current }, previous: { totalReadTime: 0, ...previous } });
    assert.equal(renderWeeklyReport(make({}, {}), { weekLabel: "W" }), "W 在微信读书中没有阅读记录。\n数据来自微信读书 API，包含在手机上的阅读。");
    assert.match(renderWeeklyReport(make({ totalReadTime: 600, readDays: 1, dayAverageReadTime: 85 }, {}), { weekLabel: "W" }), /\n前一周没有阅读记录\n/);
    assert.match(renderWeeklyReport(make({ totalReadTime: 600 }, { totalReadTime: 630 }), { weekLabel: "W" }), /\n与前一周基本持平\n/);
    assert.match(renderWeeklyReport(make({ totalReadTime: 600 }, { totalReadTime: 1200 }), { weekLabel: "W" }), /\n比前一周少 10 分钟（-50%）\n/);
    assert.match(renderWeeklyReport(make({ totalReadTime: 600 }, {}), { weekLabel: "W", newNotes: { highlights: 0, reviews: 0, books: 0 } }), /\n没有新增划线与想法\n/);

    const api = fakeApi({ "/readdata/detail": () => ({}) });
    assert.equal((await fetchWeeklyReport(api, "2025-11-10")).startSeconds, Date.UTC(2025, 10, 9, 16) / 1000);
  });

  it("新增笔记按 createTime 落在这一周内统计", () => {
    const start = 1762704000;
    const books = [
      { highlights: [{ createTime: start - 1 }, { createTime: start }, { createTime: start + 7 * 86400 - 1 }], reviews: [{ createTime: start + 7 * 86400 }] },
      { highlights: [], reviews: [{ createTime: start + 100 }] },
      { highlights: [{ createTime: 1 }], reviews: [] },
    ];
    assert.deepEqual(countNewNotes(books, start), { highlights: 2, reviews: 1, books: 2 });
  });
});
