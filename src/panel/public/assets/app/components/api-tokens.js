import { computed, onMounted, reactive, ref } from "../../vendor/vue.esm-browser.prod.js";
import { api } from "../api.js";
import { formatDateTime } from "../format.js";
import { ReauthCancelled, withReauth } from "./reauth-dialog.js";
import { notify, state, timezone } from "../store.js";

const EXPIRY_OPTIONS = [
  [null, "不过期"],
  [30, "30 天"],
  [90, "90 天"],
  [365, "1 年"],
];

// 设置页的“API 令牌”：给脚本与 AI 助手用的令牌，按权限与账号限定。新建时需要近期验证过身份（页面中要有 <reauth-dialog>）
export const ApiTokens = {
  setup() {
    const tokens = ref([]);
    const scopes = ref({});
    const form = reactive({ name: "", scopes: ["read"], allAccounts: true, accounts: [], expiresInDays: null });
    const creating = ref(false);
    // 刚创建的令牌：只显示这一次
    const created = ref(null);

    async function load() {
      try {
        const data = await api("tokens");
        tokens.value = data.tokens;
        scopes.value = data.scopes;
      } catch (error) {
        notify(error.message, "error");
      }
    }

    async function create() {
      creating.value = true;
      try {
        const body = {
          name: form.name,
          scopes: form.scopes,
          accounts: form.allAccounts ? null : form.accounts,
          expiresInDays: form.expiresInDays,
        };
        created.value = await withReauth(() => api("tokens", { method: "POST", body }));
        Object.assign(form, { name: "", scopes: ["read"], allAccounts: true, accounts: [], expiresInDays: null });
        await load();
      } catch (error) {
        if (!(error instanceof ReauthCancelled)) {
          notify(error.message, "error");
        }
      } finally {
        creating.value = false;
      }
    }

    async function remove(token) {
      if (!window.confirm(`确定删除令牌“${token.name}”？用它的脚本与助手会立即失去访问权限。`)) {
        return;
      }
      try {
        await api(`tokens/${encodeURIComponent(token.id)}`, { method: "DELETE" });
        await load();
        notify("令牌已删除");
      } catch (error) {
        notify(error.message, "error");
      }
    }

    async function copy() {
      try {
        await navigator.clipboard.writeText(created.value.token);
        notify("已复制");
      } catch (_) {
        notify("浏览器不允许写剪贴板，请手动选中复制", "error");
      }
    }

    const accountNames = computed(() => Object.fromEntries(state.accounts.map((account) => [account.id, account.name])));
    const accountsLabel = (token) => (token.accounts === null ? "全部账号" : token.accounts.map((id) => accountNames.value[id] || id).join("、"));
    const scopesLabel = (token) => token.scopes.map((scope) => scopes.value[scope] || scope).join("；");
    const expired = (token) => token.expiresAt && Date.parse(token.expiresAt) <= Date.now();
    const baseUrl = computed(() => new URL("api/v1/", location.href).href);

    onMounted(load);
    return { tokens, scopes, form, creating, created, create, remove, copy, accountsLabel, scopesLabel, expired, baseUrl, state, formatDateTime, tz: timezone, EXPIRY_OPTIONS };
  },
  template: `
    <div class="api-tokens">
      <p class="muted">
        给脚本、快捷指令与 AI 助手用的令牌，在请求头中带上 <code>Authorization: Bearer 令牌</code> 访问 <code>{{ baseUrl }}</code>。
        令牌只能做勾选的事、只能访问选定的账号，不能修改设置、配置与密钥，也拿不到 cookies 与登录链接。
      </p>
      <article v-if="created" class="token-created">
        <p><strong>令牌“{{ created.info.name }}”已创建。</strong>它只显示这一次，请现在复制保存；丢失后删除重建即可。</p>
        <div class="inline-form">
          <input readonly :value="created.token" aria-label="新令牌" @focus="$event.target.select()">
          <button type="button" @click="copy">复制</button>
        </div>
        <p class="muted">试一下：<code>curl -H "Authorization: Bearer {{ created.token.slice(0, 8) }}…" {{ baseUrl }}accounts</code></p>
        <button type="button" class="secondary outline" @click="created = null">我已保存</button>
      </article>
      <div v-if="tokens.length" class="table-scroll">
        <table class="striped history token-table">
          <thead><tr><th>名称</th><th>权限</th><th>账号</th><th>最近使用</th><th></th></tr></thead>
          <tbody>
            <tr v-for="token in tokens" :key="token.id">
              <td data-label="名称">
                {{ token.name }}<br><small class="muted"><code>{{ token.hint }}</code></small>
                <span v-if="expired(token)" class="badge passkey-unusable">已过期</span>
              </td>
              <td data-label="权限"><small>{{ scopesLabel(token) }}</small></td>
              <td data-label="账号"><small>{{ accountsLabel(token) }}</small></td>
              <td data-label="最近使用">
                <small>{{ token.lastUsedAt ? formatDateTime(token.lastUsedAt, tz()) : "从未使用" }}</small>
                <br><small class="muted">{{ token.expiresAt ? formatDateTime(token.expiresAt, tz()) + " 过期" : "不过期" }}</small>
              </td>
              <td class="actions"><button type="button" class="secondary outline" @click="remove(token)">删除</button></td>
            </tr>
          </tbody>
        </table>
      </div>
      <p v-else class="muted">还没有令牌。</p>
      <form class="narrow" @submit.prevent="create">
        <label>名称<input v-model.trim="form.name" maxlength="40" required placeholder="例如：快捷指令、Claude"></label>
        <fieldset>
          <legend>权限</legend>
          <label v-for="(label, scope) in scopes" :key="scope"><input type="checkbox" :value="scope" v-model="form.scopes"> {{ label }}</label>
        </fieldset>
        <fieldset>
          <legend>账号</legend>
          <label><input type="checkbox" v-model="form.allAccounts"> 全部账号（包括以后新建的）</label>
          <template v-if="!form.allAccounts">
            <label v-for="account in state.accounts" :key="account.id"><input type="checkbox" :value="account.id" v-model="form.accounts"> {{ account.name }}（{{ account.id }}）</label>
          </template>
        </fieldset>
        <label>有效期
          <select v-model="form.expiresInDays">
            <option v-for="[value, label] in EXPIRY_OPTIONS" :key="label" :value="value">{{ label }}</option>
          </select>
        </label>
        <button type="submit" :aria-busy="creating" :disabled="creating || !form.scopes.length || (!form.allAccounts && !form.accounts.length)">新建令牌</button>
      </form>
    </div>`,
};
