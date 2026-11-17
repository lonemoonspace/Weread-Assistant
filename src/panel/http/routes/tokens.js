const express = require("express");
const { SCOPES } = require("../../tokens");
const { requireRecentAuth } = require("../session");

// API 令牌的管理（面板登录后）：列出、新建（需要近期验证过身份，令牌只在这次响应中返回）、删除
function tokenRoutes({ auth, tokens }) {
  const router = express.Router();
  const recentAuth = requireRecentAuth(auth);

  router.get("/tokens", (req, res) => {
    res.json({ scopes: SCOPES, tokens: tokens.list() });
  });

  router.post("/tokens", recentAuth, async (req, res) => {
    res.status(201).json(await tokens.create(req.body));
  });

  router.delete("/tokens/:id", async (req, res) => {
    await tokens.remove(req.params.id);
    res.status(204).end();
  });

  return router;
}

module.exports = { tokenRoutes };
