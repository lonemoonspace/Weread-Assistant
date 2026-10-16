import { reactive } from "../vendor/vue.esm-browser.prod.js";

// 基于 hash 的路由：页面地址不变，部署在子路径下时相对路径始终正确
export const ACCOUNT_TABS = ["live", "history", "calendar", "config", "schedules"];

export const route = reactive({ name: "overview", params: {} });

const ROUTES = [
  [/^\/?$/, () => ({ name: "overview", params: {} })],
  [/^\/accounts\/new$/, () => ({ name: "new-account", params: {} })],
  [
    /^\/accounts\/([a-z0-9-]+)(?:\/([a-z]+))?$/,
    (m) => ({ name: "account", params: { id: m[1], tab: ACCOUNT_TABS.includes(m[2]) ? m[2] : "live" } }),
  ],
  [/^\/settings$/, () => ({ name: "settings", params: {} })],
];

function parse() {
  const hash = decodeURIComponent(location.hash.replace(/^#/, "")) || "/";
  for (const [pattern, build] of ROUTES) {
    const m = hash.match(pattern);
    if (m) {
      Object.assign(route, build(m));
      return;
    }
  }
  Object.assign(route, { name: "not-found", params: {} });
}

window.addEventListener("hashchange", parse);
parse();

export function go(path) {
  location.hash = path;
}
