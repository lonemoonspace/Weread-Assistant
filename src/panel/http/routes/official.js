const express = require("express");
const { OfficialApiError, createOfficialApi } = require("../../../official/api");
const { findAccount } = require("../../accounts");
const { resolveAccountConfig } = require("../../config");
const { badRequest } = require("../../errors");

// 微信读书官方 API：用账号配置中的 API Key 访问本人的数据。options.officialApi 供测试替换网关地址
function officialRoutes({ dataDir, store, options }) {
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

  return router;
}

module.exports = { officialRoutes };
