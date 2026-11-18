const { postJson } = require("../shared/http");

/**
 * 微信读书官方 API（“微信读书 Skill”）的客户端：只读，按用户自己的 API Key（wrk-…）访问本人的数据。
 * 统一入口为 POST GATEWAY_URL，Authorization: Bearer <key>，JSON 中 api_name 指定接口，业务参数平铺在顶层，
 * 每次带上 skill_version；回包 errcode 非 0 为出错。接口说明见 https://github.com/Tencent/WeChatReading 的 skills/
 */

const GATEWAY_URL = "https://i.weread.qq.com/api/agent/gateway";
// 按这个版本的接口说明实现；服务端只据此提示升级（upgrade_info），不影响回包
const SKILL_VERSION = "1.0.6";
// 官方只说明格式为 wrk-xxxxxxxx：只检查前缀与长度，不限定字符
const API_KEY_PATTERN = /^wrk-[!-~]{8,200}$/;
const DEFAULT_TIMEOUT_MS = 20000;
// 一本书的划线与想法可能有几千条
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
// 网关偶尔返回 499（上游超时）：等一会儿重试
const RETRY_STATUSES = [499, 502, 503, 504];
const RETRY_DELAY_MS = 2000;
const MAX_ATTEMPTS = 3;

class OfficialApiError extends Error {
  // kind：key（API Key 无效或过期）、network（连接、超时、5xx）、api（接口返回 errcode）、format（回包不是 JSON）
  constructor(kind, message, { status = 0, errcode = 0 } = {}) {
    super(message);
    this.name = "OfficialApiError";
    this.kind = kind;
    this.status = status;
    this.errcode = errcode;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function maskKey(text, apiKey) {
  return apiKey ? String(text).split(apiKey).join("wrk-••••••") : String(text);
}

// apiKey：用户的 API Key；gatewayUrl、post、retryDelayMs 供测试替换
function createOfficialApi({ apiKey, gatewayUrl = GATEWAY_URL, timeoutMs = DEFAULT_TIMEOUT_MS, post = postJson, retryDelayMs = RETRY_DELAY_MS }) {
  if (!API_KEY_PATTERN.test(String(apiKey || ""))) {
    throw new OfficialApiError("key", "没有配置微信读书 API Key，或格式不对（应为 wrk-…）");
  }

  async function call(apiName, params = {}) {
    const payload = { ...params, api_name: apiName, skill_version: SKILL_VERSION };
    for (let attempt = 1; ; attempt += 1) {
      const result = await post(gatewayUrl, payload, { Authorization: `Bearer ${apiKey}` }, timeoutMs, { maxBytes: MAX_RESPONSE_BYTES });
      const retryable = result.status === 0 || RETRY_STATUSES.includes(result.status);
      if (!result.ok && retryable && attempt < MAX_ATTEMPTS) {
        await sleep(retryDelayMs * attempt);
        continue;
      }
      if (result.status === 401 || result.status === 403) {
        throw new OfficialApiError("key", `API Key 无效或已失效（HTTP ${result.status}），请在微信读书网页版重新获取`, { status: result.status });
      }
      if (!result.ok) {
        const reason = result.status ? `HTTP ${result.status}` : maskKey(result.error || "请求失败", apiKey);
        throw new OfficialApiError("network", `请求微信读书接口 ${apiName} 失败：${reason}`, { status: result.status });
      }
      let body;
      try {
        body = JSON.parse(result.body);
      } catch (_) {
        throw new OfficialApiError("format", `微信读书接口 ${apiName} 的回包不是 JSON`, { status: result.status });
      }
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        throw new OfficialApiError("format", `微信读书接口 ${apiName} 的回包格式不对`, { status: result.status });
      }
      const errcode = Number(body.errcode || 0);
      if (errcode !== 0) {
        const message = maskKey(body.errmsg || body.msg || body.message || "未知错误", apiKey).slice(0, 200);
        // 鉴权失败的错误码官方没有列出：按提示文字判断
        const kind = /key|token|鉴权|授权|登录|auth/i.test(message) ? "key" : "api";
        throw new OfficialApiError(kind, `微信读书接口 ${apiName} 出错（${errcode}）：${message}`, { status: result.status, errcode });
      }
      return body;
    }
  }

  return { call };
}

module.exports = {
  API_KEY_PATTERN,
  GATEWAY_URL,
  OfficialApiError,
  SKILL_VERSION,
  createOfficialApi,
};
