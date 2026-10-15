async function loadSession() {
  const { status, data } = await api("auth/session");
  if (status === 401) {
    location.href = "login";
    return;
  }
  document.getElementById("version").textContent = data.version;
  document.getElementById("password-from-env").hidden = !data.passwordFromEnv;
  const form = document.getElementById("password-form");
  form.hidden = data.passwordFromEnv;
  form.dataset.minLength = data.minPasswordLength;
}

document.getElementById("logout").addEventListener("click", async () => {
  await api("auth/logout", { method: "POST" });
  location.href = "login";
});

document.getElementById("password-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.target;
  const message = document.getElementById("password-message");
  const { status, data } = await api("auth/password", {
    method: "POST",
    body: { current: form.current.value, next: form.next.value },
  });
  const messages = {
    204: "密码已修改，其他设备需要重新登录",
    401: "登录已过期，请重新登录",
  };
  const errors = {
    wrong_password: "当前密码错误",
    password_too_short: `新密码至少 ${form.dataset.minLength} 位`,
    password_from_env: "密码由环境变量设置，无法在这里修改",
  };
  message.textContent = messages[status] || errors[data && data.error] || "修改失败";
  if (status === 204) {
    form.reset();
  }
});

loadSession();
