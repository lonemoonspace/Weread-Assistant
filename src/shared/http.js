const https = require("https");
const http = require("http");

const DEFAULT_POST_TIMEOUT_MS = 15000;
// 响应体上限：这里的请求只读取 Selenium 状态、推送接口结果等小型响应
const MAX_RESPONSE_BYTES = 1024 * 1024;

function isHttpUrl(str) {
  try {
    const u = new URL(str);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch (_) {
    return false;
  }
}

// 读取响应体：超过 MAX_RESPONSE_BYTES 或响应中途断开（此时没有 end 事件）时以错误结束
function readBody(res, onDone) {
  const chunks = [];
  let size = 0;
  let done = false;
  const finish = (error, body) => {
    if (!done) {
      done = true;
      onDone(error, body);
    }
  };
  res.on("data", (chunk) => {
    size += chunk.length;
    if (size > MAX_RESPONSE_BYTES) {
      finish(new Error(`response larger than ${MAX_RESPONSE_BYTES} bytes`));
      res.destroy();
      return;
    }
    chunks.push(chunk);
  });
  res.on("end", () => finish(null, Buffer.concat(chunks).toString("utf8")));
  res.on("error", (error) => finish(error));
  res.on("close", () => finish(new Error("response aborted")));
}

// timeoutMs 是整个请求（连接、等待响应与读取响应体）的时限：
// 请求的 timeout 选项只在连接空闲时触发，对端持续缓慢发送数据时永远不会超时
async function fetchJson(url, timeoutMs = 3000) {
  return await new Promise((resolve, reject) => {
    const client = url.startsWith("https:") ? https : http;
    let settled = false;
    let timer = null;
    const fail = (error) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(error);
        req.destroy();
      }
    };
    const req = client.get(url, (res) => {
      readBody(res, (error, data) => {
        if (error) {
          fail(error);
          return;
        }
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        try {
          resolve({ statusCode: res.statusCode, body: JSON.parse(data || "{}") });
        } catch (e) {
          resolve({ statusCode: res.statusCode, body: data });
        }
      });
    });
    timer = setTimeout(() => fail(new Error("request timeout")), timeoutMs);
    req.on("error", fail);
  });
}

// 统一的 JSON POST 请求，供各推送渠道复用
function postJson(urlString, payload, extraHeaders = {}, timeoutMs = DEFAULT_POST_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let urlObj;
    try {
      urlObj = new URL(urlString);
    } catch (error) {
      // 地址中可能带有密钥（如 Bark Key），错误信息中不回显
      resolve({ ok: false, status: 0, body: "", error: "invalid url" });
      return;
    }

    const httpModule = urlObj.protocol === "https:" ? https : http;
    const jsonData = JSON.stringify(payload);
    let settled = false;
    let timer = null;
    const finish = (result) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    let req;
    try {
      req = httpModule.request({
        hostname: urlObj.hostname,
        port: urlObj.port || (urlObj.protocol === "https:" ? 443 : 80),
        path: `${urlObj.pathname}${urlObj.search}`,
        method: "POST",
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Content-Length": Buffer.byteLength(jsonData),
          "User-Agent": "WeRead-Tracker/1.0",
          ...extraHeaders,
        },
      }, (res) => {
        readBody(res, (error, responseData) => {
          if (error) {
            finish({ ok: false, status: res.statusCode, body: "", error: error.message });
            req.destroy();
            return;
          }
          finish({
            ok: res.statusCode >= 200 && res.statusCode < 300,
            status: res.statusCode,
            body: responseData,
            error: "",
          });
        });
      });
    } catch (error) {
      finish({ ok: false, status: 0, body: "", error: error.message });
      return;
    }

    // 与 fetchJson 相同，timeoutMs 是整个请求的时限
    timer = setTimeout(() => {
      finish({ ok: false, status: 0, body: "", error: `request timeout after ${timeoutMs}ms` });
      req.destroy();
    }, timeoutMs);

    req.on("error", (error) => {
      finish({ ok: false, status: 0, body: "", error: error.message });
    });

    req.write(jsonData);
    req.end();
  });
}

module.exports = {
  fetchJson,
  isHttpUrl,
  postJson,
};
