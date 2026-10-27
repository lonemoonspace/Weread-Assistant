// 模拟 Selenium，供 panel-smoke 与 ui-smoke 使用：/status（与 /wd/hub/status）返回状态，
// 其他请求（如删除会话）返回成功，并记录收到的请求。
// mode 决定 /status 的响应：
//   grid    Selenium Grid（含 standalone 镜像）的格式：一个节点（状态为 availability），maxSessions 个槽位，前 used 个已占用
//   driver  chromedriver 的格式：只有 ready，没有会话数
//   legacy  /status 返回 404，只有 /wd/hub/status 可用
//   html    不是 Selenium（返回网页）
//   hang    不响应
//   drip    返回响应头后每 50ms 发送一个字节，从不结束（连接一直不空闲）
//   cut     返回一部分响应体后断开连接
// state.delayMs 大于 0 时延迟这么久再响应状态请求。stop() 后连接被拒绝，start() 在原端口重新监听
const http = require("http");

function gridStatus(maxSessions, used, availability) {
  const ready = availability === "UP" && used < maxSessions;
  const slots = Array.from({ length: maxSessions }, (_, index) => ({
    id: { hostId: "mock-node", id: `slot-${index}` },
    lastStarted: "1970-01-01T00:00:00Z",
    session: index < used ? { sessionId: `mock-session-${index}`, start: new Date().toISOString() } : null,
    stereotype: { browserName: "chrome", platformName: "linux" },
  }));
  return {
    value: {
      ready,
      message: ready ? "Selenium Grid ready." : "Selenium Grid not ready.",
      nodes: [{ id: "mock-node", uri: "http://172.17.0.2:4444", availability, maxSessions, slots }],
    },
  };
}

async function startMockSelenium({ mode = "grid", maxSessions = 1, used = 0 } = {}) {
  // authorization / sessionAuthorization 为最近一次状态请求 / 其他请求带的 Authorization 请求头
  const state = { mode, maxSessions, used, availability: "UP", delayMs: 0, authorization: "", sessionAuthorization: "" };
  const requests = [];
  const sockets = new Set();
  const server = http.createServer(async (req, res) => {
    requests.push(`${req.method} ${req.url}`);
    const isStatus = req.url === "/status" || req.url === "/wd/hub/status";
    if (isStatus) {
      state.authorization = req.headers.authorization || "";
    }
    if (!isStatus) {
      state.sessionAuthorization = req.headers.authorization || "";
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end('{"value":null}');
      return;
    }
    if (state.mode === "hang") {
      return;
    }
    if (state.mode === "drip") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.write('{"value":');
      const timer = setInterval(() => res.write(" "), 50);
      res.on("close", () => clearInterval(timer));
      return;
    }
    if (state.mode === "cut") {
      res.writeHead(200, { "Content-Type": "application/json", "Content-Length": "100" });
      res.write('{"value":');
      setTimeout(() => req.socket.destroy(), 50);
      return;
    }
    if (state.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, state.delayMs));
    }
    if (state.mode === "html") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<html><body>Welcome to nginx!</body></html>");
      return;
    }
    if (state.mode === "legacy" && req.url === "/status") {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not Found");
      return;
    }
    const body =
      state.mode === "driver"
        ? { value: { ready: true, message: "ChromeDriver ready for new sessions.", build: { version: "mock" } } }
        : gridStatus(state.maxSessions, state.used, state.availability);
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(body));
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  const listen = (port) => new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  await listen(0);
  const { port } = server.address();
  const stop = () =>
    new Promise((resolve) => {
      if (!server.listening) {
        resolve();
        return;
      }
      server.close(() => resolve());
      for (const socket of sockets) {
        socket.destroy();
      }
    });
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    state,
    requests,
    stop,
    start: () => listen(port),
    close: stop,
  };
}

module.exports = { startMockSelenium };
