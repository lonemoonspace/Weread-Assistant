const express = require("express");
const { SUPPORTED_VERSIONS } = require("../../mcp");

/**
 * MCP 的 Streamable HTTP 传输（子路径下的 mcp）：无状态，不发 Mcp-Session-Id，每个 POST 返回一个 JSON 响应，
 * 不提供 SSE 流（GET、DELETE 返回 405）。认证与 api/v1 相同（Authorization: Bearer 令牌）。
 * 带 Origin 请求头时（浏览器发起）只接受与面板同源的，防止 DNS 重绑定。
 */
function mcpRoutes({ mcp, tokenAuth, options }) {
  const router = express.Router();
  const allowedOrigins = new Set();
  if (options.publicUrl) {
    allowedOrigins.add(new URL(options.publicUrl).origin);
  }

  const rpcError = (res, status, code, message, headers = {}) => {
    res.set(headers);
    res.status(status).json({ jsonrpc: "2.0", id: null, error: { code, message } });
  };

  router.use((req, res, next) => {
    res.set("Cache-Control", "no-store");
    const origin = req.get("Origin");
    if (origin && !allowedOrigins.has(origin) && origin !== `${req.protocol}://${req.get("host")}`) {
      rpcError(res, 403, -32600, "不接受这个 Origin 的请求");
      return;
    }
    next();
  });

  router.all("/", (req, res, next) => {
    if (req.method !== "POST") {
      rpcError(res, 405, -32600, "只支持 POST", { Allow: "POST" });
      return;
    }
    next();
  });

  router.use((req, res, next) => tokenAuth(req, res, next, (r, status, error, message) => rpcError(r, status, -32001, message)));

  router.post("/", (req, res, next) => {
    const version = req.get("MCP-Protocol-Version");
    if (version && !SUPPORTED_VERSIONS.includes(version)) {
      rpcError(res, 400, -32600, `不支持的协议版本：${version}`);
      return;
    }
    if (!req.is("application/json")) {
      rpcError(res, 415, -32700, "请求体必须是 JSON");
      return;
    }
    next();
  });

  router.post("/", express.json({ limit: "64kb", inflate: false }), async (req, res) => {
    const batch = Array.isArray(req.body);
    const messages = batch ? req.body : [req.body];
    if (messages.length === 0 || messages.length > 20) {
      rpcError(res, 400, -32600, "批量请求为 1–20 条");
      return;
    }
    const replies = [];
    for (const message of messages) {
      const reply = await mcp.handle(message, req.apiToken);
      if (reply) {
        replies.push(reply);
      }
    }
    // 只有通知与响应时 202，没有响应体
    if (replies.length === 0) {
      res.status(202).end();
      return;
    }
    res.json(batch ? replies : replies[0]);
  });

  // 请求体不是合法的 JSON
  router.use((err, req, res, next) => {
    if (err && err.type === "entity.parse.failed") {
      rpcError(res, 400, -32700, "请求体不是合法的 JSON");
      return;
    }
    next(err);
  });

  return router;
}

module.exports = { mcpRoutes };
