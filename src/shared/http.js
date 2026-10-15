const https = require("https");
const http = require("http");

const DEFAULT_POST_TIMEOUT_MS = 15000;

function isHttpUrl(str) {
  try {
    const u = new URL(str);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch (_) {
    return false;
  }
}

async function fetchJson(url, timeoutMs = 3000) {
  return await new Promise((resolve, reject) => {
    const client = url.startsWith("https:") ? https : http;
    const req = client.get(url, { timeout: timeoutMs }, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          resolve({ statusCode: res.statusCode, body: JSON.parse(data || "{}") });
        } catch (e) {
          resolve({ statusCode: res.statusCode, body: data });
        }
      });
    });
    req.on("timeout", () => {
      req.destroy(new Error("request timeout"));
    });
    req.on("error", reject);
  });
}

// 统一的 JSON POST 请求，供各推送渠道复用
function postJson(urlString, payload, extraHeaders = {}, timeoutMs = DEFAULT_POST_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let urlObj;
    try {
      urlObj = new URL(urlString);
    } catch (error) {
      resolve({ ok: false, status: 0, body: "", error: `invalid url: ${urlString}` });
      return;
    }

    const httpModule = urlObj.protocol === "https:" ? https : http;
    const jsonData = JSON.stringify(payload);
    let settled = false;
    const finish = (result) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(result);
    };

    let req;
    try {
      req = httpModule.request({
        hostname: urlObj.hostname,
        port: urlObj.port || (urlObj.protocol === "https:" ? 443 : 80),
        path: `${urlObj.pathname}${urlObj.search}`,
        method: "POST",
        timeout: timeoutMs,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Content-Length": Buffer.byteLength(jsonData),
          "User-Agent": "WeRead-Tracker/1.0",
          ...extraHeaders,
        },
      }, (res) => {
        let responseData = "";
        res.on("data", (chunk) => { responseData += chunk; });
        res.on("end", () => {
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

    req.on("timeout", () => {
      req.destroy();
      finish({ ok: false, status: 0, body: "", error: `request timeout after ${timeoutMs}ms` });
    });

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
