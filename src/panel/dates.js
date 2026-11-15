// 日期工具：时区内的日期（YYYY-MM-DD）与纯日历运算

const DAY_MS = 24 * 60 * 60 * 1000;
const formatters = new Map();

// 某个时刻在指定时区的日期，YYYY-MM-DD
function dateInZone(date, timezone) {
  let formatter = formatters.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" });
    formatters.set(timezone, formatter);
  }
  const parts = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function dateParts(date) {
  return date.split("-").map(Number);
}

// 纯日历运算，与时区无关
function addDays(date, days) {
  const [y, m, d] = dateParts(date);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

function daysBetween(from, to) {
  const [y1, m1, d1] = dateParts(from);
  const [y2, m2, d2] = dateParts(to);
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / DAY_MS);
}

// 星期几，周一为 0、周日为 6
function weekdayIndex(date) {
  const [y, m, d] = dateParts(date);
  return (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
}

module.exports = {
  DAY_MS,
  addDays,
  dateInZone,
  dateParts,
  daysBetween,
  weekdayIndex,
};
