/**
 * 用官方 API 读取本人的笔记，并整理成每本书的划线与想法、渲染为 Markdown。
 * 口径按官方 skills/notes.md：可导出的内容 = 划线（/book/bookmarklist）+ 想法与点评（/review/list/mine）；书签只有数量。
 */

const NOTEBOOK_PAGE = 50;
const REVIEW_PAGE = 50;
// 防止接口一直返回 hasMore 时无限翻页
const MAX_PAGES = 200;

const str = (value) => (value === undefined || value === null ? "" : String(value));
const int = (value) => (Number.isFinite(Number(value)) ? Math.trunc(Number(value)) : 0);

// 笔记本概览：有笔记的全部书籍，按最近笔记时间倒序
async function fetchNotebooks(api) {
  const books = [];
  let summary = { totalBookCount: 0, totalNoteCount: 0 };
  let lastSort = null;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const body = await api.call("/user/notebooks", lastSort === null ? { count: NOTEBOOK_PAGE } : { count: NOTEBOOK_PAGE, lastSort });
    if (page === 0) {
      summary = { totalBookCount: int(body.totalBookCount), totalNoteCount: int(body.totalNoteCount) };
    }
    const items = Array.isArray(body.books) ? body.books : [];
    for (const item of items) {
      const info = item.book && typeof item.book === "object" ? item.book : {};
      const bookId = str(item.bookId || info.bookId);
      if (!bookId || books.some((book) => book.bookId === bookId)) {
        continue;
      }
      books.push({
        bookId,
        title: str(info.title) || bookId,
        author: str(info.author),
        cover: str(info.cover),
        noteCount: int(item.noteCount),
        reviewCount: int(item.reviewCount),
        bookmarkCount: int(item.bookmarkCount),
        readingProgress: int(item.readingProgress),
        finished: int(item.markedStatus) === 1,
        sort: int(item.sort),
      });
    }
    if (int(body.hasMore) !== 1 || items.length === 0) {
      break;
    }
    lastSort = int(items[items.length - 1].sort);
  }
  return { ...summary, books };
}

const rangeStart = (range) => int(str(range).split("-")[0]);

// 一本书的划线与想法
async function fetchBookNotes(api, bookId) {
  const marks = await api.call("/book/bookmarklist", { bookId });
  const chapters = (Array.isArray(marks.chapters) ? marks.chapters : []).map((chapter) => ({
    chapterUid: int(chapter.chapterUid),
    chapterIdx: int(chapter.chapterIdx),
    title: str(chapter.title),
  }));
  const highlights = (Array.isArray(marks.updated) ? marks.updated : [])
    .filter((item) => int(item.type) !== 0)
    .map((item) => ({
      id: str(item.bookmarkId),
      chapterUid: int(item.chapterUid),
      range: str(item.range),
      text: str(item.markText),
      createTime: int(item.createTime),
      color: int(item.colorStyle),
    }));

  const reviews = [];
  let synckey = 0;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const body = await api.call("/review/list/mine", { bookid: bookId, synckey, count: REVIEW_PAGE });
    const items = Array.isArray(body.reviews) ? body.reviews : [];
    for (const item of items) {
      const review = item && item.review && typeof item.review === "object" ? item.review : item || {};
      const id = str(review.reviewId);
      if (reviews.some((existing) => existing.id === id && id)) {
        continue;
      }
      reviews.push({
        id,
        content: str(review.content),
        abstract: str(review.abstract),
        range: str(review.range),
        chapterUid: int(review.chapterUid),
        chapterIdx: int(review.chapterIdx),
        chapterName: str(review.chapterName),
        createTime: int(review.createTime),
        star: review.star === undefined ? -1 : int(review.star),
      });
    }
    const next = int(body.synckey);
    if (int(body.hasMore) !== 1 || items.length === 0 || next === synckey) {
      break;
    }
    synckey = next;
  }
  return { chapters, highlights, reviews };
}

// 按章节整理：每章的划线按位置排序，能对上的想法挂在划线下面；对不上划线但有原文的想法单独成条；
// 没有章节的想法（整本书评等）放在 general 中
function organizeNotes({ chapters, highlights, reviews }) {
  const byChapter = new Map();
  const chapterOf = (uid, review = null) => {
    if (!byChapter.has(uid)) {
      const known = chapters.find((chapter) => chapter.chapterUid === uid);
      byChapter.set(uid, {
        chapterUid: uid,
        chapterIdx: known ? known.chapterIdx : review ? review.chapterIdx : 0,
        title: known ? known.title : (review && review.chapterName) || `章节 ${uid}`,
        entries: [],
      });
    }
    return byChapter.get(uid);
  };
  for (const highlight of highlights) {
    chapterOf(highlight.chapterUid).entries.push({ ...highlight, reviews: [] });
  }
  const general = [];
  for (const review of reviews) {
    if (!review.chapterUid) {
      general.push(review);
      continue;
    }
    const chapter = chapterOf(review.chapterUid, review);
    const match = review.range ? chapter.entries.find((entry) => entry.range && entry.range === review.range) : null;
    if (match) {
      match.reviews.push(review);
    } else {
      // 想法对应的划线已删除，或者是章节点评：以想法自己的原文（如果有）成条
      chapter.entries.push({ id: `review-${review.id}`, chapterUid: review.chapterUid, range: review.range, text: review.abstract, createTime: review.createTime, color: 0, reviews: [review] });
    }
  }
  const ordered = [...byChapter.values()].sort((a, b) => a.chapterIdx - b.chapterIdx || a.chapterUid - b.chapterUid);
  for (const chapter of ordered) {
    chapter.entries.sort((a, b) => rangeStart(a.range) - rangeStart(b.range) || a.createTime - b.createTime);
  }
  general.sort((a, b) => a.createTime - b.createTime);
  return { chapters: ordered, general };
}

// Markdown 中的引用：每行前加 “> ”
const quote = (text) => str(text).split(/\r?\n/).map((line) => `> ${line}`).join("\n");

// formatDate(unixSeconds) → YYYY-MM-DD（按面板时区，由调用方提供）
function renderBookMarkdown(book, notes, { formatDate, syncedAt = "" }) {
  const { chapters, general } = organizeNotes(notes);
  const lines = [`# ${book.title}`, ""];
  const meta = [];
  if (book.author) {
    meta.push(`作者：${book.author}`);
  }
  meta.push(`划线 ${notes.highlights.length} 条，想法与点评 ${notes.reviews.length} 条`);
  if (syncedAt) {
    meta.push(`同步于 ${syncedAt}`);
  }
  lines.push(meta.join(" · "), "");
  for (const chapter of chapters) {
    lines.push(`## ${chapter.title}`, "");
    for (const entry of chapter.entries) {
      if (entry.text) {
        lines.push(quote(entry.text), "");
      }
      for (const review of entry.reviews) {
        if (review.content) {
          lines.push(`${review.content.trim()}`, "");
        }
      }
      lines.push(`*${formatDate(entry.createTime)}*`, "");
    }
  }
  if (general.length > 0) {
    lines.push("## 书评与其他想法", "");
    for (const review of general) {
      const stars = review.star > 0 ? ` · ${"★".repeat(Math.min(5, review.star))}` : "";
      if (review.abstract) {
        lines.push(quote(review.abstract), "");
      }
      lines.push(review.content.trim() || "（无内容）", "", `*${formatDate(review.createTime)}${stars}*`, "");
    }
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

module.exports = {
  fetchBookNotes,
  fetchNotebooks,
  organizeNotes,
  renderBookMarkdown,
};
