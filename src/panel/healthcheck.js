// 镜像 HEALTHCHECK 使用：请求本机面板的 /healthz，正常时退出码 0
const http = require("http");
const { panelOptionsFromEnv } = require("./options");

const { port, basePath } = panelOptionsFromEnv(process.env);
const req = http.get({ host: "127.0.0.1", port, path: `${basePath}healthz`, timeout: 4000 }, (res) => {
  res.resume();
  process.exit(res.statusCode === 200 ? 0 : 1);
});
req.on("timeout", () => req.destroy(new Error("timeout")));
req.on("error", () => process.exit(1));
