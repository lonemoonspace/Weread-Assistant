import { computed, reactive, ref, watch } from "../../vendor/vue.esm-browser.prod.js";
import { ApiError, api } from "../api.js";
import { state } from "../store.js";
import { getPasskey, originMatches, passkeyErrorMessage, passkeySupported } from "../webauthn.js";

// 二次验证：添加、删除 passkey 要求会话在 5 分钟内登录或验证过。接口返回 403 reauth_required 时
// 弹出对话框，用密码或 passkey 验证后重试原请求
const dialogState = reactive({ open: false });
let resolver = null;

// 用户在对话框中取消了验证；调用方忽略它即可
export class ReauthCancelled extends Error {
  constructor() {
    super("已取消验证");
  }
}

function finish(ok) {
  dialogState.open = false;
  const resolve = resolver;
  resolver = null;
  if (resolve) {
    resolve(ok);
  }
}

// 执行 action（调用接口）；需要二次验证时先弹出对话框，验证通过后再执行一次，取消时抛出 ReauthCancelled
export async function withReauth(action) {
  try {
    return await action();
  } catch (error) {
    if (!(error instanceof ApiError) || error.code !== "reauth_required") {
      throw error;
    }
  }
  dialogState.open = true;
  const ok = await new Promise((resolve) => {
    resolver = resolve;
  });
  if (!ok) {
    throw new ReauthCancelled();
  }
  return action();
}

function failureText(error) {
  if (error.code === "wrong_password") {
    return "密码不正确";
  }
  if (error.code === "passkey_failed") {
    return "passkey 校验失败，请重试";
  }
  if (error.code === "too_many_attempts") {
    return "尝试次数过多，请稍后再试";
  }
  return error.message;
}

// passkeys：设置页中的 passkey 列表，有当前域名可用的 passkey 时提供“使用 passkey 验证”
export const ReauthDialog = {
  props: { passkeys: Array },
  setup(props) {
    const dialog = ref(null);
    const password = ref("");
    const error = ref("");
    const busy = ref(false);
    const canUsePasskey = computed(
      () => passkeySupported() && originMatches(state.session.passkey) && (props.passkeys || []).some((item) => item.usable)
    );

    watch(
      () => dialogState.open,
      (open) => {
        if (open) {
          password.value = "";
          error.value = "";
          dialog.value.showModal();
        } else if (dialog.value.open) {
          dialog.value.close();
        }
      }
    );

    async function verify(body) {
      busy.value = true;
      error.value = "";
      try {
        await api("auth/reauth", { method: "POST", body });
        finish(true);
      } catch (e) {
        error.value = failureText(e);
      } finally {
        busy.value = false;
      }
    }

    async function verifyPasskey() {
      busy.value = true;
      error.value = "";
      let response;
      try {
        const options = await api("auth/passkey/options", { method: "POST", body: { purpose: "reauth" } });
        response = await getPasskey(options);
      } catch (e) {
        error.value = e instanceof ApiError ? failureText(e) : passkeyErrorMessage(e);
        busy.value = false;
        return;
      }
      await verify({ passkey: response });
    }

    return {
      dialog,
      password,
      error,
      busy,
      canUsePasskey,
      verifyPassword: () => verify({ password: password.value }),
      verifyPasskey,
      cancel: () => finish(false),
    };
  },
  template: `
    <dialog ref="dialog" class="reauth-dialog" @close="cancel">
      <article>
        <header><strong>确认身份</strong></header>
        <p>添加或删除 passkey 前需要再验证一次身份，验证后 5 分钟内有效。</p>
        <button v-if="canUsePasskey" type="button" :aria-busy="busy" :disabled="busy" @click="verifyPasskey">使用 passkey 验证</button>
        <form @submit.prevent="verifyPassword">
          <label>面板密码<input type="password" v-model="password" autocomplete="current-password" required></label>
          <button type="submit" :class="{ secondary: canUsePasskey }" :disabled="busy">用密码验证</button>
        </form>
        <p v-if="error" class="error-text" role="alert">{{ error }}</p>
        <footer><button type="button" class="secondary outline" @click="cancel">取消</button></footer>
      </article>
    </dialog>`,
};
