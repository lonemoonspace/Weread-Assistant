import { computed, onBeforeUnmount, onMounted, ref, watch } from "../../vendor/vue.esm-browser.prod.js";
import { api, apiUrl } from "../api.js";
import { Highlighted } from "../components/highlighted.js";
import { dateInZone, formatDateTime } from "../format.js";
import { currentAccount, notify, timezone } from "../store.js";

const POLL_MS = 2000;
const SEARCH_DELAY_MS = 300;
// 宽屏时三栏（书 | 章节 | 笔记），没有选书时显示第一本；窄屏时先显示书的封面网格，点开一本再看笔记
const WIDE_QUERY = "(min-width: 1024px)";
const COVER_COLORS = 8;
const SORTS = [
  ["recent", "最近笔记"],
  ["count", "笔记最多"],
  ["title", "书名"],
];

// unix 秒 → 面板时区的日期
function dayOf(seconds) {
  return seconds ? dateInZone(new Date(seconds * 1000).toISOString(), timezone()) : "";
}

const dayNumber = (date) => {
  const [y, m, d] = date.split("-").map(Number);
  return Date.UTC(y, m - 1, d) / 86400000;
};

// 最近笔记的时间：今天、昨天、N 天前，再早显示日期
function relativeDay(seconds) {
  const date = dayOf(seconds);
  if (!date) {
    return "";
  }
  const today = dateInZone(new Date().toISOString(), timezone());
  const diff = dayNumber(today) - dayNumber(date);
  if (diff <= 0) {
    return "今天";
  }
  if (diff === 1) {
    return "昨天";
  }
  if (diff < 30) {
    return `${diff} 天前`;
  }
  return date.slice(0, 4) === today.slice(0, 4) ? date.slice(5) : date;
}

// 封面色块：按书的 ID 取一种颜色，同一本书每次都一样
function coverClass(bookId) {
  let hash = 0;
  for (const char of String(bookId)) {
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  }
  return `cover-${hash % COVER_COLORS}`;
}

const noteCount = (book) => (book.highlightCount || 0) + (book.reviewItemCount || 0);

// 复制到剪贴板的文字：划线前加“> ”，想法另起一行
function plainText(sections) {
  const lines = [];
  for (const section of sections) {
    lines.push(`## ${section.title}`, "");
    for (const entry of section.entries) {
      if (entry.text) {
        lines.push(...String(entry.text).split(/\r?\n/).map((line) => `> ${line}`), "");
      }
      for (const review of entry.reviews) {
        if (review.content) {
          lines.push(review.content, "");
        }
      }
    }
  }
  return lines.join("\n").trim() + "\n";
}

// 书库：当前账号有笔记的书、章节与笔记。账号在右上角菜单中切换
const Library = {
  components: { Highlighted },
  props: { account: Object, book: String },
  setup(props) {
    const status = ref(null);
    const syncing = ref(false);
    const query = ref("");
    const sort = ref("recent");
    const results = ref(null);
    const searching = ref(false);
    const detail = ref(null);
    const detailError = ref("");
    const chapter = ref("all");
    const wide = ref(false);
    const media = window.matchMedia(WIDE_QUERY);
    const syncWide = () => {
      wide.value = media.matches;
    };
    let pollTimer = null;
    let searchTimer = null;
    let searchRequest = 0;
    let detailRequest = 0;

    async function load() {
      try {
        status.value = await api(`accounts/${props.account.id}/notes`);
      } catch (e) {
        notify(e.message, "error");
      }
      schedulePoll();
    }

    // 同步进行中时每 2 秒刷新一次
    function schedulePoll() {
      clearTimeout(pollTimer);
      pollTimer = status.value && status.value.running ? setTimeout(load, POLL_MS) : null;
    }

    async function sync() {
      syncing.value = true;
      try {
        status.value = await api(`accounts/${props.account.id}/notes/sync`, { method: "POST", body: {} });
        schedulePoll();
      } catch (e) {
        notify(e.message, "error");
      } finally {
        syncing.value = false;
      }
    }

    // 同步结束时提示结果，并重新读取打开的书
    watch(
      () => status.value && status.value.running,
      (running, wasRunning) => {
        if (wasRunning && !running && status.value) {
          if (status.value.lastError) {
            notify(`笔记同步失败：${status.value.lastError}`, "error");
          } else {
            notify("笔记同步完成");
            loadDetail();
          }
        }
      }
    );

    // 搜索划线与想法：停止输入 300 毫秒后请求，只采用最近一次请求的结果
    watch(query, (value) => {
      clearTimeout(searchTimer);
      const text = value.trim();
      if (!text) {
        results.value = null;
        searching.value = false;
        return;
      }
      searching.value = true;
      searchTimer = setTimeout(async () => {
        const request = ++searchRequest;
        try {
          const data = await api(`accounts/${props.account.id}/notes/search?q=${encodeURIComponent(text)}`);
          if (request === searchRequest) {
            results.value = data;
          }
        } catch (e) {
          if (request === searchRequest) {
            notify(e.message, "error");
          }
        } finally {
          if (request === searchRequest) {
            searching.value = false;
          }
        }
      }, SEARCH_DELAY_MS);
    });

    const allBooks = computed(() => (status.value ? status.value.books : []));
    const books = computed(() => {
      const text = query.value.trim().toLowerCase();
      const list = text ? allBooks.value.filter((item) => `${item.title}\n${item.author}`.toLowerCase().includes(text)) : [...allBooks.value];
      // 已没有笔记的书始终排在最后
      const removed = (item) => Number(Boolean(item.removed));
      if (sort.value === "count") {
        list.sort((a, b) => removed(a) - removed(b) || noteCount(b) - noteCount(a));
      } else if (sort.value === "title") {
        list.sort((a, b) => removed(a) - removed(b) || a.title.localeCompare(b.title, "zh-CN"));
      }
      return list;
    });
    const activeCount = computed(() => allBooks.value.filter((item) => !item.removed).length);
    // 打开的书：地址中的书；宽屏且没有指定时是书单中的第一本
    const activeId = computed(() => props.book || (wide.value && allBooks.value.length ? allBooks.value[0].bookId : ""));
    const activeBook = computed(() => allBooks.value.find((item) => item.bookId === activeId.value) || (detail.value && detail.value.book) || null);

    async function loadDetail() {
      const bookId = activeId.value;
      const request = ++detailRequest;
      detailError.value = "";
      if (!bookId) {
        detail.value = null;
        return;
      }
      try {
        const data = await api(`accounts/${props.account.id}/notes/books/${encodeURIComponent(bookId)}`);
        if (request === detailRequest) {
          detail.value = data;
        }
      } catch (e) {
        if (request === detailRequest) {
          detail.value = null;
          detailError.value = e.message;
        }
      }
    }
    watch(activeId, (next, previous) => {
      if (next !== previous) {
        chapter.value = "all";
        detail.value = null;
        loadDetail();
      }
    });

    // 章节：每章的条数；书评与其他想法（不属于任何章节）单独一项
    const sections = computed(() => {
      if (!detail.value) {
        return [];
      }
      const list = detail.value.chapters.map((item) => ({ key: String(item.chapterUid), title: item.title, entries: item.entries }));
      if (detail.value.general.length) {
        list.push({
          key: "general",
          title: "书评与其他想法",
          entries: detail.value.general.map((review) => ({ id: `general-${review.id}`, text: review.abstract, createTime: review.createTime, reviews: [review], star: review.star })),
        });
      }
      return list;
    });
    const totalEntries = computed(() => sections.value.reduce((sum, item) => sum + item.entries.length, 0));
    const shown = computed(() => (chapter.value === "all" ? sections.value : sections.value.filter((item) => item.key === chapter.value)));
    const heading = computed(() => {
      if (chapter.value !== "all" && shown.value.length) {
        return shown.value[0].title;
      }
      return activeBook.value ? activeBook.value.title : "";
    });

    async function copyShown() {
      try {
        await navigator.clipboard.writeText(plainText(shown.value));
        notify(chapter.value === "all" ? "已复制这本书的笔记" : "已复制本章笔记");
      } catch (_) {
        notify("浏览器不允许写入剪贴板（通常需要用 HTTPS 打开面板），可以下载 Markdown", "error");
      }
    }

    const bookMarkdownUrl = computed(() => (activeId.value ? apiUrl(`accounts/${props.account.id}/notes/books/${encodeURIComponent(activeId.value)}/markdown`) : ""));
    const allMarkdownUrl = computed(() => apiUrl(`accounts/${props.account.id}/notes/markdown`));

    onMounted(() => {
      syncWide();
      media.addEventListener("change", syncWide);
      load();
      loadDetail();
    });
    onBeforeUnmount(() => {
      media.removeEventListener("change", syncWide);
      clearTimeout(pollTimer);
      clearTimeout(searchTimer);
    });

    return {
      SORTS,
      status,
      syncing,
      query,
      sort,
      results,
      searching,
      books,
      activeCount,
      activeId,
      activeBook,
      detail,
      detailError,
      chapter,
      sections,
      totalEntries,
      shown,
      heading,
      bookMarkdownUrl,
      allMarkdownUrl,
      sync,
      copyShown,
      dayOf,
      relativeDay,
      coverClass,
      noteCount,
      formatDateTime,
      tz: timezone,
    };
  },
  template: `
    <section v-if="!status" aria-busy="true"></section>
    <article v-else-if="!status.configured && !status.syncedAt" class="empty-state">
      <h1 class="page-title">书库</h1>
      <p>同步笔记需要{{ account.name }}本人的微信读书 API Key。</p>
      <p class="muted">在<a :href="'#/accounts/' + account.id + '/config'">账号配置</a>的“微信读书 API”分组中填写后，这里会按书、按章节显示你在微信读书中的划线与想法，每天也会自动同步一次（时间在“设置 › 面板与默认配置”中调整）。</p>
      <a :href="'#/accounts/' + account.id + '/config'" role="button">去填写 API Key</a>
    </article>
    <div v-else class="library" :class="{ 'book-open': Boolean(book), searching: Boolean(query.trim()) }">
      <aside class="library-books" aria-label="书">
        <div class="pane-head">
          <h1 class="page-title">书库 <small class="muted">{{ activeCount }} 本</small></h1>
          <select v-model="sort" aria-label="排序" class="sort-select">
            <option v-for="[value, label] in SORTS" :key="value" :value="value">{{ label }}</option>
          </select>
        </div>
        <input type="search" v-model="query" placeholder="书名、作者、划线与想法" aria-label="搜索笔记" maxlength="100">
        <div class="book-list">
          <a
            v-for="item in books"
            :key="item.bookId"
            class="book-item"
            :class="{ removed: item.removed }"
            :href="'#/library/' + item.bookId"
            :aria-current="item.bookId === activeId ? 'page' : null"
          >
            <span class="cover" :class="coverClass(item.bookId)" aria-hidden="true"><span class="cover-title">{{ item.title }}</span></span>
            <span class="book-text">
              <span class="book-title">{{ item.title }}</span>
              <span class="book-sub">
                <span class="book-author">{{ item.author }}<template v-if="item.author"> · </template></span>{{ noteCount(item) }} 条<span class="book-when"><template v-if="item.removed"> · 已没有笔记（保留备份）</template><template v-else-if="item.sort"> · {{ relativeDay(item.sort) }}</template></span>
              </span>
            </span>
          </a>
        </div>
        <p v-if="query.trim() && !books.length" class="muted">没有书名或作者包含“{{ query.trim() }}”的书。</p>
        <p v-if="status.syncedAt && !status.books.length" class="muted">微信读书中还没有划线或想法。</p>
        <div class="library-sync">
          <p class="muted">
            <template v-if="status.syncedAt">笔记 {{ status.totalNoteCount }} 条 · 上次同步 {{ formatDateTime(status.syncedAt, tz()) }}</template>
            <template v-else>还没有同步过。</template>
          </p>
          <p v-if="status.lastError" class="error-text">最近一次同步失败（{{ formatDateTime(status.lastErrorAt, tz()) }}）：{{ status.lastError }}</p>
          <p v-if="!status.configured" class="muted">API Key 已经清除，不能再同步；这里是之前同步的内容。</p>
          <div class="notes-actions">
            <button type="button" class="secondary small" :aria-busy="status.running || syncing" :disabled="status.running || syncing || !status.configured" @click="sync">
              {{ status.running ? "正在同步…" : "立即同步" }}
            </button>
            <a v-if="status.books.length" :href="allMarkdownUrl" download role="button" class="secondary outline small">下载全部 Markdown</a>
          </div>
        </div>
      </aside>

      <nav v-if="detail && !query.trim()" class="library-chapters" aria-label="章节">
        <p class="pane-label">{{ detail.book.title }} · 章节</p>
        <button type="button" class="chapter-item" :aria-pressed="chapter === 'all' ? 'true' : 'false'" @click="chapter = 'all'">
          <span>全部</span><span class="chapter-count">{{ totalEntries }}</span>
        </button>
        <button
          v-for="item in sections"
          :key="item.key"
          type="button"
          class="chapter-item"
          :aria-pressed="chapter === item.key ? 'true' : 'false'"
          @click="chapter = item.key"
        >
          <span>{{ item.title }}</span><span class="chapter-count">{{ item.entries.length }}</span>
        </button>
      </nav>

      <section class="library-notes">
        <template v-if="query.trim()">
          <div class="notes-search" :aria-busy="searching">
            <h2 class="notes-heading">包含“{{ query.trim() }}”的笔记</h2>
            <template v-if="results">
              <p v-if="!results.hits.length && !searching" class="muted">没有找到。</p>
              <article v-for="(hit, index) in results.hits" :key="index" class="note-entry">
                <small class="muted"><a :href="'#/library/' + hit.bookId" @click="query = ''">《{{ hit.title }}》</a><template v-if="hit.chapter"> · {{ hit.chapter }}</template></small>
                <p v-if="hit.text" class="note-text"><span class="marker"><highlighted :text="hit.text" :query="query" /></span></p>
                <p v-for="(review, i) in hit.reviews" :key="i" class="note-review"><span class="review-mark" aria-hidden="true">✎</span><span><highlighted :text="review" :query="query" /></span></p>
              </article>
              <p v-if="results.truncated" class="muted">只显示前 {{ results.hits.length }} 条，请换个更具体的词。</p>
            </template>
          </div>
        </template>
        <template v-else-if="activeId">
          <a href="#/library" class="back-link">← 书库</a>
          <p v-if="detailError" class="error-text">{{ detailError }}</p>
          <p v-else-if="!detail" aria-busy="true">正在读取…</p>
          <div v-else class="notes-book">
            <header class="notes-book-head">
              <div>
                <p class="muted">
                  <template v-if="chapter !== 'all'">{{ detail.book.title }} · </template>
                  <template v-if="detail.book.author">{{ detail.book.author }} · </template>
                  <template v-if="activeBook && activeBook.finished">已读完 · </template>
                  <template v-else-if="activeBook && activeBook.readingProgress">读到 {{ activeBook.readingProgress }}% · </template>
                  划线 {{ detail.book.highlightCount ?? 0 }} 条，想法与点评 {{ detail.book.reviewItemCount ?? 0 }} 条
                </p>
                <h2 class="notes-heading">{{ heading }}</h2>
              </div>
              <div class="notes-tools">
                <button v-if="shown.length" type="button" class="secondary small" @click="copyShown">{{ chapter === "all" ? "复制全部" : "复制本章" }}</button>
                <a :href="bookMarkdownUrl" download role="button" class="small">下载 Markdown</a>
              </div>
            </header>
            <div v-if="sections.length > 1" class="chapter-chips" role="group" aria-label="章节">
              <button type="button" class="chapter-item" :aria-pressed="chapter === 'all' ? 'true' : 'false'" @click="chapter = 'all'">全部 {{ totalEntries }}</button>
              <button
                v-for="item in sections"
                :key="item.key"
                type="button"
                class="chapter-item"
                :aria-pressed="chapter === item.key ? 'true' : 'false'"
                @click="chapter = item.key"
              >{{ item.title }} {{ item.entries.length }}</button>
            </div>
            <p v-if="detail.book.removed" class="callout callout-warn">微信读书中已没有这本书的笔记，这里是之前同步的备份。</p>
            <section v-for="item in shown" :key="item.key" class="notes-chapter">
              <h3 v-if="chapter === 'all'">{{ item.title }}</h3>
              <article v-for="entry in item.entries" :key="entry.id" class="note-entry">
                <p v-if="entry.text" class="note-text"><span class="marker">{{ entry.text }}</span></p>
                <p v-for="review in entry.reviews" :key="review.id" class="note-review"><span class="review-mark" aria-hidden="true">✎</span><span>{{ review.content || "（无内容）" }}</span></p>
                <small class="muted">{{ dayOf(entry.createTime) }}<template v-if="entry.star > 0"> · {{ "★".repeat(Math.min(5, entry.star)) }}</template></small>
              </article>
            </section>
            <p v-if="!sections.length" class="muted">这本书没有可显示的划线或想法。</p>
          </div>
        </template>
      </section>
    </div>`,
};

export const LibraryPage = {
  components: { Library },
  props: { book: String },
  setup() {
    return { account: currentAccount };
  },
  template: `
    <library v-if="account" :key="'lib-' + account.id" :account="account" :book="book" />
    <article v-else class="empty-state">
      <h1 class="page-title">书库</h1>
      <p>还没有账号。新建账号并填写本人的微信读书 API Key 后，这里会显示你在微信读书中的划线与想法。</p>
      <a href="#/accounts/new" role="button">新建账号</a>
    </article>`,
};
