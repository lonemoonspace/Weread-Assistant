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
