const path = require("path");
const { CONFIG_GROUPS, CONFIG_SCHEMA } = require("../config/schema");
const { coerceFieldValue, resolveConfig } = require("../config/resolve");
const { normalizeSeleniumUrl } = require("../shared/selenium");
const { badRequest } = require("./errors");
const { SETTINGS_FIELDS } = require("./settings");

// 账号 ID 同时用作数据目录名：小写字母、数字与短横线，1–32 位，不以短横线开头或结尾
const ACCOUNT_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;

// 由面板按账号强制设置的配置项，不出现在表单中，也不能通过接口修改
const PANEL_MANAGED_KEYS = new Set(["dataDir", "accountName"]);
// 密钥只写不读：接口返回掩码；提交掩码或空字符串表示不修改，提交 null 表示清除
const SECRET_MASK = "••••••";

const EDITABLE_FIELDS = CONFIG_SCHEMA.filter((field) => !PANEL_MANAGED_KEYS.has(field.key));
const FIELD_BY_KEY = new Map(EDITABLE_FIELDS.map((field) => [field.key, field]));

function describeField(field) {
  const { key, type, group, label, description, options, min, max, secret, accountOnly } = field;
  return {
    key,
    type,
    group,
    label,
    description: description || "",
    default: secret ? "" : field.default,
    options: options || null,
    min: min === undefined ? null : min,
    max: max === undefined ? null : max,
    secret: Boolean(secret),
    accountOnly: Boolean(accountOnly),
  };
}

// 供前端生成表单：运行配置分组与字段、面板设置字段
function publicSchema() {
  const usedGroups = new Set(EDITABLE_FIELDS.map((field) => field.group));
  return {
    groups: CONFIG_GROUPS.filter((group) => usedGroups.has(group.id)),
    fields: EDITABLE_FIELDS.map(describeField),
    settingsFields: SETTINGS_FIELDS.map(describeField),
  };
}

// 地址类配置项都可能在地址中带用户名与密码（例如 Selenium、自建的 Bark、ntfy 或 Telegram 反向代理）：
// 接口返回时把密码换成掩码，导出备份时放进加密部分
const URL_WITH_PASSWORD_KEYS = new Set(EDITABLE_FIELDS.filter((field) => field.format === "url").map((field) => field.key));

// 把地址拆成「密码之前、密码、密码之后」三段；没有密码时返回 null
function splitUrlPassword(url) {
  // 使用时会去掉首尾空白，这里同样去掉，否则带前导空白的地址会原样返回、露出密码
  const match = /^((?:[a-z][a-z0-9+.-]*:\/\/)?)([^/?#]*)(.*)$/is.exec(String(url).trim());
  const authority = match[2];
  const at = authority.lastIndexOf("@");
  const colon = authority.slice(0, Math.max(at, 0)).indexOf(":");
  if (at < 0 || colon < 0 || colon === at - 1) {
    return null;
  }
  return {
    before: match[1] + authority.slice(0, colon + 1),
    password: authority.slice(colon + 1, at),
    after: authority.slice(at) + match[3],
  };
}

function maskValue(field, value) {
  if (field.secret && value) {
    return SECRET_MASK;
  }
  if (URL_WITH_PASSWORD_KEYS.has(field.key) && value) {
    const parts = splitUrlPassword(value);
    return parts ? parts.before + SECRET_MASK + parts.after : value;
  }
  return value;
}

// 是否为需要保护的值：密钥类配置项，或带密码的地址。导出备份时这些值只放进加密部分
function isSensitiveValue(key, value) {
  const field = FIELD_BY_KEY.get(key);
  if (!field || !value) {
    return false;
  }
  return Boolean(field.secret) || (URL_WITH_PASSWORD_KEYS.has(key) && Boolean(splitUrlPassword(String(value))));
}

function maskValues(values) {
  const masked = {};
  for (const [key, value] of Object.entries(values)) {
    const field = FIELD_BY_KEY.get(key);
    if (!field) {
      continue;
    }
    masked[key] = maskValue(field, value);
  }
  return masked;
}

// 提交的地址中密码为掩码：地址的其余部分（含用户名、主机与端口）与当前值相同时沿用当前的密码，
// 否则拒绝，不能借掩码把已保存的密码发往别的地址
function keepMaskedUrlPassword(field, currentValue, rawValue) {
  const submitted = typeof rawValue === "string" ? splitUrlPassword(rawValue.trim()) : null;
  if (!submitted || submitted.password !== SECRET_MASK) {
    return false;
  }
  const current = currentValue ? splitUrlPassword(currentValue) : null;
  if (!current || current.before !== submitted.before || current.after !== submitted.after) {
    throw badRequest(`${field.label}中的密码是掩码：修改地址或用户名时需要重新填写密码`);
  }
  return true;
}

// 地址类配置项保存前校验格式：必须是 http(s) 地址，限定了域名时只能是这些域名
function validateFormat(field, value) {
  let url;
  try {
    url = new URL(field.key === "seleniumUrl" ? normalizeSeleniumUrl(value) : String(value).trim());
  } catch (_) {
    url = null;
  }
  if (!url || (url.protocol !== "http:" && url.protocol !== "https:") || !url.hostname) {
    throw badRequest(`${field.label}必须是以 http:// 或 https:// 开头的地址`);
  }
  if (field.hosts && !field.hosts.includes(url.hostname.toLowerCase())) {
    throw badRequest(`${field.label}只能是 ${field.hosts.join("、")} 的地址`);
  }
}

// 按 patch 修改一组配置值（全局默认或账号覆盖）并返回新对象。
// null 或空字符串表示删除该项、回到上一级的值；密钥字段提交空字符串或掩码表示不修改
// scope 为 "defaults" 时拒绝只能在账号中设置的项
function applyConfigPatch(current, patch, { scope = "account" } = {}) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    throw badRequest("配置必须是对象");
  }
  const next = { ...current };
  for (const [key, rawValue] of Object.entries(patch)) {
    const field = FIELD_BY_KEY.get(key);
    if (!field) {
      throw badRequest(`未知的配置项：${key}`);
    }
    if (scope === "defaults" && field.accountOnly && rawValue !== null && rawValue !== "") {
      throw badRequest(`${field.label}只能在账号中设置`);
    }
    if (field.secret && (rawValue === "" || rawValue === SECRET_MASK)) {
      continue;
    }
    if (URL_WITH_PASSWORD_KEYS.has(key) && keepMaskedUrlPassword(field, current[key], rawValue)) {
      continue;
    }
    if (rawValue === null || rawValue === "") {
      delete next[key];
      continue;
    }
    try {
      next[key] = coerceFieldValue(field, rawValue, field.label);
    } catch (e) {
      throw badRequest(e.message);
    }
    if (field.format === "url") {
      next[key] = String(next[key]).trim();
      if (next[key] === "") {
        delete next[key];
        continue;
      }
      validateFormat(field, next[key]);
    }
    if (field.pattern && !field.pattern.test(String(next[key]).trim())) {
      throw badRequest(`${field.label}${field.patternHint ? `：${field.patternHint}` : "格式不对"}`);
    }
    if (field.pattern) {
      next[key] = String(next[key]).trim();
    }
  }
  return next;
}

// 账号 ID 在拼接路径前再校验一次，手工写入 panel.json 的 ID 不会指向数据目录之外
function accountDataDir(panelDataDir, accountId) {
  if (!ACCOUNT_ID_PATTERN.test(accountId)) {
    throw new Error(`无效的账号 ID：${accountId}`);
  }
  return path.join(path.resolve(panelDataDir), "accounts", accountId);
}

// 账号的实际运行配置：账号覆盖 > 全局默认 > 内置默认；数据目录与账号名称由面板决定
function resolveAccountConfig(data, account, panelDataDir) {
  return resolveConfig({
    ...data.defaults,
    ...account.overrides,
    dataDir: accountDataDir(panelDataDir, account.id),
    accountName: account.name,
  });
}

// 去掉面板管理的配置项并隐藏密钥，用于在接口中展示实际生效的配置
function publicEffectiveConfig(config) {
  return maskValues(Object.fromEntries(Object.entries(config).filter(([key]) => !PANEL_MANAGED_KEYS.has(key))));
}

module.exports = {
  SECRET_MASK,
  ACCOUNT_ID_PATTERN,
  accountDataDir,
  applyConfigPatch,
  isSensitiveValue,
  maskValues,
  publicEffectiveConfig,
  publicSchema,
  resolveAccountConfig,
};
