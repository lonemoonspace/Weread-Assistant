const { CONFIG_SCHEMA } = require("./schema");

const INTEGER_PATTERN = /^[+-]?\d+$/;

function parseBooleanValue(value, defaultValue = false, strict = false) {
  if (value === undefined || value === null || value === "") {
    return defaultValue;
  }

  if (typeof value === "boolean") {
    return value;
  }

  const normalized = String(value).trim().toLowerCase();
  if (["true", "1", "yes", "y", "on"].includes(normalized)) {
    return true;
  }
  if (["false", "0", "no", "n", "off"].includes(normalized)) {
    return false;
  }

  if (!strict) {
    return defaultValue;
  }

  throw new Error(`Invalid boolean value: ${value}`);
}

// 只接受完整的十进制整数，"10abc" 这类带后缀的值视为错误
function parseIntegerValue(value, name) {
  const text = String(value).trim();
  if (!INTEGER_PATTERN.test(text)) {
    throw new Error(`${name} 必须是整数：${value}`);
  }
  return Number.parseInt(text, 10);
}

function checkRange(field, name, value, rawValue) {
  const hasMin = field.min !== undefined;
  const hasMax = field.max !== undefined;
  if ((hasMin && value < field.min) || (hasMax && value > field.max)) {
    const range = hasMin && hasMax
      ? `在 ${field.min}–${field.max} 之间`
      : hasMin ? `不小于 ${field.min}` : `不大于 ${field.max}`;
    throw new Error(`${name} 必须${range}：${rawValue}`);
  }
}

// 把单个配置项转换为对应类型并校验；name 用于错误提示，默认使用环境变量名
function coerceFieldValue(field, rawValue, name = field.env || field.key) {
  if (rawValue === undefined || rawValue === null || rawValue === "") {
    return field.default;
  }

  let value;
  switch (field.type) {
    case "boolean":
      try {
        value = parseBooleanValue(rawValue, field.default, true);
      } catch (_) {
        throw new Error(`${name} 只能是 true 或 false：${rawValue}`);
      }
      break;
    case "integer":
      value = parseIntegerValue(rawValue, name);
      checkRange(field, name, value, rawValue);
      break;
    default:
      value = String(rawValue);
  }

  if (field.options && !field.options.some((option) => option.value === value)) {
    const allowed = field.options.map((option) => option.value).join("、");
    throw new Error(`${name} 只能是 ${allowed}：${rawValue}`);
  }
  return value;
}

// 按配置项清单补齐默认值、转换类型并校验取值，返回不可变的运行配置；取值非法时抛出错误
function resolveConfig(values = {}) {
  const config = {};
  for (const field of CONFIG_SCHEMA) {
    config[field.key] = coerceFieldValue(field, values[field.key]);
  }
  return Object.freeze(config);
}

function configFromEnv(env = process.env) {
  const values = {};
  for (const field of CONFIG_SCHEMA) {
    values[field.key] = env[field.env];
  }
  return resolveConfig(values);
}

module.exports = {
  coerceFieldValue,
  configFromEnv,
  parseBooleanValue,
  parseIntegerValue,
  resolveConfig,
};
