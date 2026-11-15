const path = require("path");
const express = require("express");
const { contentSecurityPolicy } = require("../security");

const PUBLIC_DIR = path.join(__dirname, "..", "..", "public");

// 健康检查、静态资源与两个页面（主页面、登录页）
function pageRoutes() {
  const router = express.Router();

  router.get("/healthz", (req, res) => {
    res.json({ status: "ok" });
  });

  router.use(
    "/assets",
    express.static(path.join(PUBLIC_DIR, "assets"), { index: false, fallthrough: false })
  );

  router.get("/", (req, res) => {
    if (!req.sessionToken) {
      res.redirect(302, "login");
      return;
    }
    res.set("Content-Security-Policy", contentSecurityPolicy({ allowEval: true }));
    // 页面是否可见取决于会话，不让浏览器或代理缓存
    res.set("Cache-Control", "no-store");
    res.sendFile(path.join(PUBLIC_DIR, "index.html"), { cacheControl: false });
  });

  router.get("/login", (req, res) => {
    if (req.sessionToken) {
      res.redirect(302, "./");
      return;
    }
    res.set("Cache-Control", "no-store");
    res.sendFile(path.join(PUBLIC_DIR, "login.html"), { cacheControl: false });
  });

  return router;
}

module.exports = { pageRoutes };
