import { computed, nextTick, ref, watch } from "../../vendor/vue.esm-browser.prod.js";
import { apiUrl } from "../api.js";
import { QrLogin, RunButtons, StatusBadge } from "../components/common.js";
import { VncLink } from "../components/selenium-status.js";
import { MODE_LABELS, TRIGGER_LABELS, formatShort } from "../format.js";
import { state, timezone } from "../store.js";

// 实时：当前运行的状态、进度、二维码、最新截图与日志；没有运行时显示本页打开后结束的那次
export const LiveTab = {
  components: { QrLogin, RunButtons, StatusBadge, VncLink },
  props: { account: Object },
  setup(props) {
    const run = computed(() => state.runs[props.account.id] || state.finished[props.account.id]);
    const logBox = ref(null);
    const screenshotUrl = computed(() =>
      run.value && run.value.screenshot
        ? apiUrl(`accounts/${props.account.id}/runs/${run.value.id}/screenshots/${run.value.screenshot}`)
        : ""
    );
    const logText = computed(() => (run.value ? run.value.log.join("\n") : ""));
    // 新日志到达时，若原本停在底部则保持滚动到底部
    watch(
      () => run.value && run.value.log.length,
      async () => {
        const box = logBox.value;
        const atBottom = !box || box.scrollHeight - box.scrollTop - box.clientHeight < 40;
        await nextTick();
        if (atBottom && logBox.value) {
          logBox.value.scrollTop = logBox.value.scrollHeight;
        }
      }
    );
    return {
      run,
      logBox,
      logText,
      screenshotUrl,
      tz: computed(timezone),
      formatShort,
      MODE_LABELS,
      TRIGGER_LABELS,
    };
  },
  template: `
    <section>
      <run-buttons :account="account" />
      <p v-if="!account.enabled" class="muted">账号已停用，在“配置”中启用后才能运行。</p>
    </section>

    <section v-if="run" class="live">
      <p class="live-status">
        <status-badge :status="run.status" />
        <span class="muted">{{ TRIGGER_LABELS[run.trigger] }} · {{ MODE_LABELS[run.mode] }} · {{ formatShort(run.queuedAt, tz) }}</span>
        <vnc-link v-if="!run.endedAt && run.status !== 'queued'" />
      </p>
      <p v-if="run.book && !run.endedAt" class="reading">正在读《{{ run.book }}》第 {{ run.minutes }}/{{ run.plannedMinutes }} 分钟</p>
      <p v-else-if="run.book" class="reading">读《{{ run.book }}》{{ run.minutes }} 分钟</p>
      <progress v-if="run.mode === 'read' && run.plannedMinutes" :value="run.minutes" :max="run.plannedMinutes"></progress>
      <p v-if="run.error" class="error-text">{{ run.error }}</p>

      <article v-if="run.status === 'waiting-login'" class="scan-card">
        <qr-login :url="run.loginUrl" :account-id="run.accountId" :qr-at="run.loginQrAt" />
      </article>

      <div class="live-grid">
        <figure v-if="screenshotUrl" class="screenshot">
          <a :href="screenshotUrl" target="_blank" rel="noopener"><img :src="screenshotUrl" alt="最新截图"></a>
          <figcaption class="muted">最新截图：{{ run.screenshot }}</figcaption>
        </figure>
        <div class="log-panel">
          <div class="log-panel-header">
            <span class="log-mac-dots" aria-hidden="true">
              <span class="log-mac-dot red"></span>
              <span class="log-mac-dot yellow"></span>
              <span class="log-mac-dot green"></span>
            </span>
            <span class="log-panel-title">实时输出日志</span>
            <span></span>
          </div>
          <pre ref="logBox" class="log">{{ logText || "等待日志…" }}</pre>
        </div>
      </div>
    </section>

    <section v-else>
      <p class="muted">当前没有运行。运行开始后，这里会实时显示进度、二维码、截图与日志。</p>
      <p v-if="account.lastRun">
        上次运行：<status-badge :status="account.lastRun.status" />
        {{ formatShort(account.lastRun.endedAt || account.lastRun.queuedAt, tz) }}，阅读 {{ account.lastRun.minutes }} 分钟
        <a :href="'#/accounts/' + account.id + '/history'">查看历史</a>
      </p>
    </section>`,
};
