const express = require("express");

// 实时推送的心跳间隔，同时定期检查会话是否仍然有效
const SSE_HEARTBEAT_MS = 15000;

// 实时推送（SSE）：连接后先发送一次完整状态 snapshot，之后推送运行状态变化 run 与新的日志行 log。
// 退出登录、修改密码时立即断开；定期发送心跳事件 ping，同时检查会话是否过期
function eventRoutes({ options, auth, runner }) {
  const router = express.Router();

  router.get("/events", (req, res) => {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      "X-Accel-Buffering": "no",
    });
    // 连接关闭后不再写入：在已结束的响应上写入会触发 error 事件
    let open = true;
    const send = (event, data) => {
      if (open) {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      }
    };
    let heartbeat = null;
    let unsubscribe = () => {};
    let unwatch = () => {};
    const disconnect = () => {
      if (open) {
        cleanup();
        res.end();
      }
    };
    res.write("retry: 3000\n\n");
    send("snapshot", { runs: runner.list({ withLog: true }) });
    unsubscribe = runner.subscribe(send);
    unwatch = auth.watchSession(req.sessionToken, disconnect);
    if (!open) {
      return;
    }
    heartbeat = setInterval(() => {
      if (!auth.isSessionValid(req.sessionToken)) {
        disconnect();
        return;
      }
      // 以事件而不是注释发送：页面据此发现半开的连接（EventSource 收不到注释）
      send("ping", {});
    }, options.sseHeartbeatMs || SSE_HEARTBEAT_MS);
    function cleanup() {
      if (!open) {
        return;
      }
      open = false;
      clearInterval(heartbeat);
      unsubscribe();
      unwatch();
    }
    res.on("close", cleanup);
    res.on("error", cleanup);
  });

  return router;
}

module.exports = { eventRoutes };
