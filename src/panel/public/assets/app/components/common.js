import qrcode from "../../vendor/qrcode.mjs";
import { computed, ref } from "../../vendor/vue.esm-browser.prod.js";
import { ACTIVE_STATUSES, STATUS_LABELS } from "../format.js";
import { startRun, state, stopRun } from "../store.js";

export const StatusBadge = {
  props: { status: String },
  setup(props) {
    return { label: computed(() => STATUS_LABELS[props.status] || props.status || "-") };
  },
  template: `<span class="badge" :class="'status-' + status">{{ label }}</span>`,
};

// 登录二维码：由登录链接在浏览器本地生成，不经过第三方服务
export const QrLogin = {
  props: { url: String },
  setup(props) {
    const showLink = ref(false);
    const image = computed(() => {
      if (!props.url) {
        return "";
      }
      const qr = qrcode(0, "M");
      qr.addData(props.url);
      qr.make();
      return qr.createDataURL(6, 2);
    });
    async function copy() {
      try {
        await navigator.clipboard.writeText(props.url);
        showLink.value = false;
        alertCopied();
      } catch (_) {
        // 非 HTTPS 访问时浏览器不允许写入剪贴板，改为显示链接供手动复制
        showLink.value = true;
      }
    }
    const copied = ref(false);
    function alertCopied() {
      copied.value = true;
      setTimeout(() => {
        copied.value = false;
      }, 2000);
    }
    return { image, copy, copied, showLink };
  },
  template: `
    <div class="qr-login">
      <img v-if="image" class="qr" :src="image" alt="微信读书登录二维码">
      <p v-else class="muted" aria-busy="true">正在获取二维码…</p>
      <div class="qr-help">
        <p>用微信扫描二维码登录；在手机上可以复制链接，发到微信中打开。二维码约 1 分钟后失效，会自动刷新。</p>
        <button v-if="url" type="button" class="secondary" @click="copy">{{ copied ? "已复制" : "复制登录链接" }}</button>
        <input v-if="showLink" class="login-link" type="text" readonly :value="url" @focus="$event.target.select()">
      </div>
    </div>`,
};

// 立即运行 / 仅登录 / 停止
export const RunButtons = {
  props: { account: Object },
  setup(props) {
    const run = computed(() => state.runs[props.account.id]);
    const active = computed(() => run.value && ACTIVE_STATUSES.includes(run.value.status));
    return {
      run,
      active,
      start: (mode) => startRun(props.account.id, mode),
      stop: () => stopRun(props.account.id),
    };
  },
  template: `
    <div class="run-buttons">
      <template v-if="run">
        <button type="button" class="secondary" :disabled="run.stopRequested" @click="stop">
          {{ run.stopRequested ? "正在停止…" : run.status === "queued" ? "取消排队" : "停止" }}
        </button>
      </template>
      <template v-else>
        <button type="button" :disabled="!account.enabled" @click="start('read')">立即运行</button>
        <button type="button" class="secondary" :disabled="!account.enabled" @click="start('login')">仅登录</button>
      </template>
    </div>`,
};

export const NoticeBar = {
  setup() {
    return { state };
  },
  template: `
    <div v-if="state.notice" class="notice" :class="'notice-' + state.notice.type" role="status">{{ state.notice.text }}</div>`,
};
