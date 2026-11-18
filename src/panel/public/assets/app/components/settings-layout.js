import { SETTINGS_LABELS, SETTINGS_SECTIONS } from "../router.js";
import { state } from "../store.js";

// 设置页的左侧分组（手机宽度下在页面顶部横向排列）。自动阅读下列出各个账号
export const SettingsLayout = {
  props: { section: String, accountId: { type: String, default: "" } },
  setup() {
    return { state, SETTINGS_SECTIONS, SETTINGS_LABELS };
  },
  template: `
    <div class="settings-layout">
      <nav class="settings-nav" aria-label="设置分组">
        <h1 class="page-title">设置</h1>
        <template v-for="name in SETTINGS_SECTIONS" :key="name">
          <a :href="'#/settings/' + name" :aria-current="section === name && !accountId ? 'page' : null">{{ SETTINGS_LABELS[name] }}</a>
          <div v-if="name === 'reading' && state.accounts.length" class="settings-subnav">
            <a
              v-for="item in state.accounts"
              :key="item.id"
              :href="'#/accounts/' + item.id + '/live'"
              :aria-current="accountId === item.id ? 'page' : null"
            >{{ item.name }}</a>
          </div>
        </template>
      </nav>
      <div class="settings-main">
        <slot></slot>
      </div>
    </div>`,
};
