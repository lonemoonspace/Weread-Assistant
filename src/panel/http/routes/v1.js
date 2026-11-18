const express = require("express");

/**
 * api/v1：用 API 令牌访问的接口，供脚本、快捷指令与自动化使用（MCP 见 routes/mcp.js）。
 * 认证用 Authorization: Bearer <令牌>，不使用 cookie，因此不需要面板的自定义请求头；只接受 JSON 请求体。
 * 能做的事由令牌的权限（scopes）与能访问的账号决定，见 src/panel/agent.js
 */
function v1Routes({ agent, tokenAuth }) {
  const router = express.Router();
  router.use((req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });
  router.use((req, res, next) => tokenAuth(req, res, next, (r, status, error, message) => r.status(status).json({ error, message })));
  router.use(express.json({ limit: "10kb", inflate: false }));

  const markdown = (res, text) => {
    res.type("text/markdown; charset=utf-8");
    res.send(text);
  };

  router.get("/me", (req, res) => res.json(agent.whoami(req.apiToken)));
  router.get("/accounts", (req, res) => res.json(agent.listAccounts(req.apiToken)));
  router.get("/accounts/:id", (req, res) => res.json(agent.accountStatus(req.apiToken, req.params.id)));
  router.get("/accounts/:id/runs", (req, res) => res.json(agent.recentRuns(req.apiToken, req.params.id, { limit: req.query.limit || 10 })));
  router.post("/accounts/:id/runs", (req, res) => {
    const mode = req.body && typeof req.body === "object" && req.body.mode !== undefined ? req.body.mode : "read";
    res.status(202).json(agent.startRun(req.apiToken, req.params.id, { mode }));
  });
  router.post("/accounts/:id/stop", (req, res) => res.status(202).json(agent.stopRun(req.apiToken, req.params.id)));
  router.get("/accounts/:id/notes", (req, res) => res.json(agent.notesStatus(req.apiToken, req.params.id)));
  router.post("/accounts/:id/notes/sync", (req, res) => res.status(202).json(agent.syncNotes(req.apiToken, req.params.id)));
  router.get("/accounts/:id/notes/search", (req, res) => res.json(agent.searchNotes(req.apiToken, req.params.id, req.query.q)));
  router.get("/accounts/:id/notes/markdown", (req, res) => markdown(res, agent.notesMarkdown(req.apiToken, req.params.id)));
  router.get("/accounts/:id/notes/books/:bookId", (req, res) => res.json(agent.notesBook(req.apiToken, req.params.id, req.params.bookId)));
  router.get("/accounts/:id/notes/books/:bookId/markdown", (req, res) =>
    markdown(res, agent.notesMarkdown(req.apiToken, req.params.id, req.params.bookId))
  );
  router.get("/accounts/:id/reports/weekly", async (req, res) => res.json(await agent.weeklyReport(req.apiToken, req.params.id)));
  router.use((req, res) => res.status(404).json({ error: "not_found", message: "接口不存在" }));
  return router;
}

module.exports = { v1Routes };
