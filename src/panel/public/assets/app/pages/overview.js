import { computed } from "../../vendor/vue.esm-browser.prod.js";
import { QrLogin, RunButtons, StatusBadge } from "../components/common.js";
import { SeleniumStatus } from "../components/selenium-status.js";
import { MODE_LABELS, STATUS_LABELS, TRIGGER_LABELS, formatShort } from "../format.js";
import { state, timezone } from "../store.js";

const AccountCard = {
  components: { RunButtons, StatusBadge },
  props: { account: Object },
  setup(props) {
    const run = computed(() => state.runs[props.account.id]);
    const avatarLetter = computed(() => (props.account.name || props.account.id || "客").slice(0, 1));
    const avatarClass = computed(() => {
      if (!props.account.enabled) {
        return "disabled";
      }
      if (run.value && run.value.status === "reading") {
        return "blue";
      }
      if (props.account.today && props.account.today.checkedIn) {
        return "green";
      }
      return "";
    });
    return {
      run,
      avatarLetter,
      avatarClass,
      tz: computed(timezone),
      formatShort,
      STATUS_LABELS,
    };
  },
  template: `
    <article class="account-card" :class="{ disabled: !account.enabled }">
      <header>
        <span class="account-avatar" :class="avatarClass">{{ avatarLetter }}</span>
        <div class="account-title-wrap">
          <a :href="'#/accounts/' + account.id + '/live'" class="account-name">{{ account.name }}</a>
          <small class="muted">{{ account.id }}</small>
        </div>
        <span v-if="!account.enabled" class="badge status-stopped">已停用</span>
      </header>
      <p class="card-status">
        <template v-if="run">
          <status-badge :status="run.status" />
          <span v-if="run.status === 'reading'">
            <template v-if="run.book">《{{ run.book }}》</template>第 {{ run.minutes }}/{{ run.plannedMinutes }} 分钟
          </span>
        </template>
        <template v-else-if="account.lastRun">
          <span class="muted">上次运行</span>
          <status-badge :status="account.lastRun.status" />
          <span class="muted">{{ formatShort(account.lastRun.endedAt || account.lastRun.queuedAt, tz) }}</span>
        </template>
        <span v-else class="muted">还没有运行过</span>
      </p>
      <div v-if="run && run.status === 'reading' && run.plannedMinutes" class="reading-progress">
        <progress :value="run.minutes" :max="run.plannedMinutes"></progress>
      </div>
      <p>
        今天 <strong>{{ account.today.minutes }}</strong> 分钟
        <span v-if="account.today.checkedIn" class="badge status-success">已打卡</span>
        <span v-else class="badge status-failed">未打卡</span>
      </p>
      <p class="muted">下次运行：{{ account.nextRunAt ? formatShort(account.nextRunAt, tz) : "未设置调度" }}</p>
      <footer>
        <run-buttons :account="account" />
      </footer>
    </article>`,
};

export const OverviewPage = {
  components: { AccountCard, QrLogin, SeleniumStatus, StatusBadge },
  setup() {
    const waiting = computed(() =>
      Object.values(state.runs).filter((run) => run.status === "waiting-login")
    );
    const queue = computed(() =>
      Object.values(state.runs).sort((a, b) => a.queuedAt.localeCompare(b.queuedAt))
    );
    // 需要扫码与正在运行的账号排在前面
    const accounts = computed(() => {
      const rank = (account) => {
        const run = state.runs[account.id];
        if (run && run.status === "waiting-login") {
          return 0;
        }
        return run ? 1 : account.enabled ? 2 : 3;
      };
      return [...state.accounts].sort((a, b) => rank(a) - rank(b) || a.id.localeCompare(b.id));
    });
    const nameOf = (id) => {
      const account = state.accounts.find((item) => item.id === id);
      return account ? account.name : id;
    };

    // 概览统计指标
    const totalAccounts = computed(() => state.accounts.length);
    const activeAccounts = computed(() => state.accounts.filter((a) => a.enabled).length);
    // 今日打卡以启用的账号为准
    const checkedInToday = computed(() =>
      state.accounts.filter((a) => a.enabled && a.today && a.today.checkedIn).length
    );
    const totalMinutesToday = computed(() =>
      state.accounts.reduce((sum, a) => sum + (a.today ? a.today.minutes : 0), 0)
    );

    // 任务运行统计细分
    const runsList = computed(() => Object.values(state.runs));
    const totalRuns = computed(() => runsList.value.length);
    const activeRuns = computed(() =>
      runsList.value.filter((run) => run.status !== "queued" && run.status !== "waiting-login")
    );
    const waitingRuns = computed(() =>
      runsList.value.filter((run) => run.status === "waiting-login")
    );
    const queuedRuns = computed(() =>
      runsList.value.filter((run) => run.status === "queued")
    );
    const runStatusTip = computed(() => {
      if (!totalRuns.value) {
        return "全部任务空闲";
      }
      const parts = [];
      if (activeRuns.value.length) {
        parts.push(`${activeRuns.value.length} 个运行中`);
      }
      if (waitingRuns.value.length) {
        parts.push(`${waitingRuns.value.length} 个需扫码`);
      }
      if (queuedRuns.value.length) {
        parts.push(`${queuedRuns.value.length} 个排队`);
      }
      return parts.join(" · ");
    });

    const checkInRate = computed(() =>
      activeAccounts.value ? Math.round((checkedInToday.value / activeAccounts.value) * 100) : 0
    );
    const isAllCheckedIn = computed(() =>
      activeAccounts.value > 0 && checkedInToday.value >= activeAccounts.value
    );

    return {
      waiting,
      queue,
      accounts,
      nameOf,
      totalAccounts,
      activeAccounts,
      checkedInToday,
      totalMinutesToday,
      totalRuns,
      activeRuns,
      runStatusTip,
      checkInRate,
      isAllCheckedIn,
      MODE_LABELS,
      TRIGGER_LABELS,
      state,
    };
  },
  template: `
    <section v-if="totalAccounts" class="metrics-grid">
      <div class="metric-card">
        <div class="metric-head">
          <span>托管账号</span>
        </div>
        <div class="metric-number">
          {{ totalAccounts }}<span class="metric-unit">个</span>
        </div>
        <div class="metric-tip muted">
          {{ activeAccounts }} 个启用 · {{ totalAccounts - activeAccounts }} 个停用
        </div>
      </div>
      <div class="metric-card">
        <div class="metric-head">
          <span>今日打卡</span>
        </div>
        <div class="metric-number">
          {{ checkedInToday }}<template v-if="activeAccounts"> / {{ activeAccounts }}</template>
        </div>
        <div class="metric-tip" :class="isAllCheckedIn ? 'ok-text' : 'muted'">
          <template v-if="activeAccounts">达成率 {{ checkInRate }}%</template>
          <template v-else>无启用账号</template>
        </div>
      </div>
      <div class="metric-card">
        <div class="metric-head">
          <span>今日总阅读</span>
        </div>
        <div class="metric-number">
          {{ totalMinutesToday }}<span class="metric-unit">分钟</span>
        </div>
        <div class="metric-tip muted">
          约 {{ (totalMinutesToday / 60).toFixed(1) }} 小时
        </div>
      </div>
      <div class="metric-card">
        <div class="metric-head">
          <span>任务运行</span>
        </div>
        <div class="metric-number">
          {{ totalRuns }}<span class="metric-unit">个任务</span>
        </div>
        <div class="metric-tip" :class="activeRuns.length ? 'ok-text' : 'muted'">
          {{ runStatusTip }}
        </div>
      </div>
    </section>

    <section>
      <selenium-status />
    </section>

    <section v-for="run in waiting" :key="'qr-' + run.id" class="scan-card">
      <article>
        <header><strong>{{ nameOf(run.accountId) }}</strong> 需要扫码登录</header>
        <qr-login :url="run.loginUrl" :account-id="run.accountId" :qr-at="run.loginQrAt" />
      </article>
    </section>

    <section v-if="queue.length">
      <h2>运行队列</h2>
      <div class="table-scroll">
        <table class="striped">
          <thead><tr><th>账号</th><th>状态</th><th>方式</th><th>进度</th></tr></thead>
          <tbody>
            <tr v-for="run in queue" :key="run.id">
              <td><a :href="'#/accounts/' + run.accountId + '/live'">{{ nameOf(run.accountId) }}</a></td>
              <td><status-badge :status="run.status" /></td>
              <td>{{ TRIGGER_LABELS[run.trigger] }} · {{ MODE_LABELS[run.mode] }}</td>
              <td>{{ run.mode === "read" && run.status === "reading" ? run.minutes + " / " + run.plannedMinutes + " 分钟" : "-" }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <section>
      <h2>账号</h2>
      <div v-if="accounts.length" class="cards">
        <account-card v-for="account in accounts" :key="account.id" :account="account" />
      </div>
      <article v-else>
        <p>还没有账号。</p>
        <a href="#/accounts/new" role="button">新建账号</a>
      </article>
    </section>`,
};
