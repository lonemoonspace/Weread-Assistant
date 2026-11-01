const path = require("path");
const { CONFIG_GROUPS, CONFIG_SCHEMA } = require("../config/schema");
const { coerceFieldValue, resolveConfig } = require("../config/resolve");
const { badRequest } = require("./errors");
const { SETTINGS_FIELDS } = require("./settings");

// 账号 ID 同时用作数据目录名与浏览器配置名：小写字母、数字与短横线，1–32 位，不以短横线开头或结尾
const ACCOUNT_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;

// 由面板按账号强制设置的配置项，不出现在表单中，也不能通过接口修改
const PANEL_MANAGED_KEYS = new Set(["dataDir", "profileName", "accountName"]);
// 密钥只写不读：接口返回掩码；提交掩码或空字符串表示不修改，提交 null 表示清除
const SECRET_MASK = "••••••";

const EDITABLE_FIELDS = CONFIG_SCHEMA.filter((field) => !PANEL_MANAGED_KEYS.has(field.key));
const FIELD_BY_KEY = new Map(EDITABLE_FIELDS.map((field) => [field.key, field]));

function describeField(field) {
  const { key, type, group, label, description, options, min, max, secret } = field;
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

// 地址中带用户名与密码的配置项（Selenium 地址）：接口返回时把密码换成掩码
const URL_WITH_PASSWORD_KEYS = new Set(["seleniumUrl"]);

// 把地址拆成「密码之前、密码、密码之后」三段；没有密码时返回 null
function splitUrlPassword(url) {
  const match = /^((?:[a-z][a-z0-9+.-]*:\/\/)?)([^/?#]*)(.*)$/is.exec(String(url));
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

// 按 patch 修改一组配置值（全局默认或账号覆盖）并返回新对象。
// null 或空字符串表示删除该项、回到上一级的值；密钥字段提交空字符串或掩码表示不修改
function applyConfigPatch(current, patch) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    throw badRequest("配置必须是对象");
  }
  const next = { ...current };
  for (const [key, rawValue] of Object.entries(patch)) {
    const field = FIELD_BY_KEY.get(key);
    if (!field) {
      throw badRequest(`未知的配置项：${key}`);
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

// 账号的实际运行配置：账号覆盖 > 全局默认 > 内置默认；数据目录、浏览器配置名与账号名称由面板决定
function resolveAccountConfig(data, account, panelDataDir) {
  return resolveConfig({
    ...data.defaults,
    ...account.overrides,
    dataDir: accountDataDir(panelDataDir, account.id),
    profileName: account.id,
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
  maskValues,
  publicEffectiveConfig,
  publicSchema,
  resolveAccountConfig,
};
