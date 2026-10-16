import { computed } from "../../vendor/vue.esm-browser.prod.js";
import { StatusBadge } from "../components/common.js";
import { state } from "../store.js";
import { CalendarTab } from "./account-calendar.js";
import { ConfigTab } from "./account-config.js";
import { HistoryTab } from "./account-history.js";
import { LiveTab } from "./account-live.js";
import { SchedulesTab } from "./account-schedules.js";

const TABS = [
  ["live", "实时"],
  ["history", "历史"],
  ["calendar", "打卡日历"],
  ["schedules", "调度"],
  ["config", "配置"],
];

export const AccountPage = {
  components: { CalendarTab, ConfigTab, HistoryTab, LiveTab, SchedulesTab, StatusBadge },
  props: { id: String, tab: String },
  setup(props) {
    const account = computed(() => state.accounts.find((item) => item.id === props.id));
    const run = computed(() => state.runs[props.id]);
    return { account, run, TABS };
  },
  template: `
    <template v-if="account">
      <hgroup class="account-head">
        <h2>
          {{ account.name }}
          <status-badge v-if="run" :status="run.status" />
          <span v-if="!account.enabled" class="badge status-stopped">已停用</span>
        </h2>
        <p class="muted">账号 ID：{{ account.id }} · 今天 {{ account.today.minutes }} 分钟{{ account.today.checkedIn ? "，已打卡" : "，未打卡" }}</p>
      </hgroup>
      <nav class="tabs" aria-label="账号页面">
        <a v-for="[name, label] in TABS" :key="name" :href="'#/accounts/' + account.id + '/' + name" :aria-current="tab === name ? 'page' : null">{{ label }}</a>
      </nav>
      <live-tab v-if="tab === 'live'" :account="account" />
      <history-tab v-else-if="tab === 'history'" :key="'h-' + account.id" :account="account" />
      <calendar-tab v-else-if="tab === 'calendar'" :key="'c-' + account.id" :account="account" />
      <schedules-tab v-else-if="tab === 'schedules'" :key="'s-' + account.id" :account="account" />
      <config-tab v-else-if="tab === 'config'" :key="'o-' + account.id" :account="account" />
    </template>
    <article v-else>
      <p>账号不存在：{{ id }}</p>
      <a href="#/">返回总览</a>
    </article>`,
};
