const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { promisify } = require("util");
const { ensurePrivateDir, writeFileAtomic } = require("../shared/files");
const { VERSION } = require("../shared/version");
const { normalizeName } = require("./accounts");
const { normalizeChallenge } = require("./challenge");
const { ACCOUNT_ID_PATTERN, accountDataDir, applyConfigPatch, isSensitiveValue, maskValues } = require("./config");
const { PanelError, badRequest } = require("./errors");
const { normalizeGoal } = require("./goal");
const { normalizeSchedules } = require("./schedules");
const { applySettingsPatch } = require("./settings");

// 配置备份（导出与导入）。备份文件是一个 JSON：
//   { format, formatVersion, appVersion, exportedAt, settings, defaults, accounts, secretsIncluded, cookiesIncluded, omittedSecrets, sealed }
// 密钥类配置（含带密码的 Selenium 地址）与登录 cookies 只放在 sealed 中：用备份密码经 scrypt 派生密钥后以 AES-256-GCM 加密。
// 不包含：面板密码、passkey、会话、运行记录、日志、截图与浏览器资料

const FORMAT = "weread-assistant-backup";
const FORMAT_VERSION = 1;
const MIN_PASSPHRASE_LENGTH = 8;
const MAX_PASSPHRASE_LENGTH = 1024;
const MAX_ACCOUNTS = 200;
// cookies.json 的大小上限（正常只有几 KB）
const MAX_COOKIES_BYTES = 256 * 1024;
// 导入前另存的 panel.json 份数
const PRE_IMPORT_COPIES = 3;
const KDF = { N: 32768, r: 8, p: 1 };
// 读取文件中的 scrypt 参数时的上限，防止被构造的文件拖慢面板
const KDF_LIMITS = { N: 1 << 17, r: 16, p: 4 };
const SCRYPT_MAXMEM = 256 * 1024 * 1024;
const AAD = Buffer.from(`${FORMAT}:${FORMAT_VERSION}`);

const scrypt = promisify(crypto.scrypt);
const isPlainObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);

function checkPassphrase(passphrase) {
  if (typeof passphrase !== "string" || passphrase.length < MIN_PASSPHRASE_LENGTH || passphrase.length > MAX_PASSPHRASE_LENGTH) {
    throw new PanelError(400, "backup_passphrase_required", `包含密钥或登录状态时需要设置备份密码（至少 ${MIN_PASSPHRASE_LENGTH} 位）`);
  }
}

async function deriveKey(passphrase, salt, params) {
  return scrypt(passphrase, salt, 32, { ...params, maxmem: SCRYPT_MAXMEM });
}

async function seal(payload, passphrase) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = await deriveKey(passphrase, salt, KDF);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(AAD);
  const data = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
  return {
    cipher: "aes-256-gcm",
    kdf: "scrypt",
    ...KDF,
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: data.toString("base64"),
  };
}

async function unseal(sealed, passphrase) {
  const failed = () => new PanelError(400, "backup_decrypt_failed", "无法解密备份中的密钥与登录状态：备份密码错误，或文件被改动过");
  if (!isPlainObject(sealed) || sealed.cipher !== "aes-256-gcm" || sealed.kdf !== "scrypt") {
    throw badRequest("备份文件中的加密部分格式不对");
  }
  const params = { N: sealed.N, r: sealed.r, p: sealed.p };
  const valid = Object.entries(params).every(
    ([name, value]) => Number.isSafeInteger(value) && value > 0 && value <= KDF_LIMITS[name]
  );
  if (!valid || (params.N & (params.N - 1)) !== 0) {
    throw badRequest("备份文件中的加密参数不对");
  }
  checkPassphrase(passphrase);
  let payload;
  try {
    const key = await deriveKey(passphrase, Buffer.from(String(sealed.salt), "base64"), params);
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(String(sealed.iv), "base64"));
    decipher.setAAD(AAD);
    decipher.setAuthTag(Buffer.from(String(sealed.tag), "base64"));
    const text = Buffer.concat([decipher.update(Buffer.from(String(sealed.data), "base64")), decipher.final()]).toString("utf8");
    payload = JSON.parse(text);
  } catch (_) {
    throw failed();
  }
  if (!isPlainObject(payload)) {
    throw failed();
  }
  return payload;
}

// 把一组配置拆成可以明文保存的与需要保护的
function splitSensitive(values = {}) {
  const plain = {};
  const sensitive = {};
  for (const [key, value] of Object.entries(values)) {
    (isSensitiveValue(key, value) ? sensitive : plain)[key] = value;
  }
  return { plain, sensitive };
}

// 账号的 cookies.json；不存在、读不出或不是合法的 cookie 列表时返回 null
function readCookies(dataDir, accountId) {
  try {
    const file = path.join(accountDataDir(dataDir, accountId), "cookies.json");
    if (fs.statSync(file).size > MAX_COOKIES_BYTES) {
      return null;
    }
    const cookies = JSON.parse(fs.readFileSync(file, "utf8"));
    return validCookies(cookies) ? cookies : null;
  } catch (_) {
    return null;
  }
}

function validCookies(cookies) {
  return (
    Array.isArray(cookies) &&
    cookies.length > 0 &&
    cookies.length <= 500 &&
    cookies.every((cookie) => isPlainObject(cookie) && typeof cookie.name === "string" && typeof cookie.value === "string") &&
    Buffer.byteLength(JSON.stringify(cookies)) <= MAX_COOKIES_BYTES
  );
}

function backupFileName(now = new Date()) {
  return `weread-assistant-backup-${now.toISOString().slice(0, 10).replace(/-/g, "")}.json`;
}

/**
 * 生成备份。includeSecrets：包含密钥类配置；includeCookies：包含各账号的登录 cookies；两者任一为 true 时需要 passphrase
 */
async function buildBackup(data, { dataDir, includeSecrets = false, includeCookies = false, passphrase = "", now = new Date() } = {}) {
  if (includeSecrets || includeCookies) {
    checkPassphrase(passphrase);
  }
  const omittedSecrets = [];
  const sealedPayload = { defaults: {}, accounts: {} };
  const defaults = splitSensitive(data.defaults);
  if (includeSecrets) {
    sealedPayload.defaults = defaults.sensitive;
  } else {
    omittedSecrets.push(...Object.keys(defaults.sensitive).map((key) => ({ scope: "defaults", key })));
  }
  const accounts = data.accounts.map((account) => {
    const overrides = splitSensitive(account.overrides);
    const sealedAccount = {};
    if (includeSecrets && Object.keys(overrides.sensitive).length > 0) {
      sealedAccount.overrides = overrides.sensitive;
    } else if (!includeSecrets) {
      omittedSecrets.push(...Object.keys(overrides.sensitive).map((key) => ({ scope: account.id, key })));
    }
    if (includeCookies) {
      const cookies = readCookies(dataDir, account.id);
      if (cookies) {
        sealedAccount.cookies = cookies;
      }
    }
    if (Object.keys(sealedAccount).length > 0) {
      sealedPayload.accounts[account.id] = sealedAccount;
    }
    return {
      id: account.id,
      name: account.name,
      enabled: account.enabled,
      createdAt: account.createdAt,
      overrides: overrides.plain,
      schedules: account.schedules,
      challenge: account.challenge,
      goal: account.goal || null,
    };
  });
  return {
    format: FORMAT,
    formatVersion: FORMAT_VERSION,
    appVersion: VERSION,
    exportedAt: now.toISOString(),
    secretsIncluded: Boolean(includeSecrets),
    cookiesIncluded: Boolean(includeCookies),
    omittedSecrets,
    settings: data.settings,
    defaults: defaults.plain,
    accounts,
    sealed: includeSecrets || includeCookies ? await seal(sealedPayload, passphrase) : null,
  };
}

/**
 * 读取备份文件：检查格式与版本，有加密部分时用 passphrase 解密并把密钥、cookies 合并回去。
 * 返回 { exportedAt, appVersion, secretsIncluded, cookiesIncluded, omittedSecrets, settings, defaults, accounts }
 */
async function openBackup(raw, passphrase = "") {
  if (!isPlainObject(raw) || raw.format !== FORMAT) {
    throw new PanelError(400, "backup_invalid", "不是 WeReadAssistant 的备份文件");
  }
  if (!Number.isSafeInteger(raw.formatVersion) || raw.formatVersion < 1) {
    throw new PanelError(400, "backup_invalid", "备份文件的格式版本不对");
  }
  if (raw.formatVersion > FORMAT_VERSION) {
    throw new PanelError(400, "backup_too_new", `备份文件来自更新版本的面板（格式 ${raw.formatVersion}，当前支持 ${FORMAT_VERSION}），请先升级面板再导入`);
  }
  if (raw.settings !== null && raw.settings !== undefined && !isPlainObject(raw.settings)) {
    throw new PanelError(400, "backup_invalid", "备份文件中的 settings 必须是对象");
  }
  if (raw.defaults !== undefined && !isPlainObject(raw.defaults)) {
    throw new PanelError(400, "backup_invalid", "备份文件中的 defaults 必须是对象");
  }
  if (!Array.isArray(raw.accounts) || raw.accounts.length > MAX_ACCOUNTS) {
    throw new PanelError(400, "backup_invalid", `备份文件中的 accounts 必须是数组，最多 ${MAX_ACCOUNTS} 个账号`);
  }
  const sealed = raw.sealed ? await unseal(raw.sealed, passphrase) : { defaults: {}, accounts: {} };
  const sealedAccounts = isPlainObject(sealed.accounts) ? sealed.accounts : {};
  const accounts = raw.accounts.map((item) => {
    if (!isPlainObject(item)) {
      return item;
    }
    const extra = typeof item.id === "string" && Object.hasOwn(sealedAccounts, item.id) && isPlainObject(sealedAccounts[item.id]) ? sealedAccounts[item.id] : {};
    return {
      ...item,
      overrides: { ...(isPlainObject(item.overrides) ? item.overrides : {}), ...(isPlainObject(extra.overrides) ? extra.overrides : {}) },
      cookies: extra.cookies === undefined ? null : extra.cookies,
    };
  });
  return {
    exportedAt: typeof raw.exportedAt === "string" ? raw.exportedAt : "",
    appVersion: typeof raw.appVersion === "string" ? raw.appVersion : "",
    secretsIncluded: raw.secretsIncluded === true,
    cookiesIncluded: raw.cookiesIncluded === true,
    omittedSecrets: Array.isArray(raw.omittedSecrets) ? raw.omittedSecrets.filter(isPlainObject).slice(0, 1000) : [],
    settings: raw.settings || null,
    defaults: { ...(raw.defaults || {}), ...(isPlainObject(sealed.defaults) ? sealed.defaults : {}) },
    accounts,
  };
}

function normalizeImportOptions(raw = {}) {
  if (!isPlainObject(raw)) {
    throw badRequest("options 必须是对象");
  }
  const unknown = Object.keys(raw).filter((key) => !["accounts", "overwrite", "settings"].includes(key));
  if (unknown.length > 0) {
    throw badRequest(`options 包含不支持的字段：${unknown.join(", ")}`);
  }
  const accounts = raw.accounts === undefined ? "merge" : raw.accounts;
  if (accounts !== "merge" && accounts !== "replace") {
    throw badRequest("options.accounts 只能是 merge 或 replace");
  }
  for (const key of ["overwrite", "settings"]) {
    if (raw[key] !== undefined && typeof raw[key] !== "boolean") {
      throw badRequest(`options.${key} 必须是 true 或 false`);
    }
  }
  return { accounts, overwrite: raw.overwrite === true, settings: raw.settings !== false };
}

// 逐项应用一组配置，无效的项记入 invalid 并跳过，不影响其他项
function applyConfigValues(base, values, label, invalid) {
  let next = base;
  for (const [key, value] of Object.entries(isPlainObject(values) ? values : {})) {
    try {
      next = applyConfigPatch(next, { [key]: value });
    } catch (e) {
      invalid.push({ item: `${label} · ${key}`, reason: e.message });
    }
  }
  return next;
}

// 现有配置中的密钥：备份不含密钥时保留，导入后不必重新填写
function sensitiveOnly(values = {}) {
  return splitSensitive(values).sensitive;
}

// 两组值中变化的项；mask 为 true 时（运行配置）密钥显示为掩码
function diffValues(before, after, { mask = true } = {}) {
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  const maskedBefore = mask ? maskValues(before) : before;
  const maskedAfter = mask ? maskValues(after) : after;
  return keys
    .filter((key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]))
    .map((key) => ({ key, from: maskedBefore[key] === undefined ? null : maskedBefore[key], to: maskedAfter[key] === undefined ? null : maskedAfter[key] }));
}

// 校验备份中的一个账号，返回存储格式；无效时抛出错误
function normalizeImportedAccount(item, invalid, now) {
  if (!isPlainObject(item)) {
    throw badRequest("不是对象");
  }
  const id = typeof item.id === "string" ? item.id : "";
  if (!ACCOUNT_ID_PATTERN.test(id)) {
    throw badRequest(`账号 ID 无效：${String(item.id)}`);
  }
  if (item.enabled !== undefined && typeof item.enabled !== "boolean") {
    throw badRequest("enabled 必须是 true 或 false");
  }
  const createdAt = typeof item.createdAt === "string" && !Number.isNaN(Date.parse(item.createdAt)) ? new Date(item.createdAt).toISOString() : now.toISOString();
  return {
    id,
    name: normalizeName(item.name, id),
    enabled: item.enabled !== false,
    createdAt,
    overrides: applyConfigValues({}, item.overrides, `账号 ${id} 的配置`, invalid),
    schedules: normalizeSchedules(item.schedules === undefined || item.schedules === null ? [] : item.schedules),
    challenge: item.challenge === undefined || item.challenge === null ? null : normalizeChallenge(item.challenge),
    goal: item.goal === undefined || item.goal === null ? null : normalizeGoal(item.goal),
  };
}

/**
 * 计算导入的结果：返回 { preview, next, cookies }。preview 为将要发生的变化（不含密钥值），next 为导入后的面板数据，
 * cookies 为要写入的 [{ id, cookies }]。不修改 data。isBusy(id) 为 true 的账号（正在运行或排队）不覆盖、不移除
 */
function planImport(data, backup, rawOptions = {}, { isBusy = () => false, now = new Date() } = {}) {
  const options = normalizeImportOptions(rawOptions);
  const invalid = [];
  const next = JSON.parse(JSON.stringify(data));
  const preview = {
    exportedAt: backup.exportedAt,
    appVersion: backup.appVersion,
    secretsIncluded: backup.secretsIncluded,
    cookiesIncluded: backup.cookiesIncluded,
    omittedSecrets: backup.omittedSecrets.map((item) => ({ scope: String(item.scope || ""), key: String(item.key || "") })),
    options,
    settings: [],
    defaults: [],
    accounts: [],
    removed: [],
    kept: [],
    invalid,
  };

  if (options.settings) {
    if (backup.settings) {
      try {
        next.settings = applySettingsPatch(data.settings, backup.settings);
        preview.settings = diffValues(data.settings, next.settings, { mask: false });
      } catch (e) {
        invalid.push({ item: "面板设置", reason: e.message });
      }
    }
    const base = backup.secretsIncluded ? {} : sensitiveOnly(data.defaults);
    next.defaults = applyConfigValues(base, backup.defaults, "全局默认配置", invalid);
    preview.defaults = diffValues(data.defaults, next.defaults);
  }

  const cookies = [];
  const imported = new Map();
  for (const [index, item] of backup.accounts.entries()) {
    let account;
    try {
      account = normalizeImportedAccount(item, invalid, now);
    } catch (e) {
      const id = isPlainObject(item) && typeof item.id === "string" ? item.id : `第 ${index + 1} 个`;
      invalid.push({ item: `账号 ${id}`, reason: e.message });
      continue;
    }
    if (imported.has(account.id)) {
      invalid.push({ item: `账号 ${account.id}`, reason: "备份中有重复的账号 ID，只导入第一个" });
      continue;
    }
    const existing = data.accounts.find((other) => other.id === account.id);
    const hasCookies = validCookies(item.cookies);
    const entry = { id: account.id, name: account.name, action: existing ? "overwrite" : "add", reason: "", cookies: hasCookies };
    if (existing && options.accounts === "merge" && !options.overwrite) {
      entry.action = "skip";
      entry.reason = "已有同 ID 的账号，没有选择覆盖";
    } else if (existing && isBusy(account.id)) {
      entry.action = "skip";
      entry.reason = "账号正在运行或排队，没有覆盖";
    }
    if (item.cookies !== null && item.cookies !== undefined && !hasCookies) {
      invalid.push({ item: `账号 ${account.id} 的登录状态`, reason: "cookies 格式不对，没有导入" });
    }
    preview.accounts.push(entry);
    if (entry.action === "skip") {
      imported.set(account.id, existing);
      continue;
    }
    if (existing && !backup.secretsIncluded) {
      account.overrides = { ...sensitiveOnly(existing.overrides), ...account.overrides };
    }
    imported.set(account.id, account);
    if (hasCookies) {
      cookies.push({ id: account.id, cookies: item.cookies });
    }
  }

  if (options.accounts === "replace") {
    const result = [];
    for (const account of data.accounts) {
      if (imported.has(account.id)) {
        continue;
      }
      if (isBusy(account.id)) {
        preview.kept.push({ id: account.id, name: account.name, reason: "账号正在运行或排队，没有移除" });
        result.push(account);
      } else {
        preview.removed.push({ id: account.id, name: account.name });
      }
    }
    next.accounts = [...result, ...imported.values()];
  } else {
    next.accounts = data.accounts.map((account) => imported.get(account.id) || account);
    for (const account of imported.values()) {
      if (!data.accounts.some((other) => other.id === account.id)) {
        next.accounts.push(account);
      }
    }
  }
  return { preview, next, cookies };
}

// 导入前把 panel.json 另存为 panel.json.pre-import-<时间>，只保留最近几份
function savePreImportCopy(dataDir, now = new Date()) {
  const source = path.join(dataDir, "panel.json");
  const stamp = now.toISOString().replace(/[-:.]/g, "");
  const target = `${source}.pre-import-${stamp}`;
  writeFileAtomic(target, fs.readFileSync(source), { mode: 0o600 });
  const copies = fs
    .readdirSync(dataDir)
    .filter((name) => name.startsWith("panel.json.pre-import-"))
    .sort()
    .reverse();
  for (const name of copies.slice(PRE_IMPORT_COPIES)) {
    fs.rmSync(path.join(dataDir, name), { force: true });
  }
  return path.basename(target);
}

/**
 * 应用导入：先另存 panel.json，为新账号准备数据目录，在一次 store.update 中写入全部变化，然后写入 cookies。
 * 返回 { preview, copy }
 */
async function applyImport(store, dataDir, backup, options, { isBusy = () => false, now = new Date() } = {}) {
  const planned = planImport(store.get(), backup, options, { isBusy, now });
  for (const entry of planned.preview.accounts) {
    if (entry.action === "add") {
      try {
        ensurePrivateDir(accountDataDir(dataDir, entry.id));
      } catch (e) {
        throw new PanelError(500, "account_dir_failed", `无法创建账号 ${entry.id} 的数据目录，没有导入任何内容：${e.message}`);
      }
    }
  }
  const copy = savePreImportCopy(dataDir, now);
  let result;
  await store.update((draft) => {
    // 以写入时的数据重新计算，期间的修改与运行状态都考虑在内
    result = planImport(draft, backup, options, { isBusy, now });
    Object.assign(draft, result.next);
  });
  for (const { id, cookies } of result.cookies) {
    try {
      const dir = accountDataDir(dataDir, id);
      ensurePrivateDir(dir);
      writeFileAtomic(path.join(dir, "cookies.json"), JSON.stringify(cookies, null, 2), { mode: 0o600 });
    } catch (e) {
      result.preview.invalid.push({ item: `账号 ${id} 的登录状态`, reason: `写入失败：${e.message}` });
    }
  }
  return { preview: result.preview, copy };
}

module.exports = {
  FORMAT,
  FORMAT_VERSION,
  MIN_PASSPHRASE_LENGTH,
  applyImport,
  backupFileName,
  buildBackup,
  openBackup,
  planImport,
};
