const path = require("path");
const { CONFIG_GROUPS, CONFIG_SCHEMA } = require("../config/schema");
const { coerceFieldValue, resolveConfig } = require("../config/resolve");
const { badRequest } = require("./errors");
const { SETTINGS_FIELDS } = require("./settings");

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

function maskValues(values) {
  const masked = {};
  for (const [key, value] of Object.entries(values)) {
    const field = FIELD_BY_KEY.get(key);
    if (!field) {
      continue;
    }
    masked[key] = field.secret && value ? SECRET_MASK : value;
  }
  return masked;
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

function accountDataDir(panelDataDir, accountId) {
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
  accountDataDir,
  applyConfigPatch,
  maskValues,
  publicEffectiveConfig,
  publicSchema,
  resolveAccountConfig,
};
