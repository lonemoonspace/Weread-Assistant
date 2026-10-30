import { getPasskey, originMatches, passkeyErrorMessage, passkeySupported } from "./app/webauthn.js";

// 登录页：密码登录，以及面板提供 passkey 时的 passkey 登录；密码登录关闭时只显示 passkey。api() 来自 api.js
const form = document.getElementById("login-form");
const message = document.getElementById("message");
const passkeyBox = document.getElementById("passkey-login");
const passkeyButton = document.getElementById("passkey-button");
const passkeyHint = document.getElementById("passkey-hint");
const passwordNote = document.getElementById("password-note");

// 登录失败的提示：被限速时说明等待时间
function showFailure({ status, retryAfter }, wrongText) {
  if (status === 429) {
    message.textContent = `尝试次数过多，请 ${retryAfter} 秒后再试`;
  } else if (status === 403) {
    message.textContent = "密码登录已关闭，请用 passkey 登录";
  } else if (status === 401) {
    message.textContent = retryAfter ? `${wrongText}，请 ${retryAfter} 秒后再试` : wrongText;
  } else {
    message.textContent = "登录失败，请稍后再试";
  }
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  message.textContent = "";
  const button = form.querySelector("button");
  button.disabled = true;
  try {
    const result = await api("auth/login", {
      method: "POST",
      body: { password: form.password.value },
    });
    if (result.status === 204) {
      location.href = "./";
      return;
    }
    showFailure(result, "密码错误");
  } catch (error) {
    message.textContent = "无法连接面板";
  } finally {
    button.disabled = false;
  }
});

async function loginWithPasskey() {
  message.textContent = "";
  passkeyButton.disabled = true;
  try {
    const options = await api("auth/passkey/options", { method: "POST", body: { purpose: "login" } });
    if (options.status !== 200) {
      showFailure(options, "passkey 登录失败");
      return;
    }
    let response;
    try {
      response = await getPasskey(options.data);
    } catch (error) {
      message.textContent = passkeyErrorMessage(error) || "已取消，或这个设备上没有该面板的 passkey";
      return;
    }
    const result = await api("auth/passkey/login", { method: "POST", body: { response } });
    if (result.status === 204) {
      location.href = "./";
      return;
    }
    showFailure(result, "passkey 校验失败");
  } catch (error) {
    message.textContent = "无法连接面板";
  } finally {
    passkeyButton.disabled = false;
  }
}

passkeyButton.addEventListener("click", loginWithPasskey);

const RECOVERY_HINT = "丢失 passkey 时，设置环境变量 PANEL_FORCE_PASSWORD_LOGIN=true 并重启面板，临时用密码登录。";

function showHint(text) {
  passkeyHint.textContent = text;
  passkeyHint.hidden = false;
}

// 面板提供 passkey 时显示按钮；页面不是从面板的外网地址打开时说明去哪里打开。
// 密码登录关闭时隐藏密码表单，passkey 按钮改为主按钮；两种方式都用不了时说明应急恢复的办法
async function setupPasskey() {
  let methods;
  try {
    methods = await api("auth/methods");
  } catch (_) {
    return;
  }
  if (methods.status !== 200) {
    return;
  }
  const { passkey } = methods.data;
  const passwordOff = methods.data.password === false;
  if (passwordOff) {
    form.hidden = true;
    passwordNote.hidden = true;
    passkeyButton.classList.remove("secondary");
  }
  if (!passkey || !passkey.available) {
    if (passwordOff) {
      showHint(`密码登录已关闭。${RECOVERY_HINT}`);
    }
    return;
  }
  if (!originMatches(passkey)) {
    showHint(passwordOff ? `密码登录已关闭，只能在 ${passkey.origin} 上用 passkey 登录。` : `passkey 只能在 ${passkey.origin} 上使用。`);
    return;
  }
  if (passkeySupported()) {
    passkeyBox.hidden = false;
    if (passwordOff) {
      passkeyButton.focus();
    }
  } else if (passwordOff) {
    showHint(`密码登录已关闭，这个浏览器不支持 passkey。${RECOVERY_HINT}`);
  }
}

setupPasskey();
