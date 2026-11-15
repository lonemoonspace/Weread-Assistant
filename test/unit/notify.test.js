const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const { resolveConfig } = require("../../src/config/resolve");
const { createNotifier } = require("../../src/notify");
const { canSendEmail, formatEmailTime, smtpTransportOptions, toMailAttachments } = require("../../src/notify/email");
const { normalizeNtfyPriority } = require("../../src/notify/channels/ntfy");
const { postJson } = require("../../src/shared/http");

// 静默运行，返回捕获的日志
async function quietly(fn) {
  const logs = [];
  const saved = {};
  for (const level of ["info", "warn", "error", "log"]) {
    saved[level] = console[level];
    console[level] = (...args) => logs.push(args.join(" "));
  }
  try {
    await fn();
  } finally {
    Object.assign(console, saved);
  }
  return logs;
}

describe("normalizeNtfyPriority", () => {
  it("只接受 1-5 的整数与别名，其余回退", async () => {
    assert.equal(normalizeNtfyPriority("4"), 4);
    assert.equal(normalizeNtfyPriority(" High "), 4);
    await quietly(() => {
      assert.equal(normalizeNtfyPriority("3abc", 1), 1);
      assert.equal(normalizeNtfyPriority("4abc"), 3);
      assert.equal(normalizeNtfyPriority("2.9", 1), 1);
      assert.equal(normalizeNtfyPriority("6"), 3);
    });
  });
});

describe("邮件", () => {
  const base = { emailEnabled: true, emailSmtp: "smtp", emailUser: "u", emailPass: "p", emailTo: "t" };

  it("465 用 SSL；其他端口要求 STARTTLS，开启允许不加密后才放行", () => {
    assert.deepEqual(
      [smtpTransportOptions({ ...base, emailPort: 465 })].map(({ secure, requireTLS }) => ({ secure, requireTLS })),
      [{ secure: true, requireTLS: false }]
    );
    assert.equal(smtpTransportOptions({ ...base, emailPort: 587 }).requireTLS, true);
    assert.equal(smtpTransportOptions({ ...base, emailPort: 25, emailAllowInsecure: true }).requireTLS, false);
  });

  it("时间固定为中文格式，并注明与 UTC 的偏移", () => {
    assert.match(formatEmailTime(new Date(2026, 10, 14, 9, 5, 7)), /^2026\/11\/14 09:05:07（UTC([+-]\d{2}:\d{2})?）$/);
  });

  it("canSendEmail 的 quiet 模式不记录日志", async () => {
    const logs = await quietly(() => {
      assert.equal(canSendEmail({ ...base, emailTo: "" }, { quiet: true }), false);
    });
    assert.deepEqual(logs, []);
    const loud = await quietly(() => canSendEmail({ ...base, emailTo: "" }));
    assert.equal(loud.length, 1);
  });

  it("附件可以是路径或内存中的内容，不存在的路径跳过", async () => {
    let attachments;
    await quietly(() => {
      attachments = toMailAttachments(["/no/such/file.png", { filename: "done.png", content: Buffer.from("x") }]);
    });
    assert.equal(attachments.length, 1);
    assert.equal(attachments[0].cid, "done.png");
    assert.equal(attachments[0].contentType, "image/png");
  });

  it("附件的 MIME 类型：jpg 为 image/jpeg，不认识的扩展名不填写", () => {
    const [jpg, bare] = toMailAttachments([
      { filename: "a.JPG", content: Buffer.from("x") },
      { filename: "noext", content: Buffer.from("x") },
    ]);
    assert.equal(jpg.contentType, "image/jpeg");
    assert.equal("contentType" in bare, false);
  });
});

describe("createNotifier", () => {
  it("willEmail：邮件配置不完整时为 false，且不记录日志", async () => {
    const config = resolveConfig({ emailEnabled: true, notifyOnDone: true });
    const logs = await quietly(() => assert.equal(createNotifier(config).willEmail("done"), false));
    assert.deepEqual(logs, []);
  });

  it("通知在后台发送，flush 等待完成；超时后不再等待", async () => {
    const waiting = [];
    const release = () => waiting.splice(0).forEach((resolve) => resolve());
    const server = http.createServer((req, res) => {
      req.resume();
      if (req.url === "/slow/push") {
        new Promise((resolve) => waiting.push(resolve)).then(() => res.end("{}"));
        return;
      }
      res.end("{}");
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address();
    try {
      await quietly(async () => {
        const fast = createNotifier(resolveConfig({ barkKey: "k", barkServer: `http://127.0.0.1:${port}`, notifyOnDone: true }));
        fast.event("done", "阅读完成");
        assert.equal(fast.pendingCount(), 1);
        assert.equal(await fast.flush(5000), true);
        assert.equal(fast.pendingCount(), 0);

        const slow = createNotifier(resolveConfig({ barkKey: "k", barkServer: `http://127.0.0.1:${port}/slow`, notifyOnDone: true }));
        slow.event("done", "阅读完成");
        assert.equal(await slow.flush(50), false);
        release();
        assert.equal(await slow.flush(5000), true);

        // flush 期间新加入的通知也会等待
        const later = createNotifier(resolveConfig({ barkKey: "k", barkServer: `http://127.0.0.1:${port}/slow`, notifyOnDone: true }));
        later.event("done", "第一条");
        const flushing = later.flush(5000);
        later.event("done", "第二条");
        let flushed = false;
        flushing.then(() => (flushed = true));
        while (waiting.length < 2) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        waiting.shift()();
        await new Promise((resolve) => setTimeout(resolve, 100));
        assert.equal(flushed, false);
        release();
        assert.equal(await flushing, true);
        assert.equal(later.pendingCount(), 0);
      });
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

describe("postJson", () => {
  it("支持 IPv6 地址，带上版本号 UA", async (t) => {
    const server = http.createServer((req, res) => {
      req.resume();
      res.end(JSON.stringify({ ua: req.headers["user-agent"] }));
    });
    try {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "::1", resolve);
      });
    } catch (e) {
      t.skip(`本机不支持 IPv6：${e.code}`);
      return;
    }
    try {
      const result = await postJson(`http://[::1]:${server.address().port}/x`, {});
      assert.equal(result.ok, true);
      assert.match(JSON.parse(result.body).ua, /^WeReadAssistant\/\d+\.\d+\.\d+/);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
