const fs = require("fs");
const path = require("path");
const express = require("express");
const { findAccount } = require("../../accounts");
const { PanelError, badRequest, requireObject } = require("../../errors");
const { getRun, listRuns, screenshotPath } = require("../../history");
const { runDir } = require("../../runs");

// 运行队列与运行历史：启动、停止、运行列表、运行详情、截图与日志
function runRoutes({ dataDir, store, runner }) {
  const router = express.Router();

  // 运行历史，最新的在前；?limit=（1–100，默认 20）&before=<上一页最后一个运行 ID>&date=<YYYY-MM-DD，当天及以前>
  router.get("/accounts/:id/runs", (req, res) => {
    const data = store.get();
    findAccount(data, req.params.id);
    const { limit = 20, before = "", date = "" } = req.query;
    res.json(listRuns(dataDir, req.params.id, { limit, before, date, timezone: data.settings.timezone }));
  });

  // 单次运行的记录、截图列表与按天拆分的阅读分钟数
  router.get("/accounts/:id/runs/:runId", (req, res) => {
    findAccount(store.get(), req.params.id);
    res.json({ run: getRun(dataDir, req.params.id, req.params.runId, store.get().settings.timezone) });
  });

  router.get("/accounts/:id/runs/:runId/screenshots/:name", (req, res) => {
    findAccount(store.get(), req.params.id);
    const { dir, name } = screenshotPath(dataDir, req.params.id, req.params.runId, req.params.name);
    res.set("Content-Type", "image/png");
    res.sendFile(name, { root: dir });
  });

  // 排队中与进行中的运行，带最近的日志
  router.get("/runs", (req, res) => {
    res.json({ runs: runner.list({ withLog: true }) });
  });

  // { mode?: "read" | "login" }：立即运行（默认阅读）或仅登录；加入队列后返回 202
  router.post("/accounts/:id/runs", (req, res) => {
    const body = req.body === undefined ? {} : requireObject(req.body);
    const unknown = Object.keys(body).filter((key) => key !== "mode");
    if (unknown.length > 0) {
      throw badRequest(`未知的字段：${unknown.join(", ")}`);
    }
    const run = runner.enqueue(req.params.id, { mode: body.mode === undefined ? "read" : body.mode });
    res.status(202).json({ run });
  });

  // 停止账号当前的运行：排队中的直接取消，进行中的先关闭浏览器再结束
  router.post("/accounts/:id/stop", (req, res) => {
    res.status(202).json({ run: runner.stop(req.params.id) });
  });

  // 运行日志；?download=1 时作为附件下载
  router.get("/accounts/:id/runs/:runId/log", (req, res) => {
    findAccount(store.get(), req.params.id);
    let dir;
    try {
      dir = runDir(dataDir, req.params.id, req.params.runId);
    } catch (_) {
      throw new PanelError(404, "run_not_found", "运行记录不存在");
    }
    if (!fs.existsSync(path.join(dir, "output.log"))) {
      throw new PanelError(404, "run_not_found", "运行记录不存在");
    }
    res.set("Content-Type", "text/plain; charset=utf-8");
    if (req.query.download === "1") {
      res.set("Content-Disposition", `attachment; filename="${req.params.id}-${req.params.runId}.log"`);
    }
    // 以运行目录为 root：数据目录位于以点开头的目录下（如 ~/.weread）时也能读取
    res.sendFile("output.log", { root: dir });
  });

  return router;
}

module.exports = { runRoutes };
