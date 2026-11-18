import { computed, createApp, watch, watchEffect } from "../vendor/vue.esm-browser.prod.js";
import { AppHeader } from "./components/app-header.js";
import { NoticeBar } from "./components/common.js";
import { SettingsLayout } from "./components/settings-layout.js";
import { AccountPage } from "./pages/account.js";
import { LibraryPage } from "./pages/library.js";
import { NewAccountPage } from "./pages/new-account.js";
import { OverviewPage } from "./pages/overview.js";
import { SettingsPage } from "./pages/settings.js";
import { StatsPage } from "./pages/stats.js";
import { ACCOUNT_TAB_LABELS, SETTINGS_LABELS, replace, route } from "./router.js";
import { loadAll, selectAccount, state } from "./store.js";

const SETTINGS_ROUTES = ["settings", "account", "new-account"];

const App = {
  components: { AccountPage, AppHeader, LibraryPage, NewAccountPage, NoticeBar, OverviewPage, SettingsLayout, SettingsPage, StatsPage },
  setup() {
    // 需要扫码登录的运行：自动阅读移到了设置中，在每个页面顶部提示
    const waiting = computed(() => Object.values(state.runs).filter((run) => run.status === "waiting-login"));
    const nameOf = (id) => {
      const account = state.accounts.find((item) => item.id === id);
      return account ? account.name : id;
    };
    // 自动阅读页与该账号的页面中已经显示二维码，不再提示
    const bannerRuns = computed(() =>
      waiting.value.filter(
        (run) => !(route.name === "settings" && route.params.section === "reading") && !(route.name === "account" && route.params.id === run.accountId)
      )
    );
    const inSettings = computed(() => SETTINGS_ROUTES.includes(route.name));
    // 设置左侧高亮的分组与账号
    const settingsSection = computed(() => (route.name === "settings" ? route.params.section : "reading"));
    const settingsAccount = computed(() => (route.name === "account" ? route.params.id : ""));
    return { state, route, bannerRuns, nameOf, inSettings, settingsSection, settingsAccount };
  },
  template: `
    <app-header />
    <div class="container app-alerts">
      <p v-if="state.ready && state.connection !== 'connected'" class="connection" role="status">实时连接已断开，正在重新连接…</p>
      <p v-for="run in bannerRuns" :key="'qr-' + run.id" class="scan-banner" role="status">
        <span><strong>{{ nameOf(run.accountId) }}</strong> 需要扫码登录微信读书</span>
        <a :href="'#/accounts/' + run.accountId + '/live'">去扫码</a>
      </p>
    </div>
    <main class="container app-main">
      <article v-if="state.loadError">
        <p class="error-text">加载失败：{{ state.loadError }}</p>
        <a href="./" role="button">重新加载</a>
      </article>
      <p v-else-if="!state.ready" aria-busy="true">加载中…</p>
      <template v-else>
        <library-page v-if="route.name === 'library'" :book="route.params.book" />
        <stats-page v-else-if="route.name === 'stats'" :account="route.params.account" />
        <settings-layout v-else-if="inSettings" :section="settingsSection" :account-id="settingsAccount">
          <overview-page v-if="route.name === 'settings' && route.params.section === 'reading'" />
          <settings-page v-else-if="route.name === 'settings'" :key="route.params.section" :section="route.params.section" />
          <new-account-page v-else-if="route.name === 'new-account'" />
          <account-page v-else :id="route.params.id" :tab="route.params.tab" :date="route.params.date" />
        </settings-layout>
        <article v-else-if="route.name !== 'legacy-notes'"><p>页面不存在。</p><a href="#/">返回书库</a></article>
      </template>
    </main>
    <footer class="container muted app-footer">
      WeReadAssistant {{ state.session ? state.session.version : "" }} · 非微信读书官方工具
    </footer>
    <notice-bar />`,
};

// 旧地址 #/accounts/<id>/notes[/<bookId>]（每周报告通知中的链接等）：切换到该账号，跳到书库
watch(
  () => [route.name, state.ready],
  ([name, ready]) => {
    if (name === "legacy-notes" && ready) {
      if (state.accounts.some((item) => item.id === route.params.id)) {
        selectAccount(route.params.id);
      }
      replace(route.params.book ? `#/library/${route.params.book}` : "#/library");
    }
  },
  { immediate: true }
);

// 页面标题随路由变化，多个标签页、浏览器历史中便于区分
const PAGE_TITLES = { library: "书库", "new-account": "新建账号", stats: "报告", "not-found": "页面不存在" };
watchEffect(() => {
  let title = PAGE_TITLES[route.name] || "";
  if (route.name === "settings") {
    title = `${SETTINGS_LABELS[route.params.section]} · 设置`;
  }
  if (route.name === "account") {
    const account = state.accounts.find((item) => item.id === route.params.id);
    title = `${account ? account.name : route.params.id} · ${ACCOUNT_TAB_LABELS[route.params.tab] || ""}`;
  }
  document.title = title ? `${title} · WeReadAssistant` : "WeReadAssistant";
});

createApp(App).mount("#app");
loadAll();
