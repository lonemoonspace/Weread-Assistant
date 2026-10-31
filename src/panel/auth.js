const crypto = require("crypto");
const { promisify } = require("util");

const scrypt = promisify(crypto.scrypt);

const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1 };
const KEY_LENGTH = 64;
const SCRYPT_MAXMEM = 64 * 1024 * 1024;
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
// 会话从登录起最长有效期：滑动续期不超过这个时长，被窃取的令牌不会因为一直被使用而永久有效
const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
// 会话按访问滑动延期；cookie 最多每小时重新下发一次
const COOKIE_REFRESH_MS = 60 * 60 * 1000;
const MAX_TRUSTED_IPS = 100;
// 添加、删除 passkey 等敏感操作要求会话在这段时间内登录或二次验证过，被盗用的会话不能给自己添加 passkey
const REAUTH_WINDOW_MS = 5 * 60 * 1000;
const MIN_PASSWORD_LENGTH = 8;
const GENERATED_PASSWORD_LENGTH = 16;
// 去掉易混淆的 0/O、1/l/I
const PASSWORD_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";

// 同一 IP 连续失败 maxFailures 次后锁定，锁定时长从 lockoutBaseMs 开始翻倍，最长 lockoutMaxMs；
// 所有 IP 在 globalWindowMs 内累计失败 globalMaxFailures 次后暂停其他 IP 的登录，
// 防止反向代理配置不当时攻击者伪造 X-Forwarded-For 绕过按 IP 限速。
// 最近 SESSION_MAX_AGE_MS 内登录（密码或 passkey）或二次验证成功过的 IP 不受全局暂停影响（仍按 IP 限速），
// 未认证的请求不能借全局暂停把管理员挡在面板外；暂停只在内存中，重启面板即解除。reauthWindowMs 为二次验证的有效期
const DEFAULT_LIMITS = {
  maxFailures: 5,
  lockoutBaseMs: 30 * 1000,
  lockoutMaxMs: 15 * 60 * 1000,
  globalMaxFailures: 100,
  globalWindowMs: 15 * 60 * 1000,
  reauthWindowMs: REAUTH_WINDOW_MS,
};

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, KEY_LENGTH, SCRYPT_PARAMS);
  const { N, r, p } = SCRYPT_PARAMS;
  return ["scrypt", N, r, p, salt.toString("base64"), key.toString("base64")].join("$");
}

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const isPositiveInteger = (text) => /^[1-9][0-9]{0,9}$/.test(text);

// 解析 hashPassword 生成的哈希；格式或参数不对时返回 null。key 长度必须为 KEY_LENGTH：
// 空的 key 会让 scrypt 返回空 Buffer，与任何密码比较都相等
function parsePasswordHash(storedHash) {
  const parts = String(storedHash || "").split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") {
    return null;
  }
  const [, N, r, p, saltB64, keyB64] = parts;
  if (![N, r, p].every(isPositiveInteger) || !BASE64.test(saltB64) || !BASE64.test(keyB64)) {
    return null;
  }
  const params = { N: Number(N), r: Number(r), p: Number(p) };
  const salt = Buffer.from(saltB64, "base64");
  const key = Buffer.from(keyB64, "base64");
  // N 必须是大于 1 的 2 的幂；内存占用（OpenSSL 按 128 * r * (N + p + 2) 计算）超过 SCRYPT_MAXMEM 时
  // scrypt 会抛出错误，这里一并视为无效，避免面板能启动却任何密码都校验不过
  const { N: n, r: blockSize, p: parallel } = params;
  if (n < 2 || (n & (n - 1)) !== 0 || parallel > 16 || 128 * blockSize * (n + parallel + 2) > SCRYPT_MAXMEM) {
    return null;
  }
  if (salt.length < 8 || key.length !== KEY_LENGTH) {
    return null;
  }
  return { params, salt, key };
}

// 哈希无效（panel.json 被手工改坏）时一律不通过，不会因为异常放行或返回 500
async function verifyPassword(password, storedHash) {
  const parsed = parsePasswordHash(storedHash);
  if (!parsed) {
    return false;
  }
  try {
    const key = await scrypt(String(password), parsed.salt, KEY_LENGTH, { ...parsed.params, maxmem: SCRYPT_MAXMEM });
    return crypto.timingSafeEqual(key, parsed.key);
  } catch (_) {
    return false;
  }
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
  // IP → 最近一次登录成功的时间，这些 IP 不受全局暂停影响
  const trustedIps = new Map();
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

  // method 为登录方式（password 或 passkey），passkey 登录时 credentialId 为所用 passkey 的 ID；
  // verifiedAt 为最近一次登录或二次验证的时间，verifiedBy 为那一次所用的方式
  function createSession(method = "password", credentialId = "") {
    const token = crypto.randomBytes(32).toString("base64url");
    const t = now();
    // 顺便回收已过期的会话：过期的会话只有再次被使用时才会被发现
    for (const [key, session] of sessions) {
      if (session.expiresAt <= t) {
        endSession(key);
      }
    }
    sessions.set(hashToken(token), {
      expiresAt: t + SESSION_TTL_MS,
      cookieSetAt: t,
      createdAt: t,
      method,
      credentialId,
      verifiedAt: t,
      verifiedBy: method,
    });
    return token;
  }

  function isTrusted(ip, t) {
    const at = trustedIps.get(ip);
    return at !== undefined && at > t - SESSION_MAX_AGE_MS;
  }

  function trustIp(ip) {
    trustedIps.delete(ip);
    trustedIps.set(ip, now());
    // 只保留最近登录成功的若干个 IP
    while (trustedIps.size > MAX_TRUSTED_IPS) {
      trustedIps.delete(trustedIps.keys().next().value);
    }
  }

  // 有效的会话；无效或已过期时返回 null（不延长有效期）
  function activeSession(token) {
    const session = token ? sessions.get(hashToken(token)) : null;
    return session && session.expiresAt > now() ? session : null;
  }

  // verify() 校验凭据（密码或 passkey），成功时返回真值。被限速时不调用；失败计入限速。
  // 成功后该 IP 不再受全局暂停影响（登录与二次验证都经过这里）。
  // global 为 false 时只按 IP 限速、不受全局暂停影响：全局暂停是为分散在多个 IP 上的密码猜测设的，
  // passkey 无法被猜中，二次验证需要已登录的会话，暂停它们只会把管理员挡在外面
  async function attempt(ip, verify, { global = true } = {}) {
    const wait = retryAfterMs(ip, { global });
    if (wait > 0) {
      return { ok: false, locked: true, retryAfterMs: wait };
    }
    const result = await verify();
    if (result) {
      attempts.delete(ip);
      trustIp(ip);
      return { ok: true, result };
    }
    recordFailure(ip, { global });
    return { ok: false, retryAfterMs: retryAfterMs(ip, { global }) };
  }

  const checkPassword = (password) => typeof password === "string" && password.length > 0 && verifyPassword(password, currentHash());

  function retryAfterMs(ip, { global = true } = {}) {
    const t = now();
    const record = attempts.get(ip);
    const ipWait = record && record.lockedUntil > t ? record.lockedUntil - t : 0;
    const globalWait = global && globalLockedUntil > t && !isTrusted(ip, t) ? globalLockedUntil - t : 0;
    return Math.max(ipWait, globalWait);
  }

  // global 为 false 时只计入按 IP 的失败（passkey、二次验证），不计入全局上限：它们不受全局暂停影响，
  // 也不能用来触发全局暂停（passkey 失败不需要 scrypt，比猜密码便宜）
  function recordFailure(ip, { global = true } = {}) {
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
    if (global) {
      globalFailures.push(t);
    }
    if (global && globalFailures.length >= cfg.globalMaxFailures) {
      globalLockedUntil = t + cfg.globalWindowMs;
      globalFailures = [];
      console.warn(
        `面板登录：短时间内失败次数过多，暂停 ${Math.ceil(cfg.globalWindowMs / 60000)} 分钟内未登录过的 IP 登录（重启面板可立即解除）`
      );
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

  // 结束符合条件的会话，keepToken 对应的会话除外。返回结束的数量
  function endSessions(predicate, keepToken = "") {
    const keep = keepToken ? hashToken(keepToken) : "";
    let count = 0;
    for (const [key, session] of [...sessions]) {
      if (key !== keep && predicate(session)) {
        endSession(key);
        count += 1;
      }
    }
    return count;
  }

  async function reauth(ip, token, method, verify) {
    if (!activeSession(token)) {
      return { ok: false, retryAfterMs: 0 };
    }
    const outcome = await attempt(ip, verify, { global: false });
    if (!outcome.ok) {
      return outcome;
    }
    // 校验期间会话可能已经结束（退出登录、修改密码）
    const session = activeSession(token);
    if (!session) {
      return { ok: false, retryAfterMs: 0 };
    }
    session.verifiedAt = now();
    session.verifiedBy = method;
    return { ok: true };
  }

  return {
    passwordFromEnv: Boolean(envPassword),

    // 准备好面板密码。没有任何密码时生成一个并返回明文（只此一次），否则返回空字符串
    async init() {
      if (envPassword) {
        // 与在面板中修改密码的要求一致
        if (envPassword.length < MIN_PASSWORD_LENGTH) {
          throw new Error(
            `PANEL_PASSWORD 至少 ${MIN_PASSWORD_LENGTH} 位：把它改成 ${MIN_PASSWORD_LENGTH} 位以上后重新启动即可，账号与设置不受影响`
          );
        }
        envPasswordHash = await hashPassword(envPassword);
        return "";
      }
      const storedHash = store.get().auth.passwordHash;
      if (storedHash) {
        if (!parsePasswordHash(storedHash)) {
          throw new Error(
            "panel.json 中的面板密码哈希（auth.passwordHash）无效，可能被手工改坏：设置 PANEL_PASSWORD 后重新启动，" +
              "或删除 panel.json 中的 passwordHash 后重新启动（会生成新的初始密码），账号与设置不受影响"
          );
        }
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
      const outcome = await attempt(ip, () => checkPassword(password));
      return outcome.ok ? { ok: true, token: createSession("password") } : outcome;
    },

    // passkey 登录。verify() 校验成功时返回所用的 passkey，失败返回 null；失败与密码错误一样计入限速。
    // 返回 { ok: true, token, passkey } 或与 login 相同的失败结果
    async loginWithPasskey(ip, verify) {
      const outcome = await attempt(ip, verify, { global: false });
      return outcome.ok ? { ok: true, token: createSession("passkey", outcome.result.id), passkey: outcome.result } : outcome;
    },

    // 距离解除限速的毫秒数，0 表示没有被限速；未登录申请 passkey 登录参数时检查（与 passkey 登录一样不受全局暂停影响）
    passkeyRetryAfterMs(ip) {
      return retryAfterMs(ip, { global: false });
    },

    // 二次验证：用密码或 passkey 再次确认身份，成功后会话在二次验证的有效期内（默认 5 分钟）可以进行敏感操作。
    // 失败与登录失败一样计入限速。返回 { ok: true } 或与 login 相同的失败结果
    async reauthWithPassword(ip, token, password) {
      return reauth(ip, token, "password", () => checkPassword(password));
    },

    async reauthWithPasskey(ip, token, verify) {
      return reauth(ip, token, "passkey", verify);
    },

    // 会话在二次验证的有效期内登录或二次验证过；指定 method 时还要求那一次用的是这种方式
    // （关闭密码登录要求用 passkey 验证过，确认它在当前域名下能用）
    isRecentlyVerified(token, method = "") {
      const session = activeSession(token);
      return Boolean(session && now() - session.verifiedAt < cfg.reauthWindowMs && (!method || session.verifiedBy === method));
    },

    // 当前会话的登录方式、二次验证的有效期（ISO 时间，已过期时为 null）与验证所用的方式
    sessionInfo(token) {
      const session = activeSession(token);
      if (!session) {
        return null;
      }
      const verifiedUntil = session.verifiedAt + cfg.reauthWindowMs;
      const verified = verifiedUntil > now();
      return {
        method: session.method,
        verifiedUntil: verified ? new Date(verifiedUntil).toISOString() : null,
        verifiedBy: verified ? session.verifiedBy : null,
      };
    },

    // 结束用某个 passkey 登录的会话（删除 passkey 后），keepToken 对应的会话除外。返回结束的数量
    endPasskeySessions(credentialId, keepToken = "") {
      return endSessions((session) => session.method === "passkey" && session.credentialId === credentialId, keepToken);
    },

    // 结束用密码登录的会话（关闭密码登录后），keepToken 对应的会话除外。返回结束的数量
    endPasswordSessions(keepToken = "") {
      return endSessions((session) => session.method === "password", keepToken);
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
      session.expiresAt = Math.min(t + SESSION_TTL_MS, session.createdAt + SESSION_MAX_AGE_MS);
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

    // 返回 { ok: true, token } 或 { ok: false, error: "password_from_env" | "wrong_password" | "password_too_short" }，
    // 当前密码错误次数过多时为 { ok: false, error: "too_many_attempts", retryAfterMs }：与登录共用按 IP 的失败计数与锁定，
    // 持有会话也不能借这里无限尝试当前密码。
    // 修改成功后所有会话失效，并为调用者创建新会话。多个请求依次处理，后到的请求按新密码校验
    changePassword(ip, currentPassword, nextPassword) {
      const run = passwordChange.then(() => applyPasswordChange(ip, currentPassword, nextPassword));
      passwordChange = run.catch(() => {});
      return run;
    },
  };

  async function applyPasswordChange(ip, currentPassword, nextPassword) {
    if (envPassword) {
      return { ok: false, error: "password_from_env" };
    }
    const wait = retryAfterMs(ip);
    if (wait > 0) {
      return { ok: false, error: "too_many_attempts", retryAfterMs: wait };
    }
    if (!(await verifyPassword(String(currentPassword || ""), currentHash()))) {
      recordFailure(ip);
      return { ok: false, error: "wrong_password" };
    }
    attempts.delete(ip);
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
    return { ok: true, token: createSession("password") };
  }
}

module.exports = {
  MIN_PASSWORD_LENGTH,
  SESSION_MAX_AGE_MS,
  SESSION_TTL_MS,
  createAuth,
  hashPassword,
  verifyPassword,
};
