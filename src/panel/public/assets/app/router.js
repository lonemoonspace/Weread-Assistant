import { reactive } from "../vendor/vue.esm-browser.prod.js";

// 基于 hash 的路由：页面地址不变，部署在子路径下时相对路径始终正确
export const ACCOUNT_TABS = ["live", "history", "calendar", "notes", "config", "schedules"];
export const ACCOUNT_TAB_LABELS = { live: "实时", history: "历史", calendar: "打卡日历", notes: "笔记", schedules: "调度", config: "配置" };

export const route = reactive({ name: "overview", params: {} });

const ROUTES = [
  [/^\/?$/, () => ({ name: "overview", params: {} })],
  [/^\/accounts\/new$/, () => ({ name: "new-account", params: {} })],
  // 笔记中的一本书：#/accounts/<id>/notes/<bookId>
  [/^\/accounts\/([a-z0-9-]+)\/notes\/([\w-]{1,64})$/, (m) => ({ name: "account", params: { id: m[1], tab: "notes", date: "", book: m[2] } })],
  [
    /^\/accounts\/([a-z0-9-]+)(?:\/([a-z]+))?(?:\/(\d{4}-\d{2}-\d{2}))?$/,
    (m) => ({ name: "account", params: { id: m[1], tab: ACCOUNT_TABS.includes(m[2]) ? m[2] : "live", date: m[2] === "history" ? m[3] || "" : "", book: "" } }),
  ],
  [/^\/stats(?:\/([a-z0-9-]+))?$/, (m) => ({ name: "stats", params: { account: m[1] || "" } })],
  [/^\/settings$/, () => ({ name: "settings", params: {} })],
];

// 手工输入的地址可能含有不完整的百分号编码（例如 #%），解码失败时按原样匹配，显示“页面不存在”
function decodeHash() {
  const raw = location.hash.replace(/^#/, "");
  try {
    return decodeURIComponent(raw) || "/";
  } catch (_) {
    return raw;
  }
}

function parse() {
  const hash = decodeHash();
  for (const [pattern, build] of ROUTES) {
    const m = hash.match(pattern);
    if (m) {
      Object.assign(route, build(m));
      return;
    }
  }
  Object.assign(route, { name: "not-found", params: {} });
}

// 离开当前页面前的确认：guard 返回提示文字时询问是否离开，取消则留在原地址
let leaveGuard = null;
let currentHash = location.hash;

export function setLeaveGuard(guard) {
  leaveGuard = guard;
  return () => {
    if (leaveGuard === guard) {
      leaveGuard = null;
    }
  };
}

window.addEventListener("hashchange", () => {
  const message = leaveGuard && leaveGuard();
  if (message && !window.confirm(message)) {
    // replaceState 不触发 hashchange
    history.replaceState(null, "", currentHash || "#/");
    return;
  }
  currentHash = location.hash;
  parse();
});
// 关闭或刷新页面时由浏览器询问（浏览器不显示自定义文字）
window.addEventListener("beforeunload", (event) => {
  if (leaveGuard && leaveGuard()) {
    event.preventDefault();
    event.returnValue = "";
  }
});
parse();

export function go(path) {
  location.hash = path;
}
