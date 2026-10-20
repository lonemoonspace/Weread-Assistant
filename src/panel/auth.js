const crypto = require("crypto");
const { promisify } = require("util");

const scrypt = promisify(crypto.scrypt);

const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1 };
const KEY_LENGTH = 64;
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
// 会话按访问滑动延期；cookie 最多每小时重新下发一次
const COOKIE_REFRESH_MS = 60 * 60 * 1000;
const MIN_PASSWORD_LENGTH = 8;
const GENERATED_PASSWORD_LENGTH = 16;
// 去掉易混淆的 0/O、1/l/I
const PASSWORD_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";

// 同一 IP 连续失败 maxFailures 次后锁定，锁定时长从 lockoutBaseMs 开始翻倍，最长 lockoutMaxMs；
// 所有 IP 在 globalWindowMs 内累计失败 globalMaxFailures 次后暂停全部登录，
// 防止反向代理配置不当时攻击者伪造 X-Forwarded-For 绕过按 IP 限速
const DEFAULT_LIMITS = {
  maxFailures: 5,
  lockoutBaseMs: 30 * 1000,
  lockoutMaxMs: 15 * 60 * 1000,
  globalMaxFailures: 100,
  globalWindowMs: 15 * 60 * 1000,
};

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, KEY_LENGTH, SCRYPT_PARAMS);
  const { N, r, p } = SCRYPT_PARAMS;
  return ["scrypt", N, r, p, salt.toString("base64"), key.toString("base64")].join("$");
}

async function verifyPassword(password, storedHash) {
  const parts = String(storedHash || "").split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") {
    return false;
  }
  const [, N, r, p, saltB64, keyB64] = parts;
  const expected = Buffer.from(keyB64, "base64");
  const key = await scrypt(String(password), Buffer.from(saltB64, "base64"), expected.length, {
    N: Number(N),
    r: Number(r),
    p: Number(p),
  });
  return crypto.timingSafeEqual(key, expected);
}

function generatePassword(length = GENERATED_PASSWORD_LENGTH) {
  let password = "";
  for (let i = 0; i < length; i += 1) {
    password += PASSWORD_ALPHABET[crypto.randomInt(PASSWORD_ALPHABET.length)];
  }
  return password;
}

// 会话只在内存中保存令牌的哈希，面板重启后需要重新登录
function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function createAuth({ store, envPassword = "", limits = {}, now = Date.now }) {
  const cfg = { ...DEFAULT_LIMITS, ...limits };
  const sessions = new Map();
  // 令牌哈希 → 会话结束时的回调；供实时推送在退出登录、修改密码时立即断开
  const sessionWatchers = new Map();
  const attempts = new Map();
  let globalFailures = [];
  let globalLockedUntil = 0;
  let envPasswordHash = "";
  // 修改密码串行执行：并发请求都通过旧密码校验时，后完成的会清空先完成者刚创建的会话
  let passwordChange = Promise.resolve();

  function currentHash() {
    return envPasswordHash || store.get().auth.passwordHash;
  }

  function endSession(key) {
    sessions.delete(key);
    const watchers = sessionWatchers.get(key);
    if (!watchers) {
      return;
    }
    sessionWatchers.delete(key);
    for (const callback of watchers) {
      try {
        callback();
      } catch (e) {
        console.error("处理会话结束失败:", e);
      }
    }
  }

  function createSession() {
    const token = crypto.randomBytes(32).toString("base64url");
    const t = now();
    // 顺便回收已过期的会话：过期的会话只有再次被使用时才会被发现
    for (const [key, session] of sessions) {
      if (session.expiresAt <= t) {
        endSession(key);
      }
    }
    sessions.set(hashToken(token), { expiresAt: t + SESSION_TTL_MS, cookieSetAt: t });
    return token;
  }

  function retryAfterMs(ip) {
    const t = now();
    const record = attempts.get(ip);
    const ipWait = record && record.lockedUntil > t ? record.lockedUntil - t : 0;
    const globalWait = globalLockedUntil > t ? globalLockedUntil - t : 0;
    return Math.max(ipWait, globalWait);
  }

  function recordFailure(ip) {
    const t = now();
    const record = attempts.get(ip) || { failures: 0, lockedUntil: 0, lastFailureAt: 0 };
    record.failures += 1;
    record.lastFailureAt = t;
    if (record.failures >= cfg.maxFailures) {
      const lockMs = Math.min(cfg.lockoutMaxMs, cfg.lockoutBaseMs * 2 ** (record.failures - cfg.maxFailures));
      record.lockedUntil = t + lockMs;
      console.warn(`面板登录：${ip} 连续失败 ${record.failures} 次，锁定 ${Math.ceil(lockMs / 1000)} 秒`);
    }
    attempts.set(ip, record);

    globalFailures = globalFailures.filter((at) => at > t - cfg.globalWindowMs);
    globalFailures.push(t);
    if (globalFailures.length >= cfg.globalMaxFailures) {
      globalLockedUntil = t + cfg.globalWindowMs;
      globalFailures = [];
      console.warn(`面板登录：短时间内失败次数过多，暂停所有登录 ${Math.ceil(cfg.globalWindowMs / 60000)} 分钟`);
    }

    // 清理早已解锁且一小时内没有再失败的记录
    if (attempts.size > 1000) {
      for (const [key, value] of attempts) {
        if (value.lockedUntil < t && value.lastFailureAt < t - 60 * 60 * 1000) {
          attempts.delete(key);
        }
      }
    }
  }

  return {
    passwordFromEnv: Boolean(envPassword),

    // 准备好面板密码。没有任何密码时生成一个并返回明文（只此一次），否则返回空字符串
    async init() {
      if (envPassword) {
        // 与在面板中修改密码的要求一致
        if (envPassword.length < MIN_PASSWORD_LENGTH) {
          throw new Error(`PANEL_PASSWORD 至少 ${MIN_PASSWORD_LENGTH} 位`);
        }
        envPasswordHash = await hashPassword(envPassword);
        return "";
      }
      if (store.get().auth.passwordHash) {
        return "";
      }
      const generated = generatePassword();
      const passwordHash = await hashPassword(generated);
      await store.update((data) => {
        data.auth.passwordHash = passwordHash;
      });
      return generated;
    },

    // 返回 { ok: true, token } / { ok: false, locked: true, retryAfterMs } / { ok: false, retryAfterMs }
    async login(ip, password) {
      const wait = retryAfterMs(ip);
      if (wait > 0) {
        return { ok: false, locked: true, retryAfterMs: wait };
      }
      const valid = typeof password === "string" && password.length > 0 && (await verifyPassword(password, currentHash()));
      if (valid) {
        attempts.delete(ip);
        return { ok: true, token: createSession() };
      }
      recordFailure(ip);
      return { ok: false, retryAfterMs: retryAfterMs(ip) };
    },

    // 校验并延长会话。返回 null 表示无效；refreshCookie 表示需要重新下发 cookie
    touchSession(token) {
      if (!token) {
        return null;
      }
      const key = hashToken(token);
      const session = sessions.get(key);
      const t = now();
      if (!session || session.expiresAt <= t) {
        endSession(key);
        return null;
      }
      session.expiresAt = t + SESSION_TTL_MS;
      const refreshCookie = t - session.cookieSetAt >= COOKIE_REFRESH_MS;
      if (refreshCookie) {
        session.cookieSetAt = t;
      }
      return { refreshCookie };
    },

    // 只检查会话是否仍然有效，不延长有效期；供实时推送等长连接定期检查
    isSessionValid(token) {
      if (!token) {
        return false;
      }
      const session = sessions.get(hashToken(token));
      return Boolean(session && session.expiresAt > now());
    },

    // 会话结束（退出登录、修改密码、过期被发现）时调用 callback；返回取消监听的函数。
    // 会话已经无效时立即调用
    watchSession(token, callback) {
      const key = hashToken(token || "");
      if (!sessions.has(key)) {
        callback();
        return () => {};
      }
      let watchers = sessionWatchers.get(key);
      if (!watchers) {
        watchers = new Set();
        sessionWatchers.set(key, watchers);
      }
      watchers.add(callback);
      return () => {
        watchers.delete(callback);
        if (watchers.size === 0 && sessionWatchers.get(key) === watchers) {
          sessionWatchers.delete(key);
        }
      };
    },

    destroySession(token) {
      if (token) {
        endSession(hashToken(token));
      }
    },

    // 返回 { ok: true, token } 或 { ok: false, error: "password_from_env" | "wrong_password" | "password_too_short" }。
    // 修改成功后所有会话失效，并为调用者创建新会话。多个请求依次处理，后到的请求按新密码校验
    changePassword(currentPassword, nextPassword) {
      const run = passwordChange.then(() => applyPasswordChange(currentPassword, nextPassword));
      passwordChange = run.catch(() => {});
      return run;
    },
  };

  async function applyPasswordChange(currentPassword, nextPassword) {
    if (envPassword) {
      return { ok: false, error: "password_from_env" };
    }
    if (!(await verifyPassword(String(currentPassword || ""), currentHash()))) {
      return { ok: false, error: "wrong_password" };
    }
    if (typeof nextPassword !== "string" || nextPassword.length < MIN_PASSWORD_LENGTH) {
      return { ok: false, error: "password_too_short" };
    }
    const passwordHash = await hashPassword(nextPassword);
    await store.update((data) => {
      data.auth.passwordHash = passwordHash;
    });
    for (const key of [...sessions.keys()]) {
      endSession(key);
    }
    return { ok: true, token: createSession() };
  }
}

module.exports = {
  MIN_PASSWORD_LENGTH,
  SESSION_TTL_MS,
  createAuth,
  hashPassword,
  verifyPassword,
};
