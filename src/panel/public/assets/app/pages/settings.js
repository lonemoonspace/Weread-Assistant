import { computed, onMounted, reactive, ref, watch } from "../../vendor/vue.esm-browser.prod.js";
import { api } from "../api.js";
import { ConfigForm } from "../components/config-form.js";
import { ReauthCancelled, ReauthDialog, withReauth } from "../components/reauth-dialog.js";
import { TestNotification } from "../components/test-notification.js";
import { formatDateTime } from "../format.js";
import { notify, refreshAccounts, refreshSettings, state, timezone } from "../store.js";
import { createPasskey, originMatches, passkeyErrorMessage, passkeySupported } from "../webauthn.js";

const COMMON_TIMEZONES = ["Asia/Shanghai", "Asia/Hong_Kong", "Asia/Taipei", "Asia/Tokyo", "Asia/Singapore", "Europe/London", "America/New_York", "UTC"];

// 设置：面板设置、全局默认运行配置、测试通知、登录方式（passkey 与面板密码）
export const SettingsPage = {
  components: { ConfigForm, ReauthDialog, TestNotification },
  setup() {
    const panel = reactive({});
    const savingPanel = ref(false);
    const savingDefaults = ref(false);
    const password = reactive({ current: "", next: "", confirm: "" });
    const passwordError = ref("");
    const savingPassword = ref(false);

    function resetPanel() {
      Object.assign(panel, state.settings);
    }
    resetPanel();
    watch(() => state.settings, resetPanel);

    const fields = computed(() => state.schema.settingsFields);

    async function saveSettings(body, message) {
      await api("settings", { method: "PATCH", body });
      await Promise.all([refreshSettings(), refreshAccounts()]);
      notify(message);
    }

    async function savePanel() {
      const patch = {};
      for (const field of fields.value) {
        if (panel[field.key] !== state.settings[field.key]) {
          patch[field.key] = panel[field.key];
        }
      }
      if (!Object.keys(patch).length) {
        notify("没有需要保存的修改");
        return;
      }
      savingPanel.value = true;
      try {
        await saveSettings({ settings: patch }, "面板设置已保存");
      } catch (error) {
        notify(error.message, "error");
      } finally {
        savingPanel.value = false;
      }
    }

    async function saveDefaults(patch) {
      if (!Object.keys(patch).length) {
        notify("没有需要保存的修改");
        return;
      }
      savingDefaults.value = true;
      try {
        await saveSettings({ defaults: patch }, "全局默认配置已保存，下次运行生效");
      } catch (error) {
        notify(error.message, "error");
      } finally {
        savingDefaults.value = false;
      }
    }

    async function changePassword() {
      passwordError.value = "";
      if (password.next !== password.confirm) {
        passwordError.value = "两次输入的新密码不一致";
        return;
      }
      savingPassword.value = true;
      try {
        await api("auth/password", { method: "POST", body: { current: password.current, next: password.next } });
        Object.assign(password, { current: "", next: "", confirm: "" });
        notify("密码已修改，其他设备上的登录已失效");
      } catch (error) {
        passwordError.value =
          error.code === "wrong_password"
            ? "当前密码不正确"
            : error.code === "password_too_short"
              ? `新密码至少 ${state.session.minPasswordLength} 位`
              : error.message;
      } finally {
        savingPassword.value = false;
      }
    }

    // passkey：列表、添加（先填名称再调用系统弹窗）、改名、删除；添加与删除需要二次验证
    const passkeys = ref([]);
    const newPasskeyName = ref("");
    const addingPasskey = ref(false);
    const editing = reactive({ id: "", name: "" });
    const passkeyInfo = computed(() => state.session.passkey);
    const onPasskeyOrigin = computed(() => originMatches(passkeyInfo.value));
    const supported = passkeySupported();

    async function loadPasskeys() {
      try {
        passkeys.value = (await api("auth/passkeys")).passkeys;
      } catch (error) {
        notify(error.message, "error");
      }
    }
    onMounted(loadPasskeys);

    async function addPasskey() {
      addingPasskey.value = true;
      try {
        const options = await withReauth(() => api("auth/passkeys/options", { method: "POST" }));
        let response;
        try {
          response = await createPasskey(options);
        } catch (error) {
          const text = passkeyErrorMessage(error);
          if (text) {
            notify(text, "error");
          }
          return;
        }
        const body = { name: newPasskeyName.value || undefined, response };
        await withReauth(() => api("auth/passkeys", { method: "POST", body }));
        newPasskeyName.value = "";
        await loadPasskeys();
        notify("passkey 已添加，下次可以用它登录");
      } catch (error) {
        if (!(error instanceof ReauthCancelled)) {
          notify(error.message, "error");
        }
      } finally {
        addingPasskey.value = false;
      }
    }

    function startRename(item) {
      Object.assign(editing, { id: item.id, name: item.name });
    }

    async function saveRename() {
      try {
        await api(`auth/passkeys/${encodeURIComponent(editing.id)}`, { method: "PATCH", body: { name: editing.name } });
        Object.assign(editing, { id: "", name: "" });
        await loadPasskeys();
      } catch (error) {
        notify(error.message, "error");
      }
    }

    async function removePasskey(item) {
      if (!window.confirm(`确定删除 passkey“${item.name}”？用它登录的其他设备会退出登录。`)) {
        return;
      }
      try {
        await withReauth(() => api(`auth/passkeys/${encodeURIComponent(item.id)}`, { method: "DELETE" }));
        await loadPasskeys();
        notify("passkey 已删除");
      } catch (error) {
        if (!(error instanceof ReauthCancelled)) {
          notify(error.message, "error");
        }
      }
    }

    return {
      state,
      panel,
      fields,
      savingPanel,
      savingDefaults,
      password,
      passwordError,
      savingPassword,
      savePanel,
      saveDefaults,
      changePassword,
      resetPanel,
      COMMON_TIMEZONES,
      passkeys,
      newPasskeyName,
      addingPasskey,
      editing,
      passkeyInfo,
      onPasskeyOrigin,
      supported,
      addPasskey,
      startRename,
      saveRename,
      cancelRename: () => Object.assign(editing, { id: "", name: "" }),
      removePasskey,
      formatDateTime,
      timezone,
    };
  },
  template: `
    <h2>设置</h2>

    <section>
      <h3>面板</h3>
      <form @submit.prevent="savePanel">
        <div class="grid settings-grid">
          <label v-for="field in fields" :key="field.key">
            {{ field.label }}
            <template v-if="field.key === 'timezone'">
              <input v-model.trim="panel.timezone" list="timezones" required>
              <datalist id="timezones"><option v-for="zone in COMMON_TIMEZONES" :key="zone" :value="zone"></option></datalist>
            </template>
            <input v-else-if="field.type === 'integer'" type="number" step="1" :min="field.min" :max="field.max" v-model.number="panel[field.key]" required>
            <input v-else v-model.trim="panel[field.key]" :placeholder="field.key === 'vncUrl' ? 'http://192.168.1.10:7900/' : ''">
            <small v-if="field.description" class="muted">{{ field.description }}</small>
          </label>
        </div>
        <aside v-if="panel.vncUrl" class="callout callout-warn" role="note">
          noVNC 画面就是已登录微信读书的浏览器，能打开该地址并知道 VNC 密码的人都可以看到并操作它。不建议经反向代理或公网暴露 7900 端口；需要时请修改 Selenium 默认的 VNC 密码（<code>SE_VNC_PASSWORD</code>，默认为 secret），并使用只读模式（<code>SE_VNC_VIEW_ONLY=1</code>）。
        </aside>
        <div class="form-actions">
          <button type="submit" :aria-busy="savingPanel" :disabled="savingPanel">保存</button>
          <button type="button" class="secondary" @click="resetPanel">撤销修改</button>
        </div>
      </form>
    </section>

    <section>
      <h3>全局默认配置</h3>
      <p class="muted">所有账号默认使用这里的配置，账号可以在“配置”中单独覆盖。未填写的项使用内置默认值。</p>
      <config-form mode="defaults" :schema="state.schema" :values="state.defaults" :saving="savingDefaults" @save="saveDefaults" />
      <h4>测试通知</h4>
      <test-notification />
    </section>

    <section>
      <h3>登录方式</h3>
      <h4>passkey</h4>
      <p class="muted">用指纹、面容或设备 PIN 登录面板，不用输入密码。passkey 与面板的域名绑定，更换域名后需要重新添加。</p>
      <p v-if="!passkeyInfo.available" class="muted">需要把环境变量 PANEL_PUBLIC_URL 设置为面板的 HTTPS 地址（例如 https://example.com/weread/）并重启面板，才能使用 passkey。</p>
      <p v-else-if="!onPasskeyOrigin" class="callout callout-warn">passkey 只能在 {{ passkeyInfo.origin }} 上使用，请从这个地址打开面板后再添加。</p>
      <div v-if="passkeys.length" class="table-scroll">
        <table class="striped passkey-table">
          <thead><tr><th>名称</th><th>添加于</th><th>最近使用</th><th></th></tr></thead>
          <tbody>
            <tr v-for="item in passkeys" :key="item.id">
              <td>
                <form v-if="editing.id === item.id" class="inline-form" @submit.prevent="saveRename">
                  <input v-model.trim="editing.name" maxlength="64" required aria-label="passkey 名称">
                  <button type="submit">保存</button>
                  <button type="button" class="secondary outline" @click="cancelRename">取消</button>
                </form>
                <template v-else>
                  {{ item.name }}
                  <span v-if="item.backedUp" class="badge" title="已同步到 iCloud 钥匙串、Google 密码管理器等，换设备后仍可使用">已同步</span>
                  <span v-if="!item.usable" class="badge passkey-unusable" title="这个 passkey 不是在当前域名下添加的，不能用于登录">当前域名不可用</span>
                </template>
              </td>
              <td>{{ formatDateTime(item.createdAt, timezone()) }}</td>
              <td>{{ item.lastUsedAt ? formatDateTime(item.lastUsedAt, timezone()) : "从未使用" }}</td>
              <td class="actions">
                <button type="button" class="secondary outline" @click="startRename(item)">改名</button>
                <button type="button" class="secondary outline" @click="removePasskey(item)">删除</button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p v-else class="muted">还没有添加 passkey。</p>
      <form v-if="onPasskeyOrigin && supported" class="narrow" @submit.prevent="addPasskey">
        <label>名称<input v-model.trim="newPasskeyName" maxlength="64" placeholder="例如：我的 iPhone"></label>
        <button type="submit" :aria-busy="addingPasskey" :disabled="addingPasskey">添加 passkey</button>
      </form>
      <p v-else-if="onPasskeyOrigin" class="muted">这个浏览器不支持 passkey。</p>
      <reauth-dialog :passkeys="passkeys" />

      <h4>面板密码</h4>
      <p v-if="state.session.passwordFromEnv" class="muted">面板密码由环境变量 PANEL_PASSWORD 设置，请修改该变量后重启面板。</p>
      <form v-else class="narrow" @submit.prevent="changePassword">
        <label>当前密码<input type="password" v-model="password.current" autocomplete="current-password" required></label>
        <label>新密码<input type="password" v-model="password.next" autocomplete="new-password" :minlength="state.session.minPasswordLength" required></label>
        <label>再次输入新密码<input type="password" v-model="password.confirm" autocomplete="new-password" required></label>
        <p v-if="passwordError" class="error-text">{{ passwordError }}</p>
        <button type="submit" :aria-busy="savingPassword" :disabled="savingPassword">修改密码</button>
      </form>
    </section>

    <section>
      <h3>关于</h3>
      <p>WeReadAssistant {{ state.session.version }}。非微信读书官方工具，与腾讯无关；打卡统计按本工具的运行记录计算，非微信读书官方数据。</p>
    </section>`,
};
