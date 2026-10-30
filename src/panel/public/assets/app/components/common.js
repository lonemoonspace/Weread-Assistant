import qrcode from "../../vendor/qrcode.mjs";
import { computed, ref } from "../../vendor/vue.esm-browser.prod.js";
import { apiUrl } from "../api.js";
import { ACTIVE_STATUSES, STATUS_LABELS } from "../format.js";
import { startRun, state, stopRun } from "../store.js";

export const StatusBadge = {
  props: { status: String },
  setup(props) {
    return { label: computed(() => STATUS_LABELS[props.status] || props.status || "-") };
  },
  template: `<span class="badge" :class="'status-' + status">{{ label }}</span>`,
};

// 登录二维码：由登录链接在浏览器本地生成，不经过第三方服务。
// 解析不出登录链接时（qrAt 不为空而 url 为空）改为显示阅读浏览器中二维码的截图
export const QrLogin = {
  props: { url: String, accountId: String, qrAt: String },
  setup(props) {
    const showLink = ref(false);
    // 本地生成的二维码；生成失败（链接过长等，qrcode 抛出的是字符串）时为空，改为显示截图
    const generated = computed(() => {
      if (!props.url) {
        return "";
      }
      try {
        const qr = qrcode(0, "M");
        qr.addData(props.url);
        qr.make();
        return qr.createDataURL(6, 2);
      } catch (e) {
        console.warn("生成登录二维码失败:", e);
        return "";
      }
    });
    const shot = computed(() =>
      props.qrAt && props.accountId ? apiUrl(`accounts/${props.accountId}/login-qr?t=${encodeURIComponent(props.qrAt)}`) : ""
    );
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
    return { generated, shot, copy, copied, showLink };
  },
  template: `
    <div class="qr-login">
      <img v-if="generated" class="qr" :src="generated" alt="微信读书登录二维码">
      <a v-else-if="shot" class="qr-shot" :href="shot" target="_blank" rel="noopener" title="查看原图">
        <img :src="shot" alt="阅读浏览器中的微信读书登录二维码截图">
      </a>
      <p v-else class="muted" aria-busy="true">正在获取二维码…</p>
      <div class="qr-help">
        <p v-if="generated">用微信扫描二维码登录；在手机上可以复制链接，发到微信中打开。二维码约 1 分钟后失效，会自动刷新。</p>
        <p v-else-if="shot">未能从二维码中解析出登录链接，这是阅读浏览器中二维码的截图，用微信扫描即可；截图看不清时点击查看原图。二维码约 1 分钟后失效，会自动刷新。</p>
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
    const busy = computed(() => Boolean(state.pending[props.account.id]));
    return {
      run,
      active,
      busy,
      start: (mode) => startRun(props.account.id, mode),
      stop: () => stopRun(props.account.id),
    };
  },
  template: `
    <div class="run-buttons">
      <template v-if="run">
        <button type="button" class="secondary" :disabled="run.stopRequested || busy" @click="stop">
          {{ run.stopRequested ? "正在停止…" : run.status === "queued" ? "取消排队" : "停止" }}
        </button>
      </template>
      <template v-else>
        <button type="button" :disabled="!account.enabled || busy" @click="start('read')">立即运行</button>
        <button type="button" class="secondary" :disabled="!account.enabled || busy" @click="start('login')">仅登录</button>
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
