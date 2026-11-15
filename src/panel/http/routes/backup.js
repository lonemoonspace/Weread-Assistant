const express = require("express");
const { applyImport, backupFileName, buildBackup, openBackup, planImport } = require("../../backup");
const { badRequest, requireObject } = require("../../errors");
const { requireRecentAuth } = require("../session");

// 导入接口的请求体上限：其他接口为 10KB，备份文件（含 cookies）可能大一些。
// 面板的通用 JSON 解析跳过这个路径，这里在鉴权之后才解析，未登录的请求不会让面板解析 2MB 的请求体
const BACKUP_IMPORT_PATH = "/backup/import";
const importJson = express.json({ limit: "2mb", inflate: false });

const describeCounts = (preview) => {
  const count = (action) => preview.accounts.filter((entry) => entry.action === action).length;
  return `新增 ${count("add")} 个账号，覆盖 ${count("overwrite")} 个，跳过 ${count("skip")} 个，移除 ${preview.removed.length} 个，无效条目 ${preview.invalid.length} 个`;
};

// 配置备份：导出与导入（先预览再应用）。都要求 5 分钟内登录或二次验证过
function backupRoutes({ dataDir, auth, store, runner }) {
  const router = express.Router();
  const recentAuth = requireRecentAuth(auth);

  // { includeSecrets?, includeCookies?, passphrase? }：返回备份文件（JSON），包含密钥或登录状态时需要备份密码
  router.post("/backup/export", recentAuth, async (req, res) => {
    const body = requireObject(req.body || {});
    const unknown = Object.keys(body).filter((key) => !["includeSecrets", "includeCookies", "passphrase"].includes(key));
    if (unknown.length > 0) {
      throw badRequest(`不支持的字段：${unknown.join(", ")}`);
    }
    for (const key of ["includeSecrets", "includeCookies"]) {
      if (body[key] !== undefined && typeof body[key] !== "boolean") {
        throw badRequest(`${key} 必须是 true 或 false`);
      }
    }
    const now = new Date();
    const backup = await buildBackup(store.get(), {
      dataDir,
      includeSecrets: body.includeSecrets === true,
      includeCookies: body.includeCookies === true,
      passphrase: body.passphrase,
      now,
    });
    console.info(`已导出配置备份（${backup.secretsIncluded ? "含" : "不含"}密钥，${backup.cookiesIncluded ? "含" : "不含"}登录状态）`);
    res.set("Content-Disposition", `attachment; filename="${backupFileName(now)}"`);
    res.json(backup);
  });

  // { mode: "preview" | "apply", backup, passphrase?, options? }：preview 只返回将要发生的变化，不写入；
  // apply 先把 panel.json 另存一份，再一次写入全部变化
  router.post(BACKUP_IMPORT_PATH, recentAuth, importJson, async (req, res) => {
    const body = requireObject(req.body);
    const unknown = Object.keys(body).filter((key) => !["mode", "backup", "passphrase", "options"].includes(key));
    if (unknown.length > 0) {
      throw badRequest(`不支持的字段：${unknown.join(", ")}`);
    }
    if (body.mode !== "preview" && body.mode !== "apply") {
      throw badRequest("mode 只能是 preview 或 apply");
    }
    const backup = await openBackup(body.backup, body.passphrase || "");
    const isBusy = (accountId) => runner.isActive(accountId);
    if (body.mode === "preview") {
      res.json({ preview: planImport(store.get(), backup, body.options || {}, { isBusy }).preview });
      return;
    }
    const { preview, copy } = await applyImport(store, dataDir, backup, body.options || {}, { isBusy });
    console.info(`已导入配置备份：${describeCounts(preview)}；导入前的 panel.json 另存为 ${copy}`);
    res.json({ preview, applied: true, copy });
  });

  return router;
}

module.exports = {
  BACKUP_IMPORT_PATH,
  backupRoutes,
};
