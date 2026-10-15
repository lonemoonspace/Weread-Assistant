const { CONFIG_SCHEMA } = require("./schema");

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

function parseIntegerValue(value, name) {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed)) {
    throw new Error(`${name} must be an integer`);
  }
  return parsed;
}

function coerceValue(field, rawValue) {
  if (rawValue === undefined || rawValue === null || rawValue === "") {
    return field.default;
  }

  switch (field.type) {
    case "boolean":
      return parseBooleanValue(rawValue, field.default, false);
    case "integer":
      return parseIntegerValue(rawValue, field.env || field.key);
    default:
      return String(rawValue);
  }
}

// 按配置项清单补齐默认值并转换类型，返回不可变的运行配置
function resolveConfig(values = {}) {
  const config = {};
  for (const field of CONFIG_SCHEMA) {
    config[field.key] = coerceValue(field, values[field.key]);
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
  configFromEnv,
  parseBooleanValue,
  parseIntegerValue,
  resolveConfig,
};
