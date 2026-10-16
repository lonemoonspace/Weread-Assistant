import { ref } from "../../vendor/vue.esm-browser.prod.js";
import { api } from "../api.js";

const CHANNEL_LABELS = { bark: "Bark", ntfy: "ntfy", email: "邮件" };

// 发送测试通知：accountId 为空时按全局默认配置发送。修改配置后请先保存再测试
export const TestNotification = {
  props: { accountId: String },
  setup(props) {
    const sending = ref(false);
    const results = ref(null);
    const error = ref("");
    async function send() {
      sending.value = true;
      error.value = "";
      results.value = null;
      try {
        const body = props.accountId ? { accountId: props.accountId } : {};
        results.value = (await api("notifications/test", { method: "POST", body })).results;
      } catch (e) {
        error.value = e.message;
      } finally {
        sending.value = false;
      }
    }
    return { sending, results, error, send, CHANNEL_LABELS };
  },
  template: `
    <div class="test-notification">
      <small class="muted">按已保存的配置向 Bark、ntfy、邮件中已配置的渠道各发送一条。</small>
      <button type="button" class="secondary" :aria-busy="sending" :disabled="sending" @click="send">发送测试通知</button>
      <p v-if="error" class="error-text">{{ error }}</p>
      <p v-else-if="results && !results.length" class="muted">没有配置任何通知渠道。</p>
      <ul v-else-if="results" class="results">
        <li v-for="item in results" :key="item.channel">
          {{ CHANNEL_LABELS[item.channel] || item.channel }}：
          <span :class="item.ok ? 'ok-text' : 'error-text'">{{ item.ok ? "发送成功" : "发送失败，请检查配置与面板日志" }}</span>
        </li>
      </ul>
    </div>`,
};
