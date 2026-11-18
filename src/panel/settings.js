const { coerceFieldValue } = require("../config/resolve");
const { badRequest } = require("./errors");

// 面板自身的全局设置（与单次运行配置分开保存在 panel.json 的 settings 中）
const SETTINGS_FIELDS = [
  {
    key: "timezone",
    type: "string",
    label: "时区",
    description: "调度与按天统计使用的时区，IANA 名称，例如 Asia/Shanghai。",
    default: "Asia/Shanghai",
  },
  {
    key: "maxConcurrentRuns",
    type: "integer",
    label: "同时运行的账号数",
    description: "使用内置浏览器时每个账号单独启动一个浏览器（各约占 600MB 内存）；使用 Selenium 时应与它的 SE_NODE_MAX_SESSIONS 一致。",
    min: 1,
    max: 10,
    default: 1,
  },
  {
    key: "retryCount",
    type: "integer",
    label: "失败重试次数",
    description: "定时、补跑与恢复的运行因出错、超时或子进程异常退出而失败时自动重试的次数，间隔依次为 5、15、30 分钟，只读剩余的分钟；扫码超时与配置无效不重试，手动启动的运行不重试。0 表示不重试。",
    min: 0,
    max: 5,
    default: 2,
  },
  {
    key: "catchupGraceMinutes",
    type: "integer",
    label: "补触发宽限时间（分钟）",
    description: "面板重启后，在这段时间内被中断的定时运行会补读剩余分钟，停机期间错过的调度规则各补触发一次，过期的重试照常执行；超过的只记录日志。0 表示不恢复也不补触发。",
    min: 0,
    max: 720,
    default: 120,
  },
  {
    key: "logRetentionDays",
    type: "integer",
    label: "运行日志保留天数",
    min: 1,
    max: 3650,
    default: 30,
  },
  {
    key: "screenshotRetentionRuns",
    type: "integer",
    label: "截图保留的运行次数",
    description: "只保留最近几次运行的阅读截图，0 表示不保留。",
    min: 0,
    max: 100,
    default: 3,
  },
  {
    key: "notesSyncAt",
    type: "string",
    label: "每天同步笔记的时间",
    description: "填写了微信读书 API Key 的账号，每天到这个时间（HH:MM，面板时区）自动同步一次笔记与划线，写入数据目录的 accounts/<账号>/notes/。",
    default: "04:30",
  },
  {
    key: "weeklyReportAt",
    type: "string",
    label: "每周一发送阅读报告的时间",
    description: "账号配置中开启了“每周阅读报告”并填写了微信读书 API Key 的账号，每周一到这个时间（HH:MM，面板时区）之后推送上周的阅读报告。",
    default: "09:00",
  },
  {
    key: "vncUrl",
    type: "string",
    label: "noVNC 地址",
    description: "使用 Selenium 并开启了它的 noVNC 时填写，在总览与实时页面显示查看浏览器画面的链接；内置浏览器没有画面，留空即可。",
    default: "",
  },
];

const FIELD_BY_KEY = new Map(SETTINGS_FIELDS.map((field) => [field.key, field]));

const DEFAULT_SETTINGS = Object.fromEntries(SETTINGS_FIELDS.map((field) => [field.key, field.default]));

function checkTimezone(field, value) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
  } catch (_) {
    throw badRequest(`${field.label}不是有效的时区：${value}`);
  }
}

function checkHttpUrl(field, value) {
  if (!value) {
    return;
  }
  let url;
  try {
    url = new URL(value);
  } catch (_) {
    throw badRequest(`${field.label}不是有效的地址：${value}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw badRequest(`${field.label}只能是 http 或 https 地址：${value}`);
  }
}

function checkTime(field, value) {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) {
    throw badRequest(`${field.label}格式应为 HH:MM（00:00–23:59）：${value}`);
  }
}

const EXTRA_CHECKS = {
  timezone: checkTimezone,
  vncUrl: checkHttpUrl,
  notesSyncAt: checkTime,
  weeklyReportAt: checkTime,
};

// 按 patch 修改设置并返回新对象；值为 null 时恢复默认值
function applySettingsPatch(current, patch) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    throw badRequest("settings 必须是对象");
  }
  const next = { ...DEFAULT_SETTINGS, ...current };
  for (const [key, rawValue] of Object.entries(patch)) {
    const field = FIELD_BY_KEY.get(key);
    if (!field) {
      throw badRequest(`未知的设置项：${key}`);
    }
    if (rawValue === null) {
      next[key] = field.default;
      continue;
    }
    let value;
    try {
      value = coerceFieldValue(field, rawValue, field.label);
    } catch (e) {
      throw badRequest(e.message);
    }
    if (EXTRA_CHECKS[key]) {
      EXTRA_CHECKS[key](field, value);
    }
    next[key] = value;
  }
  return next;
}

// 校验 panel.json 中保存的设置（可能被手工改坏）：取值无效的项恢复默认值。返回 { settings, invalid }，
// invalid 为恢复了默认值的设置项。避免无效时区让账号接口全部出错、并发数为 0 让运行一直排队
function sanitizeSettings(stored) {
  const settings = { ...DEFAULT_SETTINGS, ...stored };
  const invalid = [];
  for (const field of SETTINGS_FIELDS) {
    try {
      const value = coerceFieldValue(field, settings[field.key], field.label);
      if (EXTRA_CHECKS[field.key]) {
        EXTRA_CHECKS[field.key](field, value);
      }
      settings[field.key] = value;
    } catch (_) {
      invalid.push(field.key);
      settings[field.key] = field.default;
    }
  }
  return { settings, invalid };
}

module.exports = {
  DEFAULT_SETTINGS,
  SETTINGS_FIELDS,
  applySettingsPatch,
  sanitizeSettings,
};
