import { ref } from "../../vendor/vue.esm-browser.prod.js";
import { api } from "../api.js";

const CHANNEL_LABELS = { bark: "Bark", ntfy: "ntfy", webhook: "Webhook", telegram: "Telegram", email: "邮件" };

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
    // 每个渠道的结果：成功、在配置中关闭，或失败与原因
    function describe(item) {
      if (item.ok) {
        return "发送成功";
      }
      if (item.disabled) {
        return "已关闭，未发送";
      }
      return `发送失败：${item.error || "请检查配置与面板日志"}`;
    }
    function resultClass(item) {
      if (item.ok) {
        return "ok-text";
      }
      return item.disabled ? "muted" : "error-text";
    }
    return { sending, results, error, send, describe, resultClass, CHANNEL_LABELS };
  },
  template: `
    <div class="test-notification">
      <small class="muted">按已保存的配置向 Bark、ntfy、Webhook、Telegram、邮件中已配置的渠道各发送一条。</small>
      <button type="button" class="secondary" :aria-busy="sending" :disabled="sending" @click="send">发送测试通知</button>
      <p v-if="error" class="error-text">{{ error }}</p>
      <p v-else-if="results && !results.length" class="muted">没有配置任何通知渠道。</p>
      <ul v-else-if="results" class="results">
        <li v-for="item in results" :key="item.channel">
          {{ CHANNEL_LABELS[item.channel] || item.channel }}：
          <span :class="resultClass(item)">{{ describe(item) }}</span>
        </li>
      </ul>
    </div>`,
};
