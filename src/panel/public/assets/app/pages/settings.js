import { computed, reactive, ref, watch } from "../../vendor/vue.esm-browser.prod.js";
import { api } from "../api.js";
import { ConfigForm } from "../components/config-form.js";
import { TestNotification } from "../components/test-notification.js";
import { notify, refreshAccounts, refreshSettings, state } from "../store.js";

const COMMON_TIMEZONES = ["Asia/Shanghai", "Asia/Hong_Kong", "Asia/Taipei", "Asia/Tokyo", "Asia/Singapore", "Europe/London", "America/New_York", "UTC"];

// 设置：面板设置、全局默认运行配置、测试通知、面板密码
export const SettingsPage = {
  components: { ConfigForm, TestNotification },
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
      <h3>面板密码</h3>
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
