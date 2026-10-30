// 面板接口。路径相对于当前页面，部署在反向代理的子路径下时同样可用
export class ApiError extends Error {
  constructor(status, data) {
    super((data && data.message) || (status === 0 ? "无法连接面板" : `请求失败（HTTP ${status}）`));
    this.status = status;
    this.code = data && data.error;
    this.data = data || {};
  }
}

// 会话失效时回到登录页
function toLogin() {
  location.href = "login";
}

async function send(path, { method = "GET", body } = {}) {
  const options = { method, headers: {}, credentials: "same-origin" };
  if (method !== "GET") {
    options.headers["X-WA-Request"] = "1";
    if (body !== undefined) {
      options.headers["Content-Type"] = "application/json";
      options.body = JSON.stringify(body);
    }
  }
  let res;
  try {
    res = await fetch(`api/${path}`, options);
  } catch (_) {
    throw new ApiError(0, null);
  }
  if (res.status === 401) {
    toLogin();
    throw new ApiError(401, null);
  }
  return res;
}

export async function api(path, options) {
  const res = await send(path, options);
  if (res.status === 204) {
    return null;
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw new ApiError(res.status, data);
  }
  return data;
}

export async function apiText(path) {
  const res = await send(path);
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new ApiError(res.status, data);
  }
  return res.text();
}

export function apiUrl(path) {
  return `api/${path}`;
}
