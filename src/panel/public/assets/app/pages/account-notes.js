import { computed, onBeforeUnmount, onMounted, ref, watch } from "../../vendor/vue.esm-browser.prod.js";
import { api, apiUrl } from "../api.js";
import { dateInZone, formatDateTime } from "../format.js";
import { notify, timezone } from "../store.js";

const POLL_MS = 2000;
const SEARCH_DELAY_MS = 300;

// unix 秒 → 面板时区的日期
function dayOf(seconds) {
  return seconds ? dateInZone(new Date(seconds * 1000).toISOString(), timezone()) : "";
}

// 把文字按搜索词切开，命中的部分用 <mark> 显示（逐段输出文字，不拼 HTML）
function pieces(text, query) {
  const source = String(text || "");
  const needle = query.trim().toLowerCase();
  if (!needle) {
    return [{ text: source, hit: false }];
  }
  const lower = source.toLowerCase();
  const result = [];
  let from = 0;
  for (let at = lower.indexOf(needle); at >= 0; at = lower.indexOf(needle, from)) {
    if (at > from) {
      result.push({ text: source.slice(from, at), hit: false });
    }
    result.push({ text: source.slice(at, at + needle.length), hit: true });
    from = at + needle.length;
  }
  if (from < source.length) {
    result.push({ text: source.slice(from), hit: false });
  }
  return result;
}

const Highlighted = {
  props: { text: String, query: { type: String, default: "" } },
  setup(props) {
    return { parts: computed(() => pieces(props.text, props.query)) };
  },
  template: `<template v-for="(part, index) in parts" :key="index"><mark v-if="part.hit">{{ part.text }}</mark><template v-else>{{ part.text }}</template></template>`,
};

// 一本书：按章节显示划线与想法
const NotesBook = {
  components: { Highlighted },
  props: { account: Object, bookId: String },
  setup(props) {
    const data = ref(null);
    const error = ref("");
    onMounted(async () => {
      try {
        data.value = await api(`accounts/${props.account.id}/notes/books/${encodeURIComponent(props.bookId)}`);
      } catch (e) {
        error.value = e.message;
      }
    });
    const markdownUrl = computed(() => apiUrl(`accounts/${props.account.id}/notes/books/${encodeURIComponent(props.bookId)}/markdown`));
    return { data, error, markdownUrl, dayOf };
  },
  template: `
    <section class="notes-book">
      <p><a href="#/library">← 返回书单</a></p>
      <p v-if="error" class="error-text">{{ error }}</p>
      <p v-else-if="!data" aria-busy="true">正在读取…</p>
      <template v-else>
        <hgroup>
          <h3>{{ data.book.title }}</h3>
          <p class="muted">
            <template v-if="data.book.author">{{ data.book.author }} · </template>
            划线 {{ data.book.highlightCount ?? 0 }} 条，想法与点评 {{ data.book.reviewItemCount ?? 0 }} 条
            <template v-if="data.book.removed"> · 微信读书中已没有这本书的笔记，这里是之前同步的备份</template>
          </p>
        </hgroup>
        <p><a :href="markdownUrl" download>下载 Markdown</a></p>
        <section v-for="chapter in data.chapters" :key="chapter.chapterUid" class="notes-chapter">
          <h4>{{ chapter.title }}</h4>
          <article v-for="entry in chapter.entries" :key="entry.id" class="note-entry">
            <blockquote v-if="entry.text">{{ entry.text }}</blockquote>
            <p v-for="review in entry.reviews" :key="review.id" class="note-review">{{ review.content }}</p>
            <small class="muted">{{ dayOf(entry.createTime) }}</small>
          </article>
        </section>
        <section v-if="data.general.length" class="notes-chapter">
          <h4>书评与其他想法</h4>
          <article v-for="review in data.general" :key="review.id" class="note-entry">
            <blockquote v-if="review.abstract">{{ review.abstract }}</blockquote>
            <p class="note-review">{{ review.content || "（无内容）" }}</p>
            <small class="muted">{{ dayOf(review.createTime) }}<template v-if="review.star > 0"> · {{ "★".repeat(Math.min(5, review.star)) }}</template></small>
          </article>
        </section>
        <p v-if="!data.chapters.length && !data.general.length" class="muted">这本书没有可显示的划线或想法。</p>
      </template>
    </section>`,
};

// 笔记：同步状态、书单与搜索；选中一本书时显示这本书的笔记
export const NotesTab = {
  components: { Highlighted, NotesBook },
  props: { account: Object, book: String },
  setup(props) {
    const status = ref(null);
    const syncing = ref(false);
    const query = ref("");
    const results = ref(null);
    const searching = ref(false);
    let pollTimer = null;
    let searchTimer = null;
    let searchRequest = 0;

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

    // 同步结束时提示结果
    watch(
      () => status.value && status.value.running,
      (running, wasRunning) => {
        if (wasRunning && !running && status.value) {
          if (status.value.lastError) {
            notify(`笔记同步失败：${status.value.lastError}`, "error");
          } else {
            notify("笔记同步完成");
          }
        }
      }
    );

    // 搜索笔记内容：停止输入 300 毫秒后请求，只采用最近一次请求的结果
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

    const books = computed(() => {
      const list = status.value ? status.value.books : [];
      const text = query.value.trim().toLowerCase();
      return text ? list.filter((book) => `${book.title}\n${book.author}`.toLowerCase().includes(text)) : list;
    });
    const activeCount = computed(() => (status.value ? status.value.books.filter((book) => !book.removed).length : 0));
    const allMarkdownUrl = computed(() => apiUrl(`accounts/${props.account.id}/notes/markdown`));

    onMounted(load);
    onBeforeUnmount(() => {
      clearTimeout(pollTimer);
      clearTimeout(searchTimer);
    });

    return { status, syncing, query, results, searching, books, activeCount, allMarkdownUrl, sync, dayOf, formatDateTime, tz: timezone };
  },
  template: `
    <notes-book v-if="book" :key="book" :account="account" :book-id="book" />
    <section v-else-if="!status" aria-busy="true"></section>
    <section v-else-if="!status.configured && !status.syncedAt">
      <p>同步笔记需要本人的微信读书 API Key。</p>
      <p class="muted">在<a :href="'#/accounts/' + account.id + '/config'">配置</a>的“微信读书 API”分组中填写后，可以在这里同步划线与想法，每天也会自动同步一次（时间在“设置”中调整）。</p>
    </section>
    <template v-else>
      <section class="notes-head">
        <p>
          <template v-if="status.syncedAt">有笔记的书 {{ activeCount }} 本，笔记 {{ status.totalNoteCount }} 条 · 上次同步 {{ formatDateTime(status.syncedAt, tz()) }}</template>
          <template v-else>还没有同步过。</template>
        </p>
        <p v-if="status.lastError" class="error-text">最近一次同步失败（{{ formatDateTime(status.lastErrorAt, tz()) }}）：{{ status.lastError }}</p>
        <p v-if="!status.configured" class="muted">API Key 已经清除，不能再同步；下面是之前同步的内容。</p>
        <div class="notes-actions">
          <button type="button" :aria-busy="status.running || syncing" :disabled="status.running || syncing || !status.configured" @click="sync">
            {{ status.running ? "正在同步…" : "立即同步" }}
          </button>
          <a v-if="status.books.length" :href="allMarkdownUrl" download role="button" class="secondary">下载全部 Markdown</a>
        </div>
      </section>
      <section v-if="status.books.length">
        <input type="search" v-model="query" placeholder="搜索书名、作者、划线与想法" aria-label="搜索笔记" maxlength="100">
        <div v-if="books.length" class="table-scroll">
          <table class="history notes-books">
            <thead>
              <tr><th>书</th><th>划线</th><th>想法</th><th>最近笔记</th></tr>
            </thead>
            <tbody>
              <tr v-for="item in books" :key="item.bookId" :class="{ 'notes-removed': item.removed }">
                <td data-label="书">
                  <a :href="'#/library/' + item.bookId">{{ item.title }}</a>
                  <br><small class="muted">{{ item.author }}<template v-if="item.finished"> · 已读完</template><template v-else-if="item.readingProgress"> · 读到 {{ item.readingProgress }}%</template><template v-if="item.removed"> · 已没有笔记（保留备份）</template></small>
                </td>
                <td data-label="划线">{{ item.highlightCount ?? "-" }}</td>
                <td data-label="想法">{{ item.reviewItemCount ?? "-" }}</td>
                <td data-label="最近笔记">{{ dayOf(item.sort) || "-" }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p v-if="query.trim() && !books.length" class="muted">没有书名或作者包含“{{ query.trim() }}”的书。</p>
      </section>
      <section v-if="query.trim()" class="notes-search" :aria-busy="searching">
        <h4>笔记中包含“{{ query.trim() }}”的内容</h4>
        <template v-if="results">
          <p v-if="!results.hits.length && !searching" class="muted">没有找到。</p>
          <article v-for="(hit, index) in results.hits" :key="index" class="note-entry">
            <small class="muted"><a :href="'#/library/' + hit.bookId">《{{ hit.title }}》</a><template v-if="hit.chapter"> · {{ hit.chapter }}</template></small>
            <blockquote v-if="hit.text"><highlighted :text="hit.text" :query="query" /></blockquote>
            <p v-for="(review, i) in hit.reviews" :key="i" class="note-review"><highlighted :text="review" :query="query" /></p>
          </article>
          <p v-if="results.truncated" class="muted">只显示前 {{ results.hits.length }} 条，请换个更具体的词。</p>
        </template>
      </section>
      <p v-else-if="status.syncedAt && !status.books.length" class="muted">微信读书中还没有划线或想法。</p>
    </template>`,
};
