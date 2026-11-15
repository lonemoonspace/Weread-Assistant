const express = require("express");
const { findAccount } = require("../../accounts");
const { statsReport } = require("../../stats");

// 统计页：?account=<账号 ID 或 all>&days=30|90|365
function statsRoutes({ dataDir, store }) {
  const router = express.Router();

  router.get("/stats", (req, res) => {
    const data = store.get();
    const target = typeof req.query.account === "string" && req.query.account ? req.query.account : "all";
    const accounts = target === "all" ? data.accounts : [findAccount(data, target)];
    const report = statsReport(dataDir, accounts, { timezone: data.settings.timezone, days: req.query.days || 30 });
    res.json({
      account: target,
      accounts: data.accounts.map((account) => ({ id: account.id, name: account.name })),
      ...report,
    });
  });

  return router;
}

module.exports = { statsRoutes };
