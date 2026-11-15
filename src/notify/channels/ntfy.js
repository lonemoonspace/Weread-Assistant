const { isHttpUrl, postJson } = require("../../shared/http");
const { CHANNEL_TIMEOUT_MS, failure, httpFailure, success } = require("./common");

// ntfy 的 JSON 发布接口（POST /）将 priority 定义为 int，字符串别名只对 X-Priority 请求头有效，
// 写进 JSON body 会导致整个负载解析失败（400 {"code":40024,"error":"invalid request: request body must be valid JSON"}），
// 因此这里必须映射为 1-5 的数字
const NTFY_LEVEL_PRIORITY = {
  passive: 2,
  active: 3,
  timeSensitive: 4,
  critical: 5,
};
const NTFY_SOUND_TAGS = {
  alarm: "rotating_light",
  birdsong: "bell",
  success: "tada",
  beginning: "rocket",
};
const NTFY_TOPIC_PATTERN = /^[-_A-Za-z0-9]{1,64}$/;

// 统一把优先级归一化为 1-5 的数字；ntfy 的 JSON body 只接受数字形式的 priority
const NTFY_PRIORITY_ALIAS_VALUES = {
  min: 1,
  low: 2,
  default: 3,
  high: 4,
  urgent: 5,
  max: 5,
};
const NTFY_DEFAULT_PRIORITY = 3;

function isNtfyConfigured(config) {
  return Boolean(config.ntfyTopic);
}

function normalizeNtfyPriority(rawValue, fallback = NTFY_DEFAULT_PRIORITY) {
  const value = String(rawValue === undefined || rawValue === null ? "" : rawValue).trim().toLowerCase();
  if (!value) {
    return fallback;
  }
  if (Object.prototype.hasOwnProperty.call(NTFY_PRIORITY_ALIAS_VALUES, value)) {
    return NTFY_PRIORITY_ALIAS_VALUES[value];
  }
  // 只接受 1-5 的整数本身：parseInt 会把 "3abc"、"2.9" 也当作合法值
  if (/^[1-5]$/.test(value)) {
    return Number(value);
  }
  console.warn(`ntfy 优先级无效: ${rawValue}，回退为 ${fallback}`);
  return fallback;
}

function resolveNtfyPriority(config, level, overridePriority) {
  if (overridePriority) {
    return normalizeNtfyPriority(overridePriority);
  }
  if (config.ntfyPriority) {
    return normalizeNtfyPriority(config.ntfyPriority);
  }
  const mapped = NTFY_LEVEL_PRIORITY[level];
  return mapped === undefined ? NTFY_DEFAULT_PRIORITY : mapped;
}

function resolveNtfyTags(config, sound, overrideTags) {
  const rawTags = overrideTags || config.ntfyTags;
  if (rawTags) {
    const list = Array.isArray(rawTags) ? rawTags : String(rawTags).split(",");
    return list.map((tag) => String(tag).trim()).filter(Boolean);
  }
  const mappedTag = NTFY_SOUND_TAGS[sound];
  return mappedTag ? [mappedTag] : [];
}

function getNtfyAuthHeaders(config) {
  if (config.ntfyToken) {
    return { Authorization: `Bearer ${config.ntfyToken}` };
  }
  if (config.ntfyUsername) {
    const credentials = Buffer.from(`${config.ntfyUsername}:${config.ntfyPassword}`, "utf8").toString("base64");
    return { Authorization: `Basic ${credentials}` };
  }
  return {};
}

function buildNtfyPublishUrl(server) {
  const base = String(server || "https://ntfy.sh").trim().replace(/\/+$/, "");
  return `${base}/`;
}

// 发送一条 ntfy 推送，返回 { ok, error }
async function pushNtfy(config, title, body, options = {}) {
  if (!config.ntfyTopic) {
    console.info("ntfy 主题未配置");
    return failure("没有填写 ntfy 主题");
  }

  // ntfy 的 topic 等价于密码，只允许字母、数字、下划线与短横线
  if (!NTFY_TOPIC_PATTERN.test(config.ntfyTopic)) {
    // 不打印主题本身：它等同于密钥
    console.error(`ntfy 主题不合法（${config.ntfyTopic.length} 个字符）：仅支持字母、数字、下划线与短横线，且不超过 64 个字符`);
    return failure("ntfy 主题不合法：只能包含字母、数字、下划线与短横线，且不超过 64 个字符");
  }
  if (!isHttpUrl(buildNtfyPublishUrl(config.ntfyServer))) {
    console.error("ntfy 服务器地址无效（需以 http:// 或 https:// 开头）:", config.ntfyServer);
    return failure("ntfy 服务器地址无效（需以 http:// 或 https:// 开头）");
  }

  const {
    subtitle = "",
    sound = "alarm",
    icon = "",
    url = "",
    image = "",
    level = "active",
    priority = "",
    tags = "",
    markdown = false,
    actions = [],
    timeoutMs = CHANNEL_TIMEOUT_MS,
  } = options;

  const payload = {
    topic: config.ntfyTopic,
    message: body,
    priority: resolveNtfyPriority(config, level, priority),
  };

  const titleText = subtitle ? `${title} · ${subtitle}` : title;
  if (titleText) {
    payload.title = titleText;
  }

  const tagList = resolveNtfyTags(config, sound, tags);
  if (tagList.length) {
    payload.tags = tagList;
  }

  if (url) {
    payload.click = url;
  }
  if (image) {
    payload.attach = image;
  }
  if (icon) {
    payload.icon = icon;
  }
  if (markdown) {
    payload.markdown = true;
  }
  if (Array.isArray(actions) && actions.length) {
    payload.actions = actions;
  }

  const publishUrl = buildNtfyPublishUrl(config.ntfyServer);
  console.info("发送ntfy推送:", publishUrl);

  const result = await postJson(publishUrl, payload, getNtfyAuthHeaders(config), timeoutMs);
  if (result.ok) {
    console.info("ntfy推送发送成功");
    return success();
  }
  const reason = httpFailure(config, result);
  console.error("ntfy推送失败:", reason);
  return failure(reason);
}

// 兼容旧的调用方式：返回是否发送成功
async function sendNtfy(config, title, body, options = {}) {
  return (await pushNtfy(config, title, body, options)).ok;
}

const ntfyChannel = {
  id: "ntfy",
  label: "ntfy",
  toggle: "ntfyEnabled",
  isConfigured: isNtfyConfigured,
  send: (config, message) =>
    pushNtfy(config, message.title, message.body, {
      subtitle: message.subtitle,
      level: message.level,
      sound: message.sound,
      url: message.url,
      actions: message.actions,
    }),
};

module.exports = {
  isNtfyConfigured,
  normalizeNtfyPriority,
  ntfyChannel,
  pushNtfy,
  sendNtfy,
};
