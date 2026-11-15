const { HSTS_HEADER, SESSION_COOKIE, cookieValues } = require("./security");

// 识别会话（有多个同名 cookie 时取第一个有效的）；有效时按需续期 cookie。经 HTTPS 访问时同时下发 HSTS
function identifySession({ auth, cookies }) {
  return (req, res, next) => {
    if (cookies.isHttps(req)) {
      res.set("Strict-Transport-Security", HSTS_HEADER);
    }
    req.sessionToken = "";
    for (const token of cookieValues(req.headers.cookie, SESSION_COOKIE)) {
      const session = auth.touchSession(token);
      if (session) {
        req.sessionToken = token;
        if (session.refreshCookie) {
          cookies.setSessionCookie(req, res, token);
        }
        break;
      }
    }
    next();
  };
}

// 之后的接口都需要已登录
function requireSession(req, res, next) {
  if (!req.sessionToken) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  next();
}

// 登录或二次验证失败：被限速时 429，否则按 status 返回 error。这次失败触发了锁定时同样带上 retryAfter（秒），页面可以直接提示等待
function sendAuthFailure(res, result, status, error) {
  const retryAfter = Math.ceil(result.retryAfterMs / 1000);
  if (retryAfter > 0) {
    res.set("Retry-After", String(retryAfter));
  }
  if (result.locked) {
    res.status(429).json({ error: "too_many_attempts", retryAfter });
    return;
  }
  res.status(status).json(retryAfter > 0 ? { error, retryAfter } : { error });
}

// 敏感操作要求会话在 5 分钟内登录或二次验证过，否则 403 reauth_required，页面据此弹出验证对话框后重试；
// method 为 passkey 时还要求那一次用的是 passkey（响应中带 method，对话框只提供 passkey 验证）
function reauthRequired(res, method) {
  res.status(403).json({ error: "reauth_required", ...(method ? { method } : {}), message: "需要再验证一次身份" });
}

function requireRecentAuth(auth) {
  return (req, res, next) => {
    if (!auth.isRecentlyVerified(req.sessionToken)) {
      reauthRequired(res);
      return;
    }
    next();
  };
}

// 密码登录的状态。enabled：设置中是否打开；active：实际是否允许。设置中关闭后，以下情况仍然允许，避免把自己锁在外面：
// 设置了 PANEL_FORCE_PASSWORD_LOGIN（forced），或当前域名下没有可用的 passkey（换了域名、去掉了 PANEL_PUBLIC_URL）。
// reason 为设置中关闭、实际仍允许的原因（forced / no_usable_passkey），其他情况为 null
function passwordLoginState(store, passkeys, forced = false) {
  const enabled = store.get().auth.passwordLogin !== false;
  const noPasskey = passkeys.usableCount() === 0;
  const active = enabled || Boolean(forced) || noPasskey;
  let reason = null;
  if (!enabled && active) {
    reason = forced ? "forced" : "no_usable_passkey";
  }
  return { enabled, active, forced: Boolean(forced), reason };
}

module.exports = {
  identifySession,
  passwordLoginState,
  reauthRequired,
  requireRecentAuth,
  requireSession,
  sendAuthFailure,
};
