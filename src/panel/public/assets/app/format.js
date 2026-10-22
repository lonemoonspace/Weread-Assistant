// 文案与时间格式。时间按面板设置中的时区显示，与调度、统计一致

export const STATUS_LABELS = {
  queued: "排队中",
  starting: "启动中",
  "waiting-login": "等待扫码",
  reading: "阅读中",
  success: "成功",
  failed: "失败",
  stopped: "已停止",
  interrupted: "中断",
};

export const ACTIVE_STATUSES = ["queued", "starting", "waiting-login", "reading"];
export const TRIGGER_LABELS = { manual: "手动", schedule: "定时" };
export const MODE_LABELS = { read: "阅读", login: "仅登录" };
export const SCHEDULE_TYPE_LABELS = { daily: "每天固定时间", interval: "每 N 小时", cron: "cron 表达式" };

const formatters = new Map();

function parts(iso, timezone) {
  const key = timezone || "";
  let formatter = formatters.get(key);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone || undefined,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      weekday: "short",
      hourCycle: "h23",
    });
    formatters.set(key, formatter);
  }
  return Object.fromEntries(formatter.formatToParts(new Date(iso)).map((p) => [p.type, p.value]));
}

const WEEKDAYS = { Mon: "周一", Tue: "周二", Wed: "周三", Thu: "周四", Fri: "周五", Sat: "周六", Sun: "周日" };

// 2026-10-16 06:00
export function formatDateTime(iso, timezone) {
  if (!iso) {
    return "-";
  }
  const p = parts(iso, timezone);
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

// 10-16 周五 06:00
export function formatShort(iso, timezone) {
  if (!iso) {
    return "-";
  }
  const p = parts(iso, timezone);
  return `${p.month}-${p.day} ${WEEKDAYS[p.weekday] || ""} ${p.hour}:${p.minute}`;
}

export function formatClock(iso, timezone) {
  if (!iso) {
    return "-";
  }
  const p = parts(iso, timezone);
  return `${p.hour}:${p.minute}:${p.second}`;
}

// 68 → 1 小时 8 分钟
export function formatMinutes(minutes) {
  const total = Math.max(0, Math.round(minutes || 0));
  if (total < 60) {
    return `${total} 分钟`;
  }
  const hours = Math.floor(total / 60);
  const rest = total % 60;
  return rest ? `${hours} 小时 ${rest} 分钟` : `${hours} 小时`;
}

// 向下取整到 0.1 小时：1799 分钟显示为 29.9 小时，不会在未达标时显示成要求的 30 小时
export function formatHours(minutes) {
  return `${Math.floor(Math.max(0, minutes || 0) / 6) / 10} 小时`;
}

export function durationBetween(start, end) {
  if (!start || !end) {
    return "";
  }
  const minutes = (Date.parse(end) - Date.parse(start)) / 60000;
  return minutes < 1 ? "不到 1 分钟" : formatMinutes(minutes);
}
