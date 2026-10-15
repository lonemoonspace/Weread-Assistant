// 调用面板接口。路径相对于当前页面，便于部署在反向代理的子路径下
async function api(path, { method = "GET", body } = {}) {
  const options = { method, headers: {}, credentials: "same-origin" };
  if (method !== "GET") {
    options.headers["Content-Type"] = "application/json";
    options.headers["X-WA-Request"] = "1";
    options.body = JSON.stringify(body || {});
  }
  const res = await fetch(`api/${path}`, options);
  let data = null;
  if (res.status !== 204) {
    data = await res.json().catch(() => null);
  }
  return { status: res.status, data, retryAfter: Number(res.headers.get("Retry-After")) || 0 };
}
