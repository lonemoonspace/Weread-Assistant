// 镜像 HEALTHCHECK 使用：请求本机面板的 /healthz，正常时退出码 0
const http = require("http");
const { panelOptionsFromEnv } = require("./options");

const { host, port, basePath } = panelOptionsFromEnv(process.env);
// 监听所有地址时请求本机回环地址；PANEL_HOST 指定了某个地址时请求该地址
const target = !host || host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
const req = http.get({ host: target, port, path: `${basePath}healthz`, timeout: 4000 }, (res) => {
  res.resume();
  process.exit(res.statusCode === 200 ? 0 : 1);
});
req.on("timeout", () => req.destroy(new Error("timeout")));
req.on("error", () => process.exit(1));
