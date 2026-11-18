/**
 * 读书日记：把已同步的划线与想法按记下的日期（面板时区）排成时间线，并统计笔记日历、本月数字与“往年今天”。
 * 只用已同步到本地的笔记，不请求微信读书。
 */

const { organizeNotes } = require("../official/notes");
const { addDays, dateInZone, daysBetween, weekdayIndex } = require("./dates");

// 时间线每页至少这么多条（同一天的笔记不拆到两页）
const PAGE_ENTRIES = 40;
// 笔记日历：最近 12 周
const HEAT_WEEKS = 12;
// 往年今天最多显示几条
const ON_THIS_DAY_LIMIT = 3;

// 当天笔记条数 → 颜色档位 0–4
function heatLevel(count) {
  if (count <= 0) {
    return 0;
  }
  if (count === 1) {
    return 1;
  }
  if (count <= 3) {
    return 2;
  }
  return count <= 6 ? 3 : 4;
}

/**
 * 全部书的笔记摊平成一条一条，按时间倒序。books：[{ bookId, title, author, highlights, reviews, chapters }]
 * 划线带上它的想法，日期按划线的时间；没有对应划线的想法与书评按想法的时间
 */
function flattenNotes(books, timezone) {
  const items = [];
  for (const book of books) {
    const { chapters, general } = organizeNotes(book);
    const push = (entry, chapter) => {
      const createTime = Number(entry.createTime) || 0;
      if (!createTime) {
        return;
      }
      items.push({
        id: `${book.bookId}:${entry.id}`,
        bookId: book.bookId,
        title: book.title,
        author: book.author || "",
        chapter,
        text: entry.text || "",
        reviews: entry.reviews.map((review) => review.content).filter(Boolean),
        createTime,
        date: dateInZone(new Date(createTime * 1000), timezone),
      });
    };
    for (const chapter of chapters) {
      for (const entry of chapter.entries) {
        push(entry, chapter.title);
      }
    }
    for (const review of general) {
      push({ id: `review-${review.id}`, text: review.abstract, createTime: review.createTime, reviews: [review] }, "");
    }
  }
  return items.sort((a, b) => b.createTime - a.createTime || a.id.localeCompare(b.id));
}

// 截至 today 的连续有笔记的天数：今天还没有笔记时从昨天算起
function noteStreak(dates, today) {
  let day = dates.has(today) ? today : addDays(today, -1);
  let streak = 0;
  while (dates.has(day)) {
    streak += 1;
    day = addDays(day, -1);
  }
  return streak;
}

/**
 * 时间线的一页与（第一页时）汇总。
 * items：flattenNotes 的结果；today：面板时区的今天；before：只要这一天之前的笔记（翻页），为空时从最新的开始
 */
function buildJournal(items, { today, before = "", pageEntries = PAGE_ENTRIES } = {}) {
  const pool = before ? items.filter((item) => item.date < before) : items;
  const days = [];
  let count = 0;
  for (const item of pool) {
    const last = days[days.length - 1];
    if (!last || last.date !== item.date) {
      if (count >= pageEntries) {
        break;
      }
      days.push({ date: item.date, weekday: weekdayIndex(item.date), daysAgo: daysBetween(item.date, today), books: 0, items: [] });
    }
    days[days.length - 1].items.push(item);
    count += 1;
  }
  for (const day of days) {
    day.books = new Set(day.items.map((item) => item.bookId)).size;
  }
  const lastDay = days[days.length - 1];
  const next = lastDay && pool.some((item) => item.date < lastDay.date) ? lastDay.date : "";
  const result = { today, days, next, total: items.length };
  if (before) {
    return result;
  }

  // 笔记日历：最近 12 周，每列一周（周一到周日），今天之后的格子为空
  const perDay = new Map();
  for (const item of items) {
    perDay.set(item.date, (perDay.get(item.date) || 0) + 1);
  }
  const start = addDays(today, -weekdayIndex(today) - (HEAT_WEEKS - 1) * 7);
  const heat = [];
  for (let offset = 0; offset < HEAT_WEEKS * 7; offset += 1) {
    const date = addDays(start, offset);
    const notes = date > today ? null : perDay.get(date) || 0;
    heat.push({ date, notes, level: notes === null ? -1 : heatLevel(notes) });
  }

  const month = today.slice(0, 7);
  const monthItems = items.filter((item) => item.date.startsWith(month));
  const stats = {
    monthNotes: monthItems.length,
    monthBooks: new Set(monthItems.map((item) => item.bookId)).size,
    streak: noteStreak(new Set(perDay.keys()), today),
  };

  // 往年今天：往年同月同日的笔记（2 月 29 日只在闰年有），最近的年份在前
  const monthDay = today.slice(5);
  const onThisDay = items
    .filter((item) => item.date.slice(5) === monthDay && item.date < today)
    .slice(0, ON_THIS_DAY_LIMIT)
    .map((item) => ({ ...item, yearsAgo: Number(today.slice(0, 4)) - Number(item.date.slice(0, 4)) }));

  return { ...result, heat, stats, onThisDay };
}

module.exports = { HEAT_WEEKS, PAGE_ENTRIES, buildJournal, flattenNotes, heatLevel, noteStreak };
