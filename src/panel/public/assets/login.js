const form = document.getElementById("login-form");
const message = document.getElementById("message");

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  message.textContent = "";
  const button = form.querySelector("button");
  button.disabled = true;
  try {
    const { status, retryAfter } = await api("auth/login", {
      method: "POST",
      body: { password: form.password.value },
    });
    if (status === 204) {
      location.href = "./";
      return;
    }
    if (status === 429) {
      message.textContent = `尝试次数过多，请 ${retryAfter} 秒后再试`;
    } else if (status === 401) {
      message.textContent = retryAfter ? `密码错误，请 ${retryAfter} 秒后再试` : "密码错误";
    } else {
      message.textContent = "登录失败，请稍后再试";
    }
  } catch (error) {
    message.textContent = "无法连接面板";
  } finally {
    button.disabled = false;
  }
});
