// 面板 smoke：CSRF、安全响应头、反向代理、cookie 与子路径

const assert = require("assert");
const http = require("http");
const zlib = require("zlib");

const { CSRF, sessionCookie } = require("./helpers");

module.exports = async function securityScenarios({ scenario, start, login }) {
  await scenario("修改类请求缺少自定义请求头返回 403，不是 JSON 返回 415", async () => {
    const panel = await start({ password: "correct-horse" });
    const noHeader = await panel.request("api/auth/login", { method: "POST", body: { password: "correct-horse" } });
    assert.strictEqual(noHeader.status, 403);
    const form = await panel.request("api/auth/login", {
      method: "POST",
      body: "password=correct-horse",
      headers: { ...CSRF, "Content-Type": "application/x-www-form-urlencoded" },
    });
    assert.strictEqual(form.status, 415);
    const badJson = await panel.request("api/auth/login", { method: "POST", body: "{oops", headers: CSRF });
    assert.strictEqual(badJson.status, 400);
    for (const [encoding, compress] of [["br", zlib.brotliCompressSync], ["gzip", zlib.gzipSync]]) {
      const compressed = await panel.request("api/auth/login", {
        method: "POST",
        body: compress(Buffer.from(JSON.stringify({ password: "correct-horse" }))),
        headers: { ...CSRF, "Content-Encoding": encoding },
      });
      assert.strictEqual(compressed.status, 415, `${encoding} 压缩的请求体应被拒绝`);
    }
  });

  await scenario("信任代理时按 X-Forwarded-For 区分 IP、HTTPS 下设置 Secure；不信任代理时忽略这些请求头", async () => {
    const trusted = await start({ password: "correct-horse", trustProxy: 1, limits: { lockoutBaseMs: 60000 } });
    for (let i = 0; i < 5; i += 1) {
      await login(trusted, "wrong", { "X-Forwarded-For": "203.0.113.1" });
    }
    assert.strictEqual((await login(trusted, "correct-horse", { "X-Forwarded-For": "203.0.113.1" })).status, 429);
    const other = await login(trusted, "correct-horse", { "X-Forwarded-For": "203.0.113.2", "X-Forwarded-Proto": "https" });
    assert.strictEqual(other.status, 204);
    assert.match(other.headers.get("set-cookie"), /Secure/i);

    const untrusted = await start({ password: "correct-horse", limits: { lockoutBaseMs: 60000 } });
    for (let i = 0; i < 5; i += 1) {
      await login(untrusted, "wrong", { "X-Forwarded-For": "203.0.113.1" });
    }
    // 不信任代理时伪造的 X-Forwarded-For 不起作用，仍按真实连接地址计数
    assert.strictEqual((await login(untrusted, "correct-horse", { "X-Forwarded-For": "203.0.113.9" })).status, 429);
    const plain = await start({ password: "correct-horse" });
    const ok = await login(plain, "correct-horse", { "X-Forwarded-Proto": "https" });
    assert.doesNotMatch(ok.headers.get("set-cookie"), /Secure/i);
  });

  await scenario("会话 cookie：在 https 的 PANEL_PUBLIC_URL 域名下访问时总带 Secure 并下发 HSTS，内网 IP 经 HTTP 访问时不带", async () => {
    const panel = await start({ password: "correct-horse", publicUrl: "https://Panel.Example.com/weread/", basePath: "/weread/" });
    const viaHost = (host) =>
      new Promise((resolve, reject) => {
        const body = JSON.stringify({ password: "correct-horse" });
        const req = http.request(
          {
            host: "127.0.0.1",
            port: panel.port,
            path: "/weread/api/auth/login",
            method: "POST",
            headers: { Host: host, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body), ...CSRF },
          },
          (res) => {
            res.resume();
            res.on("end", () => resolve(res));
          }
        );
        req.on("error", reject);
        req.end(body);
      });
    const proxied = await viaHost("panel.example.com.");
    assert.strictEqual(proxied.statusCode, 204);
    assert.match(proxied.headers["set-cookie"].join(";"), /;\s*Secure/i);
    assert.strictEqual(proxied.headers["strict-transport-security"], "max-age=15552000");
    const lan = await viaHost("192.168.1.20:26868");
    assert.strictEqual(lan.statusCode, 204);
    assert.doesNotMatch(lan.headers["set-cookie"].join(";"), /Secure/i);
    assert.strictEqual(lan.headers["strict-transport-security"], undefined);
  });

  await scenario("同名 cookie：其他应用设置的 wa_session 顶不掉真实会话", async () => {
    const panel = await start({ password: "correct-horse" });
    const real = sessionCookie(await login(panel, "correct-horse"));
    for (const cookie of [`wa_session=forged; ${real}`, `${real}; wa_session=forged`, `wa_session=%E0%A4%A; ${real}`]) {
      assert.strictEqual((await panel.request("api/auth/session", { cookie })).status, 200, cookie);
    }
    assert.strictEqual((await panel.request("api/auth/session", { cookie: "wa_session=forged; wa_session=other" })).status, 401);
  });

  await scenario("部署在子路径：/weread 重定向到 /weread/，cookie 限定在该路径", async () => {
    const panel = await start({ password: "correct-horse", basePath: "/weread/" });
    const bare = await panel.request("/weread?x=1");
    assert.strictEqual(bare.status, 301);
    assert.strictEqual(bare.headers.get("location"), "/weread/?x=1");
    assert.strictEqual((await panel.request("/weread/healthz")).status, 200);
    assert.strictEqual((await panel.request("/healthz")).status, 404);
    assert.strictEqual((await panel.request("/weread/")).headers.get("location"), "login");
    const ok = await login(panel, "correct-horse");
    assert.match(ok.headers.get("set-cookie"), /Path=\/weread\//);
  });

  await scenario("页面与接口带安全响应头，接口禁止缓存；只有主页面允许 'unsafe-eval'", async () => {
    const panel = await start({ password: "correct-horse" });
    const page = await panel.request("login");
    const csp = page.headers.get("content-security-policy");
    assert.match(csp, /default-src 'self'/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.doesNotMatch(csp, /unsafe-inline/);
    assert.doesNotMatch(csp, /unsafe-eval/, "登录页不需要 'unsafe-eval'");
    // 主页面使用 Vue 免构建版在浏览器内编译模板
    const cookie = sessionCookie(await login(panel, "correct-horse"));
    const index = await panel.request("", { cookie });
    assert.strictEqual(index.status, 200);
    const indexCsp = index.headers.get("content-security-policy");
    assert.match(indexCsp, /script-src 'self' 'unsafe-eval'(;|$)/);
    assert.doesNotMatch(indexCsp, /unsafe-inline/);
    assert.ok(!/<script(?![^>]*\bsrc=)/i.test(index.text), "主页面不应有内联脚本");
    assert.ok(!/<style|\sstyle=/i.test(index.text), "主页面不应有内联样式");
    for (const asset of ["assets/app/main.js", "assets/vendor/vue.esm-browser.prod.js", "assets/vendor/pico.min.css", "assets/vendor/qrcode.mjs"]) {
      const res = await panel.request(asset);
      assert.strictEqual(res.status, 200, asset);
      assert.doesNotMatch(res.headers.get("content-security-policy"), /unsafe-eval/, asset);
    }
    assert.match((await panel.request("assets/app/main.js")).headers.get("content-type"), /javascript/);
    assert.match((await panel.request("assets/vendor/qrcode.mjs")).headers.get("content-type"), /javascript/, ".mjs 需要以 JavaScript 类型返回");
    assert.doesNotMatch((await panel.request("api/auth/session", { cookie })).headers.get("content-security-policy"), /unsafe-eval/);
    assert.strictEqual(page.headers.get("x-frame-options"), "DENY");
    assert.strictEqual(page.headers.get("referrer-policy"), "no-referrer");
    assert.strictEqual(page.headers.get("x-content-type-options"), "nosniff");
    assert.strictEqual(page.headers.get("x-powered-by"), null);
    assert.strictEqual((await panel.request("api/auth/session")).headers.get("cache-control"), "no-store");
    // 页面是否可见取决于会话：主页面与登录页都不缓存；经 HTTP 访问时不发 HSTS
    assert.strictEqual(index.headers.get("cache-control"), "no-store");
    assert.strictEqual(page.headers.get("cache-control"), "no-store");
    assert.strictEqual(page.headers.get("strict-transport-security"), null);
    assert.match((await panel.request("assets/app/main.js")).headers.get("cache-control"), /max-age/, "静态文件照常缓存");
  });
};
