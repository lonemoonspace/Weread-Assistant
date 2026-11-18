import { computed, onMounted, ref } from "../../vendor/vue.esm-browser.prod.js";
import { api, apiUrl } from "../api.js";
import { formatDateTime } from "../format.js";
import { currentAccount, notify, timezone } from "../store.js";

const WEEKDAYS = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];

// 一天的小结：今天 · 在 2 本书里记了 3 条
function summaryOf(day) {
  const when = day.daysAgo === 0 ? "今天" : day.daysAgo === 1 ? "昨天" : day.daysAgo < 30 ? `${day.daysAgo} 天前` : day.date;
  const count = day.items.length;
  return day.books > 1 ? `${when} · 在 ${day.books} 本书里记了 ${count} 条` : `${when} · ${count} 条`;
}

// 读书日记：当前账号的划线与想法按记下的日期排列；右侧是笔记日历、往年今天与导出
const Journal = {
  props: { account: Object },
  setup(props) {
    const data = ref(null);
    const days = ref([]);
    const next = ref("");
    const loadingMore = ref(false);
    const error = ref("");
    const notes = ref(null);

    async function load() {
      try {
        const [journal, status] = await Promise.all([api(`accounts/${props.account.id}/notes/journal`), api(`accounts/${props.account.id}/notes`)]);
        data.value = journal;
        days.value = journal.days;
        next.value = journal.next;
        notes.value = status;
      } catch (e) {
        error.value = e.message;
      }
    }

    async function more() {
      if (!next.value || loadingMore.value) {
        return;
      }
      loadingMore.value = true;
      try {
        const page = await api(`accounts/${props.account.id}/notes/journal?before=${next.value}`);
        days.value = [...days.value, ...page.days];
        next.value = page.next;
      } catch (e) {
        notify(e.message, "error");
      } finally {
        loadingMore.value = false;
      }
    }

    // 笔记日历按列排：每列一周，从上到下是周一到周日
    const heat = computed(() => (data.value && data.value.heat ? data.value.heat : []));
    const allMarkdownUrl = computed(() => apiUrl(`accounts/${props.account.id}/notes/markdown`));

    onMounted(load);
    return {
      data,
      days,
      next,
      loadingMore,
      error,
      notes,
      heat,
      allMarkdownUrl,
      more,
      summaryOf,
      WEEKDAYS,
      formatDateTime,
      tz: timezone,
    };
  },
  template: `
    <p v-if="error" class="error-text">{{ error }}</p>
    <section v-else-if="!data || !notes" aria-busy="true"></section>
    <article v-else-if="!notes.configured && !data.synced" class="empty-state">
      <h1 class="page-title">读书日记</h1>
      <p>在微信读书里划的线、写的想法，会按日子排在这里。</p>
      <p class="muted">需要{{ account.name }}本人的微信读书 API Key：在<a :href="'#/accounts/' + account.id + '/config'">账号配置</a>的“微信读书 API”分组中填写后，每天自动同步一次，也可以在书库中立即同步。</p>
      <a :href="'#/accounts/' + account.id + '/config'" role="button">去填写 API Key</a>
    </article>
    <template v-else>
    <hgroup class="page-head journal-head">
      <h1 class="page-title">读书日记</h1>
      <p class="journal-stats muted">
        <span>本月 {{ data.stats.monthNotes }} 条笔记</span>
        <span v-if="data.stats.streak">连续 {{ data.stats.streak }} 天</span>
        <span>共 {{ data.total }} 条</span>
      </p>
    </hgroup>
    <div class="journal">
      <div class="journal-main">
        <p v-if="!data.synced" class="muted">还没有同步过笔记，可以在<a href="#/library">书库</a>中立即同步。</p>
        <p v-else-if="!days.length" class="muted">微信读书中还没有划线或想法。</p>
        <section v-for="day in days" :key="day.date" class="journal-day">
          <div class="day-badge" :title="day.date">
            <span class="day-week">{{ WEEKDAYS[day.weekday] }}</span>
            <span class="day-num">{{ day.date.slice(8) }}</span>
            <span class="day-month">{{ Number(day.date.slice(5, 7)) }} 月</span>
          </div>
          <div class="day-body">
            <p class="day-summary muted">{{ summaryOf(day) }}</p>
            <article v-for="item in day.items" :key="item.id" class="journal-card">
              <a class="journal-book" :href="'#/library/' + item.bookId">《{{ item.title }}》</a>
              <p v-if="item.text" class="journal-text">{{ item.text }}</p>
              <p v-for="(review, i) in item.reviews" :key="i" class="journal-thought"><span class="review-mark" aria-hidden="true">✎</span>{{ review }}</p>
              <small v-if="item.chapter" class="muted">{{ item.chapter }}</small>
            </article>
          </div>
        </section>
        <button v-if="next" type="button" class="secondary journal-more" :aria-busy="loadingMore" :disabled="loadingMore" @click="more">更早的笔记</button>
      </div>

      <aside class="journal-side">
        <section v-if="data.onThisDay.length" class="side-card on-this-day">
          <h2>往年今天</h2>
          <div v-for="item in data.onThisDay" :key="item.id" class="on-this-day-item">
            <p class="journal-text">{{ item.text || item.reviews[0] }}</p>
            <small><a :href="'#/library/' + item.bookId">《{{ item.title }}》</a><template v-if="item.author"> · {{ item.author }}</template> · {{ item.yearsAgo }} 年前</small>
          </div>
        </section>

        <section class="side-card">
          <h2>笔记日历</h2>
          <p class="muted">最近 12 周，颜色越亮当天笔记越多</p>
          <div class="note-heat" role="img" :aria-label="'最近 12 周共 ' + heat.reduce((sum, cell) => sum + (cell.notes || 0), 0) + ' 条笔记'">
            <span
              v-for="cell in heat"
              :key="cell.date"
              class="note-heat-cell"
              :class="cell.level < 0 ? 'future' : 'heat-' + cell.level"
              :title="cell.level < 0 ? '' : cell.date + '：' + cell.notes + ' 条'"
            ></span>
          </div>
          <div class="side-stats">
            <div><strong>{{ data.stats.monthNotes }}</strong><span class="muted">本月笔记</span></div>
            <div><strong>{{ data.stats.monthBooks }}</strong><span class="muted">本月记过的书</span></div>
            <div><strong>{{ data.stats.streak }}</strong><span class="muted">连续记笔记天数</span></div>
          </div>
        </section>

        <section class="side-card">
          <h2>导出与备份</h2>
          <a v-if="data.total" :href="allMarkdownUrl" download role="button" class="journal-export">导出全部笔记（Markdown）</a>
          <p class="muted">
            <template v-if="notes.syncedAt">上次同步 {{ formatDateTime(notes.syncedAt, tz()) }} · </template>
            <a href="#/library">到书库同步或按书查看</a>
          </p>
        </section>
      </aside>
    </div>
    </template>`,
};

export const JournalPage = {
  components: { Journal },
  setup() {
    return { account: currentAccount };
  },
  template: `
    <journal v-if="account" :key="'j-' + account.id" :account="account" />
    <article v-else class="empty-state">
      <h1 class="page-title">读书日记</h1>
      <p>还没有账号。在微信读书里划的线、写的想法，会按日子排在这里，旁边是笔记日历与往年今天。</p>
      <p class="muted">先新建一个账号，并在账号配置中填写本人的微信读书 API Key。自动阅读（按计划打开微信读书读一会儿）是可选功能，在“设置”中。</p>
      <a href="#/accounts/new" role="button">新建账号</a>
    </article>`,
};
