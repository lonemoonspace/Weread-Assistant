// 用 API 令牌认证的接口（api/v1 与 mcp）共用：从 Authorization: Bearer 中取出令牌并校验，
// 同一 IP 15 分钟内失败 20 次后暂停到窗口结束（令牌是 32 字节随机数，猜不中，限速只为挡住刷日志的请求）

const FAILURE_WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES = 20;

function createTokenAuth({ tokens, now = () => Date.now() }) {
  const failures = new Map();

  function blocked(ip) {
    const entry = failures.get(ip);
    if (!entry) {
      return 0;
    }
    if (now() - entry.firstAt >= FAILURE_WINDOW_MS) {
      failures.delete(ip);
      return 0;
    }
    return entry.count >= MAX_FAILURES ? entry.firstAt + FAILURE_WINDOW_MS - now() : 0;
  }

  function fail(ip) {
    const entry = failures.get(ip);
    if (entry && now() - entry.firstAt < FAILURE_WINDOW_MS) {
      entry.count += 1;
    } else {
      failures.set(ip, { count: 1, firstAt: now() });
    }
    // 防止大量不同 IP 撑大内存：只保留最近的 1000 个
    if (failures.size > 1000) {
      failures.delete(failures.keys().next().value);
    }
  }

  // 认证通过时 req.apiToken 为 { id, name, scopes, accounts }；onError(res, status, error, message) 按各自的格式回复
  return function authenticate(req, res, next, onError) {
    const waitMs = blocked(req.ip);
    if (waitMs > 0) {
      res.set("Retry-After", String(Math.ceil(waitMs / 1000)));
      onError(res, 429, "too_many_attempts", "认证失败次数过多，请稍后再试");
      return;
    }
    const match = /^Bearer\s+(\S+)\s*$/i.exec(req.get("Authorization") || "");
    const token = match ? tokens.verify(match[1]) : null;
    if (!token) {
      fail(req.ip);
      res.set("WWW-Authenticate", 'Bearer realm="WeReadAssistant"');
      onError(res, 401, "unauthorized", "需要有效的 API 令牌（Authorization: Bearer wat_…）");
      return;
    }
    req.apiToken = token;
    next();
  };
}

module.exports = { createTokenAuth };
