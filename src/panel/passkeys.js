const crypto = require("crypto");
const {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} = require("@simplewebauthn/server");
const { PanelError, badRequest, rejectUnsafeName } = require("./errors");

const RP_NAME = "WeReadAssistant";
const MAX_PASSKEYS = 20;
const MAX_NAME_LENGTH = 64;
// 浏览器等待用户操作的时长（跨设备扫码登录需要多一些时间）；challenge 的有效期略长于它
const CEREMONY_TIMEOUT_MS = 2 * 60 * 1000;
const CHALLENGE_TTL_MS = 5 * 60 * 1000;
// 二次验证、添加用的 challenge 同时有效的数量上限，超出时丢弃最早的（只有已登录的会话能申请）
const MAX_PENDING_CHALLENGES = 100;
// 登录用的 challenge 不在服务端保存（见 createPasskeys），只记下登录成功用过的（需要私钥才能产生，正常使用远到不了这个数量），
// 超出时丢弃最早记下的
const MAX_USED_LOGIN_CHALLENGES = 10000;
const LOGIN_NONCE_BYTES = 16;
const LOGIN_MAC_BYTES = 16;
// EdDSA、ES256、RS256。固定下来，不随 Node.js 是否支持后量子算法而变化
const SUPPORTED_ALGORITHMS = [-8, -7, -257];

const ownerKey = (token) => crypto.createHash("sha256").update(String(token || "")).digest("hex");

function normalizeName(rawName, fallback) {
  const name = rawName === undefined || rawName === null ? fallback : String(rawName).trim();
  if (!name) {
    throw badRequest("passkey 名称不能为空");
  }
  if (name.length > MAX_NAME_LENGTH) {
    throw badRequest(`passkey 名称不能超过 ${MAX_NAME_LENGTH} 个字符`);
  }
  rejectUnsafeName(name, "passkey 名称");
  return name;
}

function notFound(id) {
  return new PanelError(404, "passkey_not_found", `passkey 不存在：${id}`);
}

// 面板的 passkey（WebAuthn）。relyingParty 为 { id, origin }（见 options.js 的 passkeyRelyingParty），为 null 时不提供 passkey，
// 已保存的 passkey 仍可查看与删除。passkey 保存在 panel.json 的 auth.passkeys 中，只含公钥。
// challenge 5 分钟内有效、只能使用一次，并且只能用于申请时的用途（登录、二次验证或添加）；二次验证与添加还绑定申请时的会话。
// 二次验证与添加用的保存在内存中。登录用的未登录也能申请，不在服务端保存：challenge 自带过期时间与 HMAC（密钥每次启动随机生成），
// 校验时验证 HMAC 与过期时间，只记下用过的防止重放。未登录的请求再多也不会挤掉别人（包括管理员）正在使用的 challenge
function createPasskeys({ store, relyingParty, now = Date.now }) {
  const pending = new Map();
  const loginKey = crypto.randomBytes(32);
  // 登录成功用过的 challenge → 过期时间。只记成功的：校验失败（例如签名不对）的请求不占用这里，
  // 知道 passkey ID 的人用错误签名再多，也挤不掉真正用过的记录，捕获的合法结果不能借此重放
  const usedLogin = new Map();
  // 正在校验的登录 challenge：同一个 challenge 并发提交时只有一个进入校验
  const checkingLogin = new Set();

  const usable = (passkey) => Boolean(relyingParty) && passkey.rpId === relyingParty.id;

  function requireAvailable() {
    if (!relyingParty) {
      throw new PanelError(409, "passkey_unavailable", "需要把 PANEL_PUBLIC_URL 设置为面板的 HTTPS 地址才能使用 passkey");
    }
  }

  function remember(challenge, purpose, owner) {
    const t = now();
    for (const [key, entry] of pending) {
      if (entry.expiresAt <= t) {
        pending.delete(key);
      }
    }
    while (pending.size >= MAX_PENDING_CHALLENGES) {
      pending.delete(pending.keys().next().value);
    }
    pending.set(challenge, { purpose, owner: ownerKey(owner), expiresAt: t + CHALLENGE_TTL_MS });
  }

  const loginMac = (body) => crypto.createHmac("sha256", loginKey).update("login\0").update(body).digest().subarray(0, LOGIN_MAC_BYTES);

  // 登录用的 challenge：8 字节过期时间 + 随机数 + HMAC
  function loginChallenge() {
    const body = Buffer.alloc(8 + LOGIN_NONCE_BYTES);
    body.writeBigUInt64BE(BigInt(now() + CHALLENGE_TTL_MS), 0);
    crypto.randomFillSync(body, 8);
    return new Uint8Array(Buffer.concat([body, loginMac(body)]));
  }

  // 校验登录用的 challenge：HMAC 正确、未过期、没有用过也不在校验中。通过时记入 claim 并占住，
  // 校验结束后由 verifyAssertion 释放，成功时记为用过
  function takeLogin(challenge, claim) {
    const raw = Buffer.from(String(challenge), "base64url");
    // 解码时会忽略空白等字符，只接受规范的写法，同一个 challenge 不能换种写法再用一次或占用更多内存
    if (raw.length !== 8 + LOGIN_NONCE_BYTES + LOGIN_MAC_BYTES || raw.toString("base64url") !== challenge) {
      return false;
    }
    const body = raw.subarray(0, 8 + LOGIN_NONCE_BYTES);
    if (!crypto.timingSafeEqual(raw.subarray(body.length), loginMac(body))) {
      return false;
    }
    const t = now();
    const expiresAt = Number(body.readBigUInt64BE(0));
    if (expiresAt <= t || usedLogin.has(challenge) || checkingLogin.has(challenge)) {
      return false;
    }
    checkingLogin.add(challenge);
    claim.challenge = challenge;
    claim.expiresAt = expiresAt;
    return true;
  }

  function markLoginUsed({ challenge, expiresAt }) {
    const t = now();
    for (const [key, at] of usedLogin) {
      if (at <= t) {
        usedLogin.delete(key);
      }
    }
    while (usedLogin.size >= MAX_USED_LOGIN_CHALLENGES) {
      usedLogin.delete(usedLogin.keys().next().value);
    }
    usedLogin.set(challenge, expiresAt);
  }

  // 校验并作废二次验证、添加用的 challenge：无论是否匹配都只能使用一次
  function take(challenge, purpose, owner) {
    const entry = pending.get(challenge);
    pending.delete(challenge);
    return Boolean(entry) && entry.expiresAt > now() && entry.purpose === purpose && entry.owner === ownerKey(owner);
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
  async function authenticationOptions(purpose, owner) {
    requireAvailable();
    const options = await generateAuthenticationOptions({
      rpID: relyingParty.id,
      ...(purpose === "login" ? { challenge: loginChallenge() } : {}),
      allowCredentials:
        purpose === "reauth"
          ? store.get().auth.passkeys.filter(usable).map((passkey) => ({ id: passkey.id, transports: passkey.transports }))
          : [],
      userVerification: "required",
      timeout: CEREMONY_TIMEOUT_MS,
    });
    if (purpose !== "login") {
      remember(options.challenge, purpose, owner);
    }
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
    // 登录用的 challenge：校验期间占住，校验成功才记为用过
    const claim = {};
    try {
      verification = await verifyAuthenticationResponse({
        response,
        expectedChallenge: (challenge) => (purpose === "login" ? takeLogin(challenge, claim) : take(challenge, purpose, owner)),
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
    } finally {
      if (claim.challenge) {
        checkingLogin.delete(claim.challenge);
        if (verification && verification.verified) {
          markLoginUsed(claim);
        }
      }
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

    loginOptions() {
      return authenticationOptions("login", "");
    },

    reauthOptions(token) {
      return authenticationOptions("reauth", token);
    },

    // 浏览器返回的结果是否来自当前域名下已添加的 passkey；不是时不可能校验通过，登录接口不把它计入限速
    // （passkey 的 ID 不对外公开，伪造的请求只能走到这里，计入限速只会让伪造 X-Forwarded-For 的人锁住别人的 IP）
    isKnownCredential(response) {
      return Boolean(
        relyingParty &&
          response &&
          typeof response === "object" &&
          typeof response.id === "string" &&
          store.get().auth.passkeys.some((item) => item.id === response.id && usable(item))
      );
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
