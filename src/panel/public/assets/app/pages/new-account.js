import { reactive, ref } from "../../vendor/vue.esm-browser.prod.js";
import { api } from "../api.js";
import { go } from "../router.js";
import { notify, refreshAccounts } from "../store.js";

export const NewAccountPage = {
  setup() {
    const form = reactive({ id: "", name: "" });
    const error = ref("");
    const saving = ref(false);
    async function submit() {
      error.value = "";
      saving.value = true;
      try {
        const { account } = await api("accounts", { method: "POST", body: { id: form.id, name: form.name || undefined } });
        await refreshAccounts();
        notify("账号已创建。点击“仅登录”用微信扫码，登录后再设置调度。");
        go(`/accounts/${account.id}/live`);
      } catch (e) {
        error.value = e.message;
      } finally {
        saving.value = false;
      }
    }
    return { form, error, saving, submit };
  },
  template: `
    <article class="narrow">
      <h2>新建账号</h2>
      <form @submit.prevent="submit">
        <label>
          账号 ID
          <input v-model.trim="form.id" required maxlength="32" placeholder="例如 me" autocomplete="off">
          <small class="muted">小写字母、数字与短横线，1–32 位，不以短横线开头或结尾；创建后不能修改，同时用作数据目录名。</small>
        </label>
        <label>
          名称
          <input v-model.trim="form.name" maxlength="32" placeholder="显示在面板与通知标题中，默认与 ID 相同">
        </label>
        <p v-if="error" class="error-text">{{ error }}</p>
        <button type="submit" :aria-busy="saving" :disabled="saving">创建</button>
      </form>
      <p class="muted">创建后在账号页面点击“仅登录”扫码登录微信读书；阅读、通知等配置默认继承全局设置。</p>
    </article>`,
};
