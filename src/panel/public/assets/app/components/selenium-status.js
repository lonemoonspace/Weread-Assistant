import { computed, onBeforeUnmount, onMounted, ref, watch } from "../../vendor/vue.esm-browser.prod.js";
import { api } from "../api.js";
import { formatClock } from "../format.js";
import { state, timezone } from "../store.js";

// 打开总览期间定期刷新；运行开始或结束后会话数会变化，稍后再刷新一次
const POLL_MS = 30000;
const AFTER_RUN_CHANGE_MS = 3000;

const STATE_LABELS = { ready: "就绪", busy: "会话已满", "not-ready": "未就绪", unreachable: "无法连接" };
// 多个 Selenium 时整体状态取最差的一个
const STATE_RANK = ["ready", "busy", "not-ready", "unreachable"];

// noVNC 链接：只在设置中填写了地址时显示。画面就是正在运行的浏览器
export const VncLink = {
  setup() {
    return { url: computed(() => (state.settings && state.settings.vncUrl) || "") };
  },
  template: `<a v-if="url" class="vnc-link" :href="url" target="_blank" rel="noopener noreferrer">查看浏览器画面（noVNC）</a>`,
};

// 总览顶部的 Selenium 状态：是否就绪、已用/总会话数；连不上时给出明确提示
export const SeleniumStatus = {
  components: { VncLink },
  setup() {
    const data = ref(null);
    const loadError = ref("");
    const loading = ref(false);
    let pollTimer = null;
    let changeTimer = null;

    async function refresh() {
      if (loading.value) {
        return;
      }
      loading.value = true;
      try {
        data.value = await api("selenium/status");
        loadError.value = "";
      } catch (error) {
        loadError.value = error.message;
      } finally {
        loading.value = false;
      }
    }

    const startedRuns = computed(() =>
      Object.values(state.runs)
        .filter((run) => run.status !== "queued")
        .map((run) => run.id)
        .sort()
        .join(",")
    );
    watch(startedRuns, () => {
      clearTimeout(changeTimer);
      changeTimer = setTimeout(refresh, AFTER_RUN_CHANGE_MS);
    });
    onMounted(() => {
      refresh();
      pollTimer = setInterval(() => {
        if (!document.hidden) {
          refresh();
        }
      }, POLL_MS);
    });
    onBeforeUnmount(() => {
      clearInterval(pollTimer);
      clearTimeout(changeTimer);
    });

    const servers = computed(() => {
      if (!data.value) {
        return [];
      }
      const { maxConcurrentRuns } = data.value;
      return data.value.servers.map((server) => {
        const sessions = server.sessions;
        // 能同时在这个 Selenium 上运行的账号数
        const possibleRuns = Math.min(maxConcurrentRuns, server.accounts.length);
        return {
          ...server,
          label: STATE_LABELS[server.state],
          // Selenium 的说明以英文句号结尾，接在中文句子中时去掉
          messageText: server.message.replace(/[.。]\s*$/, ""),
          foreignSessions: sessions ? Math.max(0, sessions.used - server.panelRuns) : 0,
          overCommitted: Boolean(sessions && sessions.total > 0 && possibleRuns > sessions.total),
          accountNames: server.accounts.map((account) => account.name).join("、"),
        };
      });
    });
    const overall = computed(() =>
      servers.value.reduce(
        (worst, server) => (STATE_RANK.indexOf(server.state) > STATE_RANK.indexOf(worst) ? server.state : worst),
        "ready"
      )
    );

    return {
      data,
      loadError,
      loading,
      refresh,
      servers,
      overall,
      STATE_LABELS,
      checkedAt: computed(() => (data.value ? formatClock(data.value.checkedAt, timezone()) : "")),
    };
  },
  template: `
    <article class="selenium-card" :class="data ? 'selenium-' + overall : ''">
      <header class="selenium-head">
        <strong>Selenium</strong>
        <span v-if="data" class="badge" :class="'selenium-state-' + overall">{{ STATE_LABELS[overall] }}</span>
        <span v-else-if="!loadError" class="muted" aria-busy="true">正在检查…</span>
        <span class="selenium-actions">
          <vnc-link />
          <button type="button" class="secondary small" :aria-busy="loading" :disabled="loading" @click="refresh">刷新</button>
        </span>
      </header>
      <p v-if="loadError" class="error-text">无法获取 Selenium 状态：{{ loadError }}</p>
      <div v-for="(server, index) in servers" :key="index" class="selenium-server">
        <p class="selenium-line">
          <code>{{ server.url }}</code>
          <span v-if="servers.length > 1" class="badge" :class="'selenium-state-' + server.state">{{ server.label }}</span>
          <span v-if="server.sessions">已用 <strong>{{ server.sessions.used }}/{{ server.sessions.total }}</strong> 个会话</span>
          <span v-else-if="server.state !== 'unreachable'" class="muted">不提供会话数</span>
          <small v-if="servers.length > 1" class="muted">
            {{ server.isDefault ? "全局默认" : "" }}{{ server.isDefault && server.accountNames ? " · " : "" }}{{ server.accountNames ? "账号：" + server.accountNames : "" }}
          </small>
        </p>
        <div v-if="server.state === 'unreachable'" class="selenium-alert alert-error" role="alert">
          <p><strong>无法连接 Selenium：{{ server.error }}。</strong>阅读和扫码登录都无法开始。</p>
          <p>请确认 Selenium 容器正在运行（使用 docker compose 部署时执行 <code>docker compose up -d selenium</code>），并检查设置中的 Selenium 地址。</p>
        </div>
        <p v-else-if="server.state === 'not-ready'" class="selenium-alert alert-warn">
          Selenium 未就绪：{{ server.messageText || "没有可用的浏览器节点" }}。刚启动时需要几秒钟；一直未就绪时请查看 Selenium 容器的日志。
        </p>
        <p v-if="server.foreignSessions" class="muted">
          其中 {{ server.foreignSessions }} 个会话不属于面板正在进行的运行（可能是其他程序使用，或没有正常关闭的会话，Selenium 会在会话空闲超时后回收）。
        </p>
        <p v-if="server.overCommitted" class="selenium-alert alert-warn">
          “同时运行的账号数”为 {{ data.maxConcurrentRuns }}，但这个 Selenium 只有 {{ server.sessions.total }} 个会话：多出的运行会在 Selenium 中等待，超时后失败。请在<a href="#/settings">设置</a>中调低，或调大 Selenium 的 <code>SE_NODE_MAX_SESSIONS</code>。
        </p>
      </div>
      <small v-if="checkedAt" class="muted">检查于 {{ checkedAt }}</small>
    </article>`,
};
