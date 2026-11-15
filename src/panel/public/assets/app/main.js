import { createApp, watchEffect } from "../vendor/vue.esm-browser.prod.js";
import { NoticeBar } from "./components/common.js";
import { AccountPage } from "./pages/account.js";
import { NewAccountPage } from "./pages/new-account.js";
import { OverviewPage } from "./pages/overview.js";
import { SettingsPage } from "./pages/settings.js";
import { StatsPage } from "./pages/stats.js";
import { ACCOUNT_TAB_LABELS, route } from "./router.js";
import { loadAll, logout, state } from "./store.js";

const App = {
  components: { AccountPage, NewAccountPage, NoticeBar, OverviewPage, SettingsPage, StatsPage },
  setup() {
    return { state, route, logout };
  },
  template: `
    <header class="container app-header">
      <nav>
        <ul>
          <li>
            <a href="#/" class="brand">
              <span class="brand-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"></path>
                  <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"></path>
                </svg>
              </span>
              <span class="brand-text">WeReadAssistant</span>
            </a>
          </li>
        </ul>
        <ul>
          <li><a href="#/" :aria-current="route.name === 'overview' ? 'page' : null">总览</a></li>
          <li><a href="#/stats" :aria-current="route.name === 'stats' ? 'page' : null">统计</a></li>
          <li><a href="#/accounts/new" :aria-current="route.name === 'new-account' ? 'page' : null">新建账号</a></li>
          <li><a href="#/settings" :aria-current="route.name === 'settings' ? 'page' : null">设置</a></li>
          <li><a href="#" @click.prevent="logout">退出</a></li>
        </ul>
      </nav>
      <p v-if="state.ready && state.connection !== 'connected'" class="connection" role="status">实时连接已断开，正在重新连接…</p>
    </header>
    <main class="container">
      <article v-if="state.loadError">
        <p class="error-text">加载失败：{{ state.loadError }}</p>
        <a href="./" role="button">重新加载</a>
      </article>
      <p v-else-if="!state.ready" aria-busy="true">加载中…</p>
      <template v-else>
        <overview-page v-if="route.name === 'overview'" />
        <new-account-page v-else-if="route.name === 'new-account'" />
        <account-page v-else-if="route.name === 'account'" :id="route.params.id" :tab="route.params.tab" :date="route.params.date" />
        <settings-page v-else-if="route.name === 'settings'" />
        <stats-page v-else-if="route.name === 'stats'" :account="route.params.account" />
        <article v-else><p>页面不存在。</p><a href="#/">返回总览</a></article>
      </template>
    </main>
    <footer class="container muted app-footer">
      WeReadAssistant {{ state.session ? state.session.version : "" }} · 非微信读书官方工具
    </footer>
    <notice-bar />`,
};

// 页面标题随路由变化，多个标签页、浏览器历史中便于区分
const PAGE_TITLES = { overview: "总览", "new-account": "新建账号", stats: "统计", settings: "设置", "not-found": "页面不存在" };
watchEffect(() => {
  let title = PAGE_TITLES[route.name] || "";
  if (route.name === "account") {
    const account = state.accounts.find((item) => item.id === route.params.id);
    title = `${account ? account.name : route.params.id} · ${ACCOUNT_TAB_LABELS[route.params.tab] || ""}`;
  }
  document.title = title ? `${title} · WeReadAssistant` : "WeReadAssistant";
});

createApp(App).mount("#app");
loadAll();
