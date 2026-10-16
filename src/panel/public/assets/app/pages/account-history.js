import { onMounted, reactive, ref, watch } from "../../vendor/vue.esm-browser.prod.js";
import { api, apiText, apiUrl } from "../api.js";
import { StatusBadge } from "../components/common.js";
import { MODE_LABELS, TRIGGER_LABELS, durationBetween, formatShort } from "../format.js";
import { notify, state, timezone } from "../store.js";

// 历史：运行列表、日志查看与下载、截图回看
export const HistoryTab = {
  components: { StatusBadge },
  props: { account: Object },
  setup(props) {
    const runs = ref([]);
    const nextBefore = ref(null);
    const loading = ref(false);
    const expanded = reactive({});

    async function load(more = false) {
      loading.value = true;
      try {
        const query = more && nextBefore.value ? `&before=${nextBefore.value}` : "";
        const data = await api(`accounts/${props.account.id}/runs?limit=20${query}`);
        runs.value = more ? [...runs.value, ...data.runs] : data.runs;
        nextBefore.value = data.nextBefore;
      } catch (error) {
        notify(error.message, "error");
      } finally {
        loading.value = false;
      }
    }

    async function toggle(run, kind) {
      const current = expanded[run.id];
      if (current && current.kind === kind) {
        delete expanded[run.id];
        return;
      }
      expanded[run.id] = { kind, text: "", loading: kind === "log" };
      if (kind === "log") {
        try {
          expanded[run.id].text = await apiText(`accounts/${props.account.id}/runs/${run.id}/log`);
        } catch (error) {
          expanded[run.id].text = error.message;
        } finally {
          expanded[run.id].loading = false;
        }
      }
    }

    onMounted(() => load());
    // 本页打开期间有运行结束时刷新列表
    watch(() => state.finished[props.account.id], () => load());

    return {
      runs,
      nextBefore,
      loading,
      expanded,
      load,
      toggle,
      apiUrl,
      tz: timezone,
      formatShort,
      durationBetween,
      MODE_LABELS,
      TRIGGER_LABELS,
    };
  },
  template: `
    <section>
      <p v-if="!runs.length && !loading" class="muted">还没有运行记录。</p>
      <div v-else class="table-scroll">
        <table class="history">
          <thead>
            <tr><th>开始时间</th><th>触发</th><th>结果</th><th>阅读</th><th>操作</th></tr>
          </thead>
          <tbody>
            <template v-for="run in runs" :key="run.id">
              <tr>
                <td>{{ formatShort(run.startedAt || run.queuedAt, tz()) }}<br><small class="muted">{{ durationBetween(run.startedAt, run.endedAt) }}</small></td>
                <td>{{ TRIGGER_LABELS[run.trigger] || run.trigger }}<br><small class="muted">{{ MODE_LABELS[run.mode] }}</small></td>
                <td><status-badge :status="run.status" /><br><small v-if="run.error" class="error-text">{{ run.error }}</small></td>
                <td>{{ run.minutes }} 分钟<br><small v-if="run.book" class="muted">《{{ run.book }}》</small></td>
                <td class="actions">
                  <button type="button" class="outline small" :disabled="!run.hasLog" @click="toggle(run, 'log')">日志</button>
                  <button type="button" class="outline small" :disabled="!run.screenshots.length" @click="toggle(run, 'shots')">截图 {{ run.screenshots.length || "" }}</button>
                </td>
              </tr>
              <tr v-if="expanded[run.id]" class="expanded">
                <td colspan="5">
                  <template v-if="expanded[run.id].kind === 'log'">
                    <p><a :href="apiUrl('accounts/' + account.id + '/runs/' + run.id + '/log?download=1')">下载日志</a></p>
                    <pre class="log" :aria-busy="expanded[run.id].loading">{{ expanded[run.id].text }}</pre>
                  </template>
                  <div v-else class="gallery">
                    <a v-for="name in run.screenshots" :key="name" :href="apiUrl('accounts/' + account.id + '/runs/' + run.id + '/screenshots/' + name)" target="_blank" rel="noopener">
                      <img loading="lazy" :src="apiUrl('accounts/' + account.id + '/runs/' + run.id + '/screenshots/' + name)" :alt="name">
                    </a>
                  </div>
                </td>
              </tr>
            </template>
          </tbody>
        </table>
      </div>
      <button v-if="nextBefore" type="button" class="secondary" :aria-busy="loading" @click="load(true)">加载更多</button>
      <p class="muted">截图只保留最近几次运行，日志按设置的天数保留，可在“设置”中调整。</p>
    </section>`,
};
