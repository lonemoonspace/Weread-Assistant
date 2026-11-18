const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { HEAT_WEEKS, buildJournal, flattenNotes, heatLevel, noteStreak } = require("../../src/panel/journal");

const TZ = "Asia/Shanghai";
// 上海时间某天 12:00 的 unix 秒
const at = (date, hour = 12) => Date.parse(`${date}T${String(hour).padStart(2, "0")}:00:00+08:00`) / 1000;

function book(bookId, title, highlights, reviews = []) {
  return {
    bookId,
    title,
    author: "作者",
    chapters: [
      { chapterUid: 1, chapterIdx: 1, title: "第一章" },
      { chapterUid: 2, chapterIdx: 2, title: "第二章" },
    ],
    highlights: highlights.map(([id, chapterUid, text, date, range], i) => ({ id, chapterUid, text, createTime: at(date), range: range || `${i * 10}-${i * 10 + 5}`, color: 1 })),
    reviews,
  };
}

describe("读书日记", () => {
  const books = [
    book("b1", "置身事内", [
      ["h1", 1, "经济发展的核心在于协调。", "2026-11-18", "10-20"],
      ["h2", 2, "土地财政是理解地方政府的钥匙。", "2026-11-17"],
    ], [
      { id: "r1", chapterUid: 1, range: "10-20", content: "协调成本是关键", abstract: "", createTime: at("2026-11-18", 13), star: -1 },
      { id: "r2", chapterUid: 0, range: "", content: "推荐", abstract: "", createTime: at("2026-11-16"), star: 5 },
    ]),
    book("b2", "人类简史", [
      ["h3", 1, "虚构故事让大规模协调成为可能。", "2026-11-18"],
      ["h4", 1, "农业革命是史上最大的骗局。", "2025-11-18"],
      ["h5", 1, "没有时间的划线", "2026-11-01"],
    ]),
  ];
  books[1].highlights[2].createTime = 0;

  it("摊平笔记：划线带上它的想法，书评单独成条，按时间倒序；没有时间的跳过", () => {
    const items = flattenNotes(books, TZ);
    assert.deepEqual(
      items.map((item) => [item.title, item.text || item.reviews[0], item.date]),
      [
        // 时间相同时按书与笔记的 ID 排，结果稳定
        ["置身事内", "经济发展的核心在于协调。", "2026-11-18"],
        ["人类简史", "虚构故事让大规模协调成为可能。", "2026-11-18"],
        ["置身事内", "土地财政是理解地方政府的钥匙。", "2026-11-17"],
        ["置身事内", "推荐", "2026-11-16"],
        ["人类简史", "农业革命是史上最大的骗局。", "2025-11-18"],
      ]
    );
    const first = items.find((item) => item.text === "经济发展的核心在于协调。");
    assert.deepEqual([first.chapter, first.reviews], ["第一章", ["协调成本是关键"]]);
    assert.equal(items.find((item) => item.reviews[0] === "推荐").chapter, "");
  });

  it("日期按面板时区：上海时间凌晨的笔记算当天", () => {
    const items = flattenNotes([book("b9", "书", [["x", 1, "凌晨", "2026-11-18"]])].map((b) => {
      b.highlights[0].createTime = at("2026-11-18", 1);
      return b;
    }), TZ);
    assert.equal(items[0].date, "2026-11-18");
    assert.equal(flattenNotes([book("b9", "书", [["x", 1, "凌晨", "2026-11-18"]])], "UTC")[0].date, "2026-11-18");
  });

  it("第一页按天分组，并带笔记日历、本月数字与往年今天", () => {
    const journal = buildJournal(flattenNotes(books, TZ), { today: "2026-11-18" });
    assert.deepEqual(
      journal.days.map((day) => [day.date, day.daysAgo, day.books, day.items.length]),
      [
        ["2026-11-18", 0, 2, 2],
        ["2026-11-17", 1, 1, 1],
        ["2026-11-16", 2, 1, 1],
        ["2025-11-18", 365, 1, 1],
      ]
    );
    assert.equal(journal.days[0].weekday, 2);
    assert.equal(journal.next, "");
    assert.equal(journal.total, 5);
    assert.deepEqual(journal.stats, { monthNotes: 4, monthBooks: 2, streak: 3 });
    assert.equal(journal.heat.length, HEAT_WEEKS * 7);
    // 从 11 周前的周一开始，今天之后为空
    assert.equal(journal.heat[0].date, "2026-08-31");
    const today = journal.heat.find((cell) => cell.date === "2026-11-18");
    assert.deepEqual([today.notes, today.level], [2, 2]);
    assert.deepEqual(journal.heat[journal.heat.length - 1], { date: "2026-11-22", notes: null, level: -1 });
    assert.deepEqual(journal.onThisDay.map((item) => [item.text, item.yearsAgo]), [["农业革命是史上最大的骗局。", 1]]);
  });

  it("翻页：同一天的笔记不拆开，before 取更早的一页，不带汇总", () => {
    const items = flattenNotes(books, TZ);
    const first = buildJournal(items, { today: "2026-11-18", pageEntries: 2 });
    assert.deepEqual(first.days.map((day) => day.date), ["2026-11-18"]);
    assert.equal(first.next, "2026-11-18");
    const second = buildJournal(items, { today: "2026-11-18", before: first.next, pageEntries: 2 });
    assert.deepEqual(second.days.map((day) => day.date), ["2026-11-17", "2026-11-16"]);
    assert.equal(second.next, "2026-11-16");
    assert.equal(second.heat, undefined);
    const last = buildJournal(items, { today: "2026-11-18", before: second.next, pageEntries: 2 });
    assert.deepEqual([last.days.map((day) => day.date), last.next], [["2025-11-18"], ""]);
  });

  it("没有笔记时为空", () => {
    const journal = buildJournal([], { today: "2026-11-18" });
    assert.deepEqual([journal.days, journal.next, journal.stats, journal.onThisDay], [[], "", { monthNotes: 0, monthBooks: 0, streak: 0 }, []]);
    assert.ok(journal.heat.every((cell) => cell.level <= 0));
  });

  it("连续天数：今天还没有笔记时从昨天算起", () => {
    assert.equal(noteStreak(new Set(["2026-11-17", "2026-11-16"]), "2026-11-18"), 2);
    assert.equal(noteStreak(new Set(["2026-11-18", "2026-11-17"]), "2026-11-18"), 2);
    assert.equal(noteStreak(new Set(["2026-11-16"]), "2026-11-18"), 0);
  });

  it("颜色档位", () => {
    assert.deepEqual([0, 1, 2, 3, 4, 6, 7, 20].map(heatLevel), [0, 1, 2, 2, 3, 3, 4, 4]);
  });
});
