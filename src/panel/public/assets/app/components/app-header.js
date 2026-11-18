import { computed, onBeforeUnmount, onMounted, ref } from "../../vendor/vue.esm-browser.prod.js";
import { ACTIVE_STATUSES } from "../format.js";
import { route } from "../router.js";
import { currentAccount, logout, selectAccount, setTheme, state } from "../store.js";

// 顶部导航（手机宽度下固定在屏幕底部）。图标是线条风格的内联 SVG
const NAV = [
  { name: "journal", href: "#/", label: "日记", icon: ["M12 20h9", "M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"] },
  { name: "library", href: "#/library", label: "书库", icon: ["M4 19.5A2.5 2.5 0 0 1 6.5 17H20V2H6.5A2.5 2.5 0 0 0 4 4.5z", "M4 19.5A2.5 2.5 0 0 0 6.5 22H20v-5"] },
  { name: "stats", href: "#/stats", label: "报告", icon: ["M3 3v18h18", "m7 15 4-4 3 3 5-6"] },
  {
    name: "settings",
    href: "#/settings",
    label: "设置",
    icon: ["M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z", "M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1 7 17M17 7l2.1-2.1"],
  },
];

// 设置中的页面（账号的运行、配置等）也属于“设置”
const SECTION_OF = { journal: "journal", library: "library", stats: "stats", settings: "settings", account: "settings", "new-account": "settings" };

const THEMES = [
  ["system", "跟随系统"],
  ["light", "浅色"],
  ["dark", "深色"],
];

export const AppHeader = {
  setup() {
    const menu = ref(null);
    const section = computed(() => SECTION_OF[route.name] || "");
    const account = currentAccount;
    const run = computed(() => (account.value ? state.runs[account.value.id] : null));
    // 打卡只在顶栏显示一个小圆点：运行中、今天已打卡或未打卡；点击进入该账号的实时页面
    const checkin = computed(() => {
      if (!account.value) {
        return null;
      }
      if (run.value && ACTIVE_STATUSES.includes(run.value.status)) {
        return { kind: "running", label: run.value.status === "waiting-login" ? "等待扫码" : "阅读中" };
      }
      if (account.value.today && account.value.today.checkedIn) {
        return { kind: "done", label: "已打卡" };
      }
      return { kind: "todo", label: "未打卡" };
    });
    const initial = computed(() => (account.value ? (account.value.name || account.value.id).slice(0, 1) : "?"));
    const closeMenu = () => {
      if (menu.value) {
        menu.value.open = false;
      }
    };
    // 点菜单以外的地方或按 Esc 时收起菜单
    const onClick = (event) => {
      if (menu.value && menu.value.open && !menu.value.contains(event.target)) {
        closeMenu();
      }
    };
    const onKey = (event) => {
      if (event.key === "Escape" && menu.value && menu.value.open) {
        closeMenu();
        menu.value.querySelector("summary").focus();
      }
    };
    onMounted(() => {
      document.addEventListener("click", onClick);
      document.addEventListener("keydown", onKey);
    });
    onBeforeUnmount(() => {
      document.removeEventListener("click", onClick);
      document.removeEventListener("keydown", onKey);
    });
    return {
      NAV,
      THEMES,
      state,
      section,
      account,
      checkin,
      initial,
      menu,
      choose(id) {
        selectAccount(id);
        closeMenu();
      },
      theme(value) {
        setTheme(value);
        closeMenu();
      },
      closeMenu,
      logout,
    };
  },
  template: `
    <header class="app-header">
      <div class="container app-bar">
        <a href="#/" class="brand">
          <svg class="brand-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M2 4h6a4 4 0 0 1 4 4v12a3 3 0 0 0-3-3H2z"></path>
            <path d="M22 4h-6a4 4 0 0 0-4 4v12a3 3 0 0 1 3-3h7z"></path>
          </svg>
          <span class="brand-text">WeReadAssistant</span>
        </a>
        <nav class="main-nav" aria-label="主导航">
          <a v-for="item in NAV" :key="item.name" :href="item.href" :aria-current="section === item.name ? 'page' : null">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path v-for="d in item.icon" :key="d" :d="d"></path>
            </svg>
            <span>{{ item.label }}</span>
          </a>
        </nav>
        <a v-if="checkin" class="checkin-dot" :class="'is-' + checkin.kind" :href="'#/accounts/' + account.id + '/live'" :title="'自动阅读：' + checkin.label">{{ checkin.label }}</a>
        <details ref="menu" class="account-menu">
          <summary :aria-label="account ? '账号：' + account.name : '菜单'"><span class="avatar">{{ initial }}</span></summary>
          <div class="menu-panel">
            <template v-if="state.accounts.length">
              <p class="menu-label">账号</p>
              <button
                v-for="item in state.accounts"
                :key="item.id"
                type="button"
                class="menu-item"
                :aria-pressed="account && item.id === account.id ? 'true' : 'false'"
                @click="choose(item.id)"
              >{{ item.name }}<small class="muted">{{ item.id }}</small></button>
              <a v-if="account" class="menu-item" :href="'#/accounts/' + account.id + '/config'" @click="closeMenu">账号配置</a>
            </template>
            <a class="menu-item" href="#/accounts/new" @click="closeMenu">新建账号</a>
            <p class="menu-label">外观</p>
            <div class="menu-themes" role="group" aria-label="外观">
              <button v-for="[value, label] in THEMES" :key="value" type="button" :aria-pressed="state.theme === value ? 'true' : 'false'" @click="theme(value)">{{ label }}</button>
            </div>
            <button type="button" class="menu-item" @click="logout">退出登录</button>
          </div>
        </details>
      </div>
    </header>`,
};
