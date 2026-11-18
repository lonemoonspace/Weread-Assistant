/**
 * 每周阅读报告：用官方 API 的 /readdata/detail（mode=weekly）读取某一周与前一周的阅读统计，渲染为通知正文。
 * 口径按官方 skills/readdata.md：所有时长字段单位为秒；totalReadTime 为周期总时长，readDays 为当天读满 1 分钟的天数，
 * dayAverageReadTime 按自然日平均。上周新增的划线与想法来自面板已同步的笔记（见 src/panel/notes.js）。
 */

const WEEK_SECONDS = 7 * 24 * 3600;
// 官方周期按北京时间归一化：回包没有 baseTime 时，用北京时间的周一零点
const CHINA_OFFSET_SECONDS = 8 * 3600;
const TOP_BOOKS = 3;

const int = (value) => (Number.isFinite(Number(value)) ? Math.trunc(Number(value)) : 0);

// 秒 → “x 小时 y 分钟”（不足 1 分钟为 0 分钟）
function formatDuration(seconds) {
  const minutes = Math.floor(Math.max(0, seconds) / 60);
  const hours = Math.floor(minutes / 60);
  if (hours === 0) {
    return `${minutes} 分钟`;
  }
  return minutes % 60 === 0 ? `${hours} 小时` : `${hours} 小时 ${minutes % 60} 分钟`;
}

function summarize(body) {
  const longest = (Array.isArray(body.readLongest) ? body.readLongest : [])
    .map((item) => {
      const info = item && item.book && typeof item.book === "object" ? item.book : item && item.albumInfo && typeof item.albumInfo === "object" ? item.albumInfo : {};
      return { title: String(info.title || info.name || "").trim(), readTime: int(item && item.readTime) };
    })
    .filter((item) => item.title && item.readTime > 0)
    .slice(0, TOP_BOOKS);
  return {
    baseTime: int(body.baseTime),
    totalReadTime: int(body.totalReadTime),
    readDays: int(body.readDays),
    dayAverageReadTime: int(body.dayAverageReadTime),
    longest,
  };
}

/**
 * 读取 weekStart（YYYY-MM-DD，周一）所在的一周与前一周。官方接口按 baseTime 所在的自然周统计，
 * 这里取该周周四正午（UTC）作为 baseTime，避开时区差异造成的跨周
 */
async function fetchWeeklyReport(api, weekStart) {
  const [y, m, d] = weekStart.split("-").map(Number);
  const middle = Math.floor(Date.UTC(y, m - 1, d + 3, 12) / 1000);
  const current = summarize(await api.call("/readdata/detail", { mode: "weekly", baseTime: middle }));
  const previous = summarize(await api.call("/readdata/detail", { mode: "weekly", baseTime: middle - WEEK_SECONDS }));
  const startSeconds = current.baseTime || Math.floor(Date.UTC(y, m - 1, d) / 1000) - CHINA_OFFSET_SECONDS;
  return { weekStart, startSeconds, current, previous };
}

// 某一周新增的划线与想法：books 为 [{ title, highlights, reviews }]（已同步的笔记），按 createTime（秒）筛选
function countNewNotes(books, startSeconds) {
  const inWeek = (item) => item.createTime >= startSeconds && item.createTime < startSeconds + WEEK_SECONDS;
  let highlights = 0;
  let reviews = 0;
  let bookCount = 0;
  for (const book of books) {
    const h = (book.highlights || []).filter(inWeek).length;
    const r = (book.reviews || []).filter(inWeek).length;
    highlights += h;
    reviews += r;
    bookCount += h + r > 0 ? 1 : 0;
  }
  return { highlights, reviews, books: bookCount };
}

/**
 * 通知正文。report 为 fetchWeeklyReport 的结果；weekLabel 如 “11-10 至 11-16”；
 * newNotes 为 countNewNotes 的结果，没有同步过笔记时为 null
 */
function renderWeeklyReport(report, { weekLabel, newNotes = null }) {
  const { current, previous } = report;
  const lines = [];
  if (current.totalReadTime < 60) {
    lines.push(`${weekLabel} 在微信读书中没有阅读记录。`);
  } else {
    lines.push(`${weekLabel} 阅读 ${formatDuration(current.totalReadTime)}，读了 ${current.readDays} 天，日均 ${formatDuration(current.dayAverageReadTime)}`);
    const diff = current.totalReadTime - previous.totalReadTime;
    if (previous.totalReadTime < 60) {
      lines.push("前一周没有阅读记录");
    } else if (Math.abs(diff) < 60) {
      lines.push("与前一周基本持平");
    } else {
      const percent = Math.round((Math.abs(diff) / previous.totalReadTime) * 100);
      lines.push(`比前一周${diff > 0 ? "多" : "少"} ${formatDuration(Math.abs(diff))}（${diff > 0 ? "+" : "-"}${percent}%）`);
    }
    if (current.longest.length > 0) {
      lines.push(`读得最多：${current.longest.map((item) => `《${item.title}》${formatDuration(item.readTime)}`).join("；")}`);
    }
  }
  if (newNotes) {
    lines.push(
      newNotes.highlights + newNotes.reviews > 0
        ? `新增划线 ${newNotes.highlights} 条、想法 ${newNotes.reviews} 条（${newNotes.books} 本书）`
        : "没有新增划线与想法"
    );
  }
  lines.push("数据来自微信读书 API，包含在手机上的阅读。");
  return lines.join("\n");
}

module.exports = {
  countNewNotes,
  fetchWeeklyReport,
  formatDuration,
  renderWeeklyReport,
};
