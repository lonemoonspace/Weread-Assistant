const fs = require("fs");
const express = require("express");
const { OfficialApiError, createOfficialApi } = require("../../../official/api");
const { findAccount } = require("../../accounts");
const { resolveAccountConfig } = require("../../config");
const { PanelError, badRequest } = require("../../errors");
const { safeFileName } = require("../../notes");

// 微信读书官方 API：用账号配置中的 API Key 访问本人的数据。options.officialApi 供测试替换网关地址
function officialRoutes({ dataDir, store, options, notes }) {
  const router = express.Router();

  // 账号的官方 API 客户端；没有配置 API Key 时 400
  function apiFor(accountId) {
    const data = store.get();
    const account = findAccount(data, accountId);
    const config = resolveAccountConfig(data, account, dataDir);
    if (!config.wereadApiKey) {
      throw badRequest("这个账号还没有配置微信读书 API Key（账号配置 →「微信读书 API」）");
    }
    try {
      return createOfficialApi({ apiKey: config.wereadApiKey, ...(options.officialApi || {}) });
    } catch (e) {
      throw badRequest(e.message);
    }
  }

  // 测试 API Key：读取笔记本概览的第一页，返回有笔记的书数与笔记总数
  router.post("/accounts/:id/official/test", async (req, res) => {
    const api = apiFor(req.params.id);
    try {
      const body = await api.call("/user/notebooks", { count: 1 });
      res.json({
        ok: true,
        totalBookCount: Number(body.totalBookCount) || 0,
        totalNoteCount: Number(body.totalNoteCount) || 0,
        upgradeInfo: body.upgrade_info ? String(body.upgrade_info.message || body.upgrade_info.msg || "").slice(0, 200) : "",
      });
    } catch (e) {
      if (!(e instanceof OfficialApiError)) {
        throw e;
      }
      console.warn(`测试微信读书 API Key 失败：账号 ${req.params.id}：${e.message}`);
      res.json({ ok: false, kind: e.kind, error: e.message });
    }
  });

  // 笔记：同步状态与有笔记的书
  router.get("/accounts/:id/notes", (req, res) => {
    findAccount(store.get(), req.params.id);
    res.json(notes.status(req.params.id));
  });

  // 立即同步笔记：在后台进行，返回 202 与当前状态；已经在同步时同样返回 202
  router.post("/accounts/:id/notes/sync", (req, res) => {
    findAccount(store.get(), req.params.id);
    if (!notes.status(req.params.id).configured) {
      throw badRequest("这个账号还没有配置微信读书 API Key（账号配置 →「微信读书 API」）");
    }
    notes.sync(req.params.id, { trigger: "manual" }).catch(() => {});
    res.status(202).json(notes.status(req.params.id));
  });

  // 一本书的笔记：按章节整理的划线与想法
  router.get("/accounts/:id/notes/books/:bookId", (req, res) => {
    findAccount(store.get(), req.params.id);
    const result = notes.book(req.params.id, req.params.bookId);
    if (!result) {
      throw new PanelError(404, "not_found", "没有这本书的笔记");
    }
    res.json(result);
  });

  // 搜索划线与想法
  router.get("/accounts/:id/notes/search", (req, res) => {
    findAccount(store.get(), req.params.id);
    const query = typeof req.query.q === "string" ? req.query.q : "";
    if (query.length > 100) {
      throw badRequest("搜索内容不能超过 100 个字");
    }
    res.json(notes.search(req.params.id, query));
  });

  // 下载 Markdown：一本书，或全部书合成一份
  router.get("/accounts/:id/notes/books/:bookId/markdown", (req, res) => {
    findAccount(store.get(), req.params.id);
    const file = notes.markdownOf(req.params.id, req.params.bookId);
    if (!file) {
      throw new PanelError(404, "not_found", "没有这本书的 Markdown");
    }
    res.attachment(file.name);
    res.type("text/markdown; charset=utf-8");
    res.send(fs.readFileSync(file.file, "utf8"));
  });

  router.get("/accounts/:id/notes/markdown", (req, res) => {
    const account = findAccount(store.get(), req.params.id);
    const markdown = notes.allMarkdown(req.params.id);
    if (!markdown) {
      throw new PanelError(404, "not_found", "还没有同步过笔记");
    }
    res.attachment(`${safeFileName(account.name)}的笔记.md`);
    res.type("text/markdown; charset=utf-8");
    res.send(markdown);
  });

  return router;
}

module.exports = { officialRoutes };
