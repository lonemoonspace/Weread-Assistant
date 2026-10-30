const crypto = require("crypto");
const {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} = require("@simplewebauthn/server");
const { PanelError, badRequest } = require("./errors");

const RP_NAME = "WeReadAssistant";
const MAX_PASSKEYS = 20;
const MAX_NAME_LENGTH = 64;
// 浏览器等待用户操作的时长（跨设备扫码登录需要多一些时间）；challenge 的有效期略长于它
const CEREMONY_TIMEOUT_MS = 2 * 60 * 1000;
const CHALLENGE_TTL_MS = 5 * 60 * 1000;
// 同时有效的 challenge 数量上限，登录用与二次验证、添加用的分开计数，超出时丢弃最早的
const MAX_PENDING_CHALLENGES = 100;
// 登录用的 challenge 未登录也能申请，同一 IP 同时有效的数量另有上限，超出时丢弃它自己最早的
const MAX_PENDING_LOGIN_PER_IP = 5;
// EdDSA、ES256、RS256。固定下来，不随 Node.js 是否支持后量子算法而变化
const SUPPORTED_ALGORITHMS = [-8, -7, -257];

const ownerKey = (token) => crypto.createHash("sha256").update(String(token || "")).digest("hex");

// 控制字符（含换行）、行与段落分隔符、文字方向控制符：名称会写入日志并显示在页面上，这些字符会伪造日志行或打乱显示
const UNSAFE_NAME_CHARS = /[\p{Cc}\u2028\u2029\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;

function normalizeName(rawName, fallback) {
  const name = rawName === undefined || rawName === null ? fallback : String(rawName).trim();
  if (!name) {
    throw badRequest("passkey 名称不能为空");
  }
  if (name.length > MAX_NAME_LENGTH) {
    throw badRequest(`passkey 名称不能超过 ${MAX_NAME_LENGTH} 个字符`);
  }
  if (UNSAFE_NAME_CHARS.test(name)) {
    throw badRequest("passkey 名称不能包含换行、控制字符或文字方向控制符");
  }
  return name;
}

function notFound(id) {
  return new PanelError(404, "passkey_not_found", `passkey 不存在：${id}`);
}

// 面板的 passkey（WebAuthn）。relyingParty 为 { id, origin }（见 options.js 的 passkeyRelyingParty），为 null 时不提供 passkey，
// 已保存的 passkey 仍可查看与删除。passkey 保存在 panel.json 的 auth.passkeys 中，只含公钥。
// challenge 只保存在内存中：5 分钟内有效、只能使用一次，并且只能用于申请时的用途（登录、二次验证或添加）；
// 二次验证与添加还绑定申请时的会话。登录用的单独存放，未登录的请求再多也挤不掉二次验证与添加用的
function createPasskeys({ store, relyingParty, now = Date.now }) {
  const pending = { login: new Map(), session: new Map() };
  const poolFor = (purpose) => (purpose === "login" ? pending.login : pending.session);

  const usable = (passkey) => Boolean(relyingParty) && passkey.rpId === relyingParty.id;

  function requireAvailable() {
    if (!relyingParty) {
      throw new PanelError(409, "passkey_unavailable", "需要把 PANEL_PUBLIC_URL 设置为面板的 HTTPS 地址才能使用 passkey");
    }
  }

  // ip 只用于登录用的 challenge
  function remember(challenge, purpose, owner, ip = "") {
    const t = now();
    const pool = poolFor(purpose);
    const sameIp = [];
    for (const [key, entry] of pool) {
      if (entry.expiresAt <= t) {
        pool.delete(key);
      } else if (ip && entry.ip === ip) {
        sameIp.push(key);
      }
    }
    while (sameIp.length >= MAX_PENDING_LOGIN_PER_IP) {
      pool.delete(sameIp.shift());
    }
    while (pool.size >= MAX_PENDING_CHALLENGES) {
      pool.delete(pool.keys().next().value);
    }
    pool.set(challenge, { purpose, owner: owner ? ownerKey(owner) : "", ip, expiresAt: t + CHALLENGE_TTL_MS });
  }

  // 校验并作废 challenge：无论是否匹配都只能使用一次
  function take(challenge, purpose, owner) {
    const entry = pending.login.get(challenge) || pending.session.get(challenge);
    pending.login.delete(challenge);
    pending.session.delete(challenge);
    return Boolean(entry) && entry.expiresAt > now() && entry.purpose === purpose && entry.owner === (owner ? ownerKey(owner) : "");
  }

  function publicPasskey(passkey) {
    return {
      id: passkey.id,
      name: passkey.name,
      createdAt: passkey.createdAt,
      lastUsedAt: passkey.lastUsedAt || null,
      backedUp: Boolean(passkey.backedUp),
      usable: usable(passkey),
    };
  }

  // 登录与二次验证的参数。二次验证只列出当前会话可用的 passkey；登录不列出，由浏览器让用户选择（不暴露有哪些 passkey）
  async function authenticationOptions(purpose, owner, ip) {
    requireAvailable();
    const options = await generateAuthenticationOptions({
      rpID: relyingParty.id,
      allowCredentials:
        purpose === "reauth"
          ? store.get().auth.passkeys.filter(usable).map((passkey) => ({ id: passkey.id, transports: passkey.transports }))
          : [],
      userVerification: "required",
      timeout: CEREMONY_TIMEOUT_MS,
    });
    remember(options.challenge, purpose, owner, ip);
    return options;
  }

  // 校验登录或二次验证的结果。成功时更新签名计数与最近使用时间并返回该 passkey，失败返回 null 并记录原因
  async function verifyAssertion(response, purpose, owner) {
    if (!relyingParty || !response || typeof response !== "object" || typeof response.id !== "string") {
      return null;
    }
    const passkey = store.get().auth.passkeys.find((item) => item.id === response.id && usable(item));
    if (!passkey) {
      console.warn("passkey 校验失败：没有这个 passkey，或它不是在当前域名下添加的");
      return null;
    }
    let verification;
    try {
      verification = await verifyAuthenticationResponse({
        response,
        expectedChallenge: (challenge) => take(challenge, purpose, owner),
        expectedOrigin: relyingParty.origin,
        expectedRPID: relyingParty.id,
        credential: {
          id: passkey.id,
          publicKey: Buffer.from(passkey.publicKey, "base64url"),
          counter: passkey.counter,
          transports: passkey.transports,
        },
        requireUserVerification: true,
      });
    } catch (e) {
      console.warn(`passkey「${passkey.name}」校验失败：${e.message}`);
      return null;
    }
    if (!verification.verified) {
      console.warn(`passkey「${passkey.name}」校验失败：签名不正确`);
      return null;
    }
    const info = verification.authenticationInfo;
    let updated = null;
    await store.update((data) => {
      // 校验期间可能已被删除
      updated = data.auth.passkeys.find((item) => item.id === passkey.id) || null;
      if (updated) {
        updated.counter = info.newCounter;
        updated.backedUp = info.credentialBackedUp;
        updated.lastUsedAt = new Date(now()).toISOString();
      }
    });
    return updated;
  }

  return {
    available: Boolean(relyingParty),
    relyingParty,

    list() {
      return store.get().auth.passkeys.map(publicPasskey);
    },

    // 当前域名下可用的 passkey 数量
    usableCount() {
      return store.get().auth.passkeys.filter(usable).length;
    },

    // ip：申请者的地址，用于限制同一 IP 同时有效的数量
    loginOptions(ip = "") {
      return authenticationOptions("login", "", ip);
    },

    reauthOptions(token) {
      return authenticationOptions("reauth", token);
    },

    verifyLogin(response) {
      return verifyAssertion(response, "login", "");
    },

    verifyReauth(response, token) {
      return verifyAssertion(response, "reauth", token);
    },

    // 添加 passkey 的参数：要求可发现凭据（登录时不用输入用户名）与用户验证（指纹、面容或 PIN），不要求证明设备型号
    async registrationOptions(token) {
      requireAvailable();
      let data = store.get();
      if (data.auth.passkeys.length >= MAX_PASSKEYS) {
        throw new PanelError(409, "too_many_passkeys", `最多添加 ${MAX_PASSKEYS} 个 passkey`);
      }
      if (!data.auth.webauthnUserId) {
        // 首次添加时生成，之后不变；浏览器据此把同一面板的 passkey 归为同一个用户
        data = await store.update((draft) => {
          draft.auth.webauthnUserId = draft.auth.webauthnUserId || crypto.randomBytes(16).toString("base64url");
        });
      }
      const options = await generateRegistrationOptions({
        rpName: RP_NAME,
        rpID: relyingParty.id,
        userName: RP_NAME,
        userDisplayName: `${RP_NAME} 面板`,
        userID: Buffer.from(data.auth.webauthnUserId, "base64url"),
        attestationType: "none",
        excludeCredentials: data.auth.passkeys.filter(usable).map((passkey) => ({ id: passkey.id, transports: passkey.transports })),
        authenticatorSelection: { residentKey: "required", userVerification: "required" },
        supportedAlgorithmIDs: SUPPORTED_ALGORITHMS,
        timeout: CEREMONY_TIMEOUT_MS,
      });
      remember(options.challenge, "register", token);
      return options;
    },

    // 校验并保存新的 passkey；校验失败时返回 400 passkey_failed
    async register(response, rawName, token) {
      requireAvailable();
      const name = normalizeName(rawName, `passkey ${new Date(now()).toISOString().slice(0, 10)}`);
      let verification;
      try {
        verification = await verifyRegistrationResponse({
          response,
          expectedChallenge: (challenge) => take(challenge, "register", token),
          expectedOrigin: relyingParty.origin,
          expectedRPID: relyingParty.id,
          requireUserVerification: true,
          supportedAlgorithmIDs: SUPPORTED_ALGORITHMS,
        });
      } catch (e) {
        console.warn(`添加 passkey 失败：${e.message}`);
        throw badRequest("passkey 校验失败，请重试", "passkey_failed");
      }
      if (!verification.verified) {
        throw badRequest("passkey 校验失败，请重试", "passkey_failed");
      }
      const info = verification.registrationInfo;
      const passkey = {
        id: info.credential.id,
        publicKey: Buffer.from(info.credential.publicKey).toString("base64url"),
        counter: info.credential.counter,
        transports: info.credential.transports || [],
        backedUp: info.credentialBackedUp,
        rpId: relyingParty.id,
        name,
        createdAt: new Date(now()).toISOString(),
        lastUsedAt: null,
      };
      await store.update((data) => {
        if (data.auth.passkeys.some((item) => item.id === passkey.id)) {
          throw new PanelError(409, "passkey_exists", "这个 passkey 已经添加过了");
        }
        if (data.auth.passkeys.length >= MAX_PASSKEYS) {
          throw new PanelError(409, "too_many_passkeys", `最多添加 ${MAX_PASSKEYS} 个 passkey`);
        }
        data.auth.passkeys.push(passkey);
      });
      return publicPasskey(passkey);
    },

    async rename(id, rawName) {
      const name = normalizeName(rawName, undefined);
      let renamed;
      await store.update((data) => {
        renamed = data.auth.passkeys.find((item) => item.id === id);
        if (!renamed) {
          throw notFound(id);
        }
        renamed.name = name;
      });
      return publicPasskey(renamed);
    },

    // 返回删除的 passkey。密码登录已关闭时不能删除当前域名下最后一个可用的 passkey：
    // 删掉后会自动重新允许密码登录，与关闭它的本意相反，需要先在设置中打开密码登录
    async remove(id) {
      let removed;
      await store.update((data) => {
        removed = data.auth.passkeys.find((item) => item.id === id);
        if (!removed) {
          throw notFound(id);
        }
        if (data.auth.passwordLogin === false && usable(removed) && data.auth.passkeys.filter(usable).length === 1) {
          throw new PanelError(409, "last_passkey", "密码登录已关闭，不能删除最后一个可用的 passkey；先在设置中打开密码登录");
        }
        data.auth.passkeys = data.auth.passkeys.filter((item) => item.id !== id);
      });
      return publicPasskey(removed);
    },
  };
}

module.exports = {
  MAX_PASSKEYS,
  createPasskeys,
};
