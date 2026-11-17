const crypto = require("crypto");
const { PanelError, badRequest, requireObject } = require("./errors");

/**
 * API 令牌：给脚本、快捷指令与 AI 助手（MCP）用的长期凭据，与面板登录会话分开。
 * 保存在 panel.json 的 auth.tokens 中，只存 SHA-256 哈希（令牌本身是 32 字节随机数，创建时显示一次）：
 *   { id, name, hash, hint, scopes, accounts, createdAt, expiresAt, lastUsedAt }
 * scopes 决定能做什么（见 SCOPES），accounts 为能访问的账号 ID（null 为全部账号，包括以后新建的）。
 * 令牌只能用于 api/v1 与 mcp，不能访问管理接口（设置、配置、密钥、备份、令牌本身）。
 */

const TOKEN_PREFIX = "wat_";
const MAX_TOKENS = 20;
const MAX_EXPIRES_DAYS = 3650;
// 最近使用时间最多每小时写回一次 panel.json
const LAST_USED_WRITE_MS = 60 * 60 * 1000;

const SCOPES = {
  read: "查看账号状态、运行记录与统计",
  run: "开始与停止运行",
  notes: "读取与同步笔记、阅读报告",
};

const TOKEN_PATTERN = /^wat_[A-Za-z0-9_-]{43}$/;

const hashToken = (token) => crypto.createHash("sha256").update(token).digest("hex");

// panel.json 中的令牌（可能被手工改坏）：去掉缺少关键字段的
function storedTokens(raw) {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw
    .filter((item) => item && typeof item === "object" && typeof item.id === "string" && /^[0-9a-f]{64}$/.test(item.hash || ""))
    .map((item) => ({
      id: item.id,
      name: typeof item.name === "string" ? item.name : "",
      hash: item.hash,
      hint: typeof item.hint === "string" ? item.hint : "",
      scopes: Array.isArray(item.scopes) ? item.scopes.filter((scope) => Object.hasOwn(SCOPES, scope)) : [],
      accounts: Array.isArray(item.accounts) ? item.accounts.filter((id) => typeof id === "string") : null,
      createdAt: typeof item.createdAt === "string" ? item.createdAt : null,
      expiresAt: typeof item.expiresAt === "string" ? item.expiresAt : null,
      lastUsedAt: typeof item.lastUsedAt === "string" ? item.lastUsedAt : null,
    }));
}

// 接口返回的令牌：不含哈希
const publicToken = (token) => {
  const { hash: _hash, ...view } = token;
  return view;
};

function normalizeCreate(body, accountIds) {
  requireObject(body);
  const unknown = Object.keys(body).filter((key) => !["name", "scopes", "accounts", "expiresInDays"].includes(key));
  if (unknown.length > 0) {
    throw badRequest(`未知的字段：${unknown.join(", ")}`);
  }
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name || name.length > 40) {
    throw badRequest("请填写令牌名称（不超过 40 个字）");
  }
  if (!Array.isArray(body.scopes) || body.scopes.length === 0 || !body.scopes.every((scope) => Object.hasOwn(SCOPES, scope))) {
    throw badRequest(`权限至少选一项，只能是 ${Object.keys(SCOPES).join("、")}`);
  }
  let accounts = null;
  if (body.accounts !== undefined && body.accounts !== null) {
    if (!Array.isArray(body.accounts) || body.accounts.length === 0) {
      throw badRequest("accounts 为账号 ID 的数组（至少一个），或 null 表示全部账号");
    }
    const missing = body.accounts.filter((id) => !accountIds.includes(id));
    if (missing.length > 0) {
      throw badRequest(`账号不存在：${missing.join(", ")}`);
    }
    accounts = [...new Set(body.accounts)];
  }
  let expiresInDays = null;
  if (body.expiresInDays !== undefined && body.expiresInDays !== null) {
    if (!Number.isInteger(body.expiresInDays) || body.expiresInDays < 1 || body.expiresInDays > MAX_EXPIRES_DAYS) {
      throw badRequest(`有效天数必须是 1–${MAX_EXPIRES_DAYS} 的整数，或不填表示不过期`);
    }
    expiresInDays = body.expiresInDays;
  }
  return { name, scopes: Object.keys(SCOPES).filter((scope) => body.scopes.includes(scope)), accounts, expiresInDays };
}

function createTokens({ store, now = () => Date.now() }) {
  // 内存中较新的最近使用时间：tokenId → ISO 时间；写回 panel.json 的时间：tokenId → 毫秒
  const lastUsed = new Map();
  const written = new Map();

  const all = () => storedTokens(store.get().auth.tokens);

  function list() {
    return all().map((token) => publicToken({ ...token, lastUsedAt: lastUsed.get(token.id) || token.lastUsedAt }));
  }

  async function create(body) {
    const data = store.get();
    const input = normalizeCreate(body, data.accounts.map((account) => account.id));
    const secret = `${TOKEN_PREFIX}${crypto.randomBytes(32).toString("base64url")}`;
    const created = new Date(now());
    const token = {
      id: crypto.randomBytes(8).toString("hex"),
      name: input.name,
      hash: hashToken(secret),
      hint: `${secret.slice(0, 8)}…${secret.slice(-4)}`,
      scopes: input.scopes,
      accounts: input.accounts,
      createdAt: created.toISOString(),
      expiresAt: input.expiresInDays ? new Date(created.getTime() + input.expiresInDays * 86400000).toISOString() : null,
      lastUsedAt: null,
    };
    await store.update((next) => {
      const tokens = storedTokens(next.auth.tokens);
      if (tokens.length >= MAX_TOKENS) {
        throw badRequest(`最多 ${MAX_TOKENS} 个令牌，请先删除不用的`);
      }
      next.auth.tokens = [...tokens, token];
    });
    console.info(`新建 API 令牌：${token.name}（${token.scopes.join(",")}）`);
    return { token: secret, info: publicToken(token) };
  }

  async function remove(id) {
    let found = null;
    await store.update((next) => {
      const tokens = storedTokens(next.auth.tokens);
      found = tokens.find((token) => token.id === id) || null;
      if (!found) {
        throw new PanelError(404, "not_found", "令牌不存在");
      }
      next.auth.tokens = tokens.filter((token) => token.id !== id);
    });
    lastUsed.delete(id);
    console.info(`删除 API 令牌：${found.name}`);
  }

  // 校验 Authorization 中的令牌：有效时返回 { id, name, scopes, accounts }，否则 null（不区分不存在与过期）
  function verify(secret) {
    if (typeof secret !== "string" || !TOKEN_PATTERN.test(secret)) {
      return null;
    }
    const hash = hashToken(secret);
    const token = all().find((item) => crypto.timingSafeEqual(Buffer.from(item.hash, "hex"), Buffer.from(hash, "hex")));
    if (!token) {
      return null;
    }
    if (token.expiresAt && Date.parse(token.expiresAt) <= now()) {
      return null;
    }
    markUsed(token.id);
    return { id: token.id, name: token.name, scopes: token.scopes, accounts: token.accounts };
  }

  function markUsed(id) {
    const at = new Date(now()).toISOString();
    lastUsed.set(id, at);
    if (now() - (written.get(id) || 0) < LAST_USED_WRITE_MS) {
      return;
    }
    written.set(id, now());
    store
      .update((next) => {
        const tokens = storedTokens(next.auth.tokens);
        const token = tokens.find((item) => item.id === id);
        if (token) {
          token.lastUsedAt = at;
          next.auth.tokens = tokens;
        }
      })
      .catch((e) => console.warn("保存令牌最近使用时间失败:", e.message));
  }

  return { list, create, remove, verify };
}

// 令牌能否访问账号
const canAccess = (token, accountId) => token.accounts === null || token.accounts.includes(accountId);

module.exports = {
  MAX_TOKENS,
  SCOPES,
  TOKEN_PREFIX,
  canAccess,
  createTokens,
  hashToken,
  storedTokens,
};
