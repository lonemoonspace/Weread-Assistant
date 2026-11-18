import { NotesTab } from "./account-notes.js";
import { currentAccount } from "../store.js";

// 书库：当前账号有笔记的书。账号在右上角菜单中切换
export const LibraryPage = {
  components: { NotesTab },
  props: { book: String },
  setup() {
    return { account: currentAccount };
  },
  template: `
    <template v-if="account">
      <hgroup class="page-head">
        <h1 class="page-title">书库</h1>
        <p class="muted">{{ account.name }}的划线与想法</p>
      </hgroup>
      <notes-tab :key="'n-' + account.id" :account="account" :book="book" />
    </template>
    <article v-else class="empty-state">
      <h1 class="page-title">书库</h1>
      <p>还没有账号。新建账号并填写本人的微信读书 API Key 后，这里会显示你在微信读书中的划线与想法。</p>
      <a href="#/accounts/new" role="button">新建账号</a>
    </article>`,
};
