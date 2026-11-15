const express = require("express");
const { resolveConfig } = require("../../../config/resolve");
const { sendTestNotification } = require("../../../notify");
const { createSeleniumChecker, displaySeleniumUrl, normalizeSeleniumUrl } = require("../../../shared/selenium");
const { applyConfigPatch, maskValues, publicSchema, resolveAccountConfig } = require("../../config");
const { PanelError, badRequest, requireObject } = require("../../errors");
const { findAccount } = require("../../accounts");
const { applySettingsPatch } = require("../../settings");

// 配置定义、面板设置与全局默认配置、测试通知、Selenium 状态
function settingsRoutes({ options, dataDir, store, runner, checkLocalBrowser }) {
  const settingsView = (data) => ({ settings: data.settings, defaults: maskValues(data.defaults) });
  const checkSelenium = createSeleniumChecker({ timeoutMs: options.seleniumTimeoutMs });
  const router = express.Router();

  router.get("/schema", (req, res) => {
    res.json(publicSchema());
  });

  router.get("/settings", (req, res) => {
    res.json(settingsView(store.get()));
  });

  // { settings?, defaults? }：settings 为面板设置，defaults 为全局默认运行配置
  router.patch("/settings", async (req, res) => {
    const body = requireObject(req.body);
    const data = await store.update((draft) => {
      if (body.settings !== undefined) {
        draft.settings = applySettingsPatch(draft.settings, body.settings);
      }
      if (body.defaults !== undefined) {
        draft.defaults = applyConfigPatch(draft.defaults, body.defaults);
      }
    });
    // 调大并发数后立即启动排队中的运行
    runner.pump();
    res.json(settingsView(data));
  });

  // { accountId? }：按账号的实际配置（不提供时按全局默认配置）向已配置的渠道各发送一条测试通知
  router.post("/notifications/test", async (req, res) => {
    const body = req.body === undefined ? {} : requireObject(req.body);
    const data = store.get();
    let config;
    try {
      config = body.accountId
        ? resolveAccountConfig(data, findAccount(data, String(body.accountId)), dataDir)
        : resolveConfig(data.defaults);
    } catch (e) {
      if (e instanceof PanelError) {
        throw e;
      }
      throw badRequest(`配置无效：${e.message}`);
    }
    res.json({ results: await sendTestNotification(config) });
  });

  // Selenium 的状态与会话数：全局默认配置与各账号实际使用的 Selenium 地址各查询一次；地址为空表示内置浏览器（builtin）。
  // accounts 为使用该地址的账号，panelRuns 为面板在该地址上已启动的运行数（每个占用一个会话）
  router.get("/selenium/status", async (req, res) => {
    const data = store.get();
    const servers = new Map();
    const serverFor = (url) => {
      const key = url ? normalizeSeleniumUrl(url) : "";
      if (!servers.has(key)) {
        servers.set(key, { key, url: key && displaySeleniumUrl(key), builtin: !key, isDefault: false, accounts: [], panelRuns: 0 });
      }
      return servers.get(key);
    };
    try {
      serverFor(resolveConfig(data.defaults).seleniumUrl).isDefault = true;
    } catch (_) {
      // 全局默认配置无效时只列出各账号使用的地址
    }
    for (const account of data.accounts) {
      let config;
      try {
        config = resolveAccountConfig(data, account, dataDir);
      } catch (_) {
        // 配置无效的账号无法运行，不列出
        continue;
      }
      serverFor(config.seleniumUrl).accounts.push({ id: account.id, name: account.name });
    }
    for (const url of runner.seleniumUrls()) {
      serverFor(url).panelRuns += 1;
    }
    const results = await Promise.all(
      [...servers.values()].map(async ({ key, ...server }) => ({
        ...server,
        ...(await (key ? checkSelenium(key) : checkLocalBrowser())),
      }))
    );
    res.json({
      checkedAt: new Date().toISOString(),
      maxConcurrentRuns: data.settings.maxConcurrentRuns,
      servers: results,
    });
  });

  return router;
}

module.exports = { settingsRoutes };
