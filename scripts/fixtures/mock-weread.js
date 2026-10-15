// 模拟微信读书网页的本地服务，供 reader-smoke 使用。
// 页面结构只复刻自动阅读用到的元素与文案（见 src/reader/selectors.js），不访问真实站点。
//
// 每个场景挂在 /s/<name>/ 下，场景参数：
//   loggedIn       首页直接显示“我的书架”（否则需要扫码，扫码成功后写入 wr_vid cookie）
//   qrExpireMs     二维码多久后显示“点击刷新二维码”
//   scanOnQr       第几张二维码出现后视为扫码成功；不设置则永远不扫码
//   scanDelayMs    该二维码出现多久后完成扫码
//   books          书架上的书数量
//   chapters       每本书的章节数，最后一章显示“全 书 完”
//   frontMatter    目录开头是否有一个“扉页”条目（章节号 0）
//   contentHeight  每章正文高度（像素）
const http = require("http");
const { URL } = require("url");
const { PNG } = require("pngjs");
const QRCode = require("qrcode-terminal/vendor/QRCode");
const QRErrorCorrectLevel = require("qrcode-terminal/vendor/QRCode/QRErrorCorrectLevel");

const PAGE_STYLE = `
  body { font-family: sans-serif; margin: 0; padding: 16px; background: #fff; }
  .wr_index_mini_shelf_card, button, li, .login_dialog_retry_delegate, a { display: inline-block; padding: 8px 12px; margin: 4px; border: 1px solid #ccc; cursor: pointer; }
  li { display: block; }
  .readerChapterContent { border-left: 4px solid #eee; padding-left: 8px; }
`;

function qrPng(text, scale = 6, margin = 4) {
  const qr = new QRCode(-1, QRErrorCorrectLevel.M);
  qr.addData(text);
  qr.make();
  const count = qr.getModuleCount();
  const size = (count + margin * 2) * scale;
  const png = new PNG({ width: size, height: size });
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const row = Math.floor(y / scale) - margin;
      const col = Math.floor(x / scale) - margin;
      const dark = row >= 0 && col >= 0 && row < count && col < count && qr.isDark(row, col);
      const offset = (y * size + x) * 4;
      png.data[offset] = png.data[offset + 1] = png.data[offset + 2] = dark ? 0 : 255;
      png.data[offset + 3] = 255;
    }
  }
  return PNG.sync.write(png);
}

function loginUrlFor(name, n) {
  return `https://weread.qq.com/web/confirm?uid=mock-${name}-${n}`;
}

function page(title, body, script) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<style>${PAGE_STYLE}</style></head><body>${body}
<script>${script}</script></body></html>`;
}

// 页面向服务端上报事件，供断言使用
function reportScript(base) {
  return `function report(type, extra) {
    const query = new URLSearchParams(Object.assign({ type }, extra || {}));
    fetch("${base}/__event?" + query, { keepalive: true });
  }`;
}

function homePage(name, scenario, loggedIn) {
  const base = `/s/${name}`;
  if (loggedIn) {
    const cards = Array.from({ length: scenario.books || 0 }, (_, i) => i + 1)
      .map((book) => `<div class="wr_index_mini_shelf_card" onclick="location.href='${base}/reader?book=${book}&ch=1'">书 ${book}</div>`)
      .join("");
    return page("微信读书", `<div class="wr_index_page_top_section_header_action_link">我的书架</div><div>${cards}</div>`, "");
  }

  const script = `${reportScript(base)}
    const cfg = ${JSON.stringify(scenario)};
    let n = 0;
    function showQr() {
      n += 1;
      document.getElementById("qr").src = "${base}/qr.png?n=" + n;
      const overlay = document.getElementById("overlay");
      overlay.innerHTML = "";
      if (cfg.scanOnQr === n) {
        setTimeout(() => { document.cookie = "wr_vid=1; path=/"; location.reload(); }, cfg.scanDelayMs || 0);
        return;
      }
      setTimeout(() => {
        overlay.innerHTML = '<div class="wr_login_modal_qr_overlay_text">点击刷新二维码</div><div class="login_dialog_retry_delegate">刷新</div>';
        overlay.querySelector(".login_dialog_retry_delegate").onclick = () => { report("refresh"); showQr(); };
      }, cfg.qrExpireMs);
    }
    document.getElementById("login").onclick = () => {
      document.getElementById("modal").style.display = "block";
      showQr();
    };`;
  return page(
    "微信读书",
    `<a id="login" href="javascript:void(0)">登录</a>
     <div id="modal" style="display:none"><img id="qr" class="wr_login_modal_qr_img" alt="二维码"><div id="overlay"></div></div>`,
    script
  );
}

function readerPage(name, scenario, book, ch) {
  const base = `/s/${name}`;
  const chapters = scenario.chapters || 1;
  const entries = [];
  if (scenario.frontMatter) {
    entries.push({ ch: 0, label: "扉页" });
  }
  for (let i = 1; i <= chapters; i += 1) {
    entries.push({ ch: i, label: `第${i}章` });
  }
  // 与真实页面一致：当前章节带有额外的选中样式
  const catalog = entries
    .map((entry) => {
      const cls = entry.ch === ch ? "readerCatalog_list_item readerCatalog_list_item_selected" : "readerCatalog_list_item";
      return `<li class="${cls}" onclick="location.href='${base}/reader?book=${book}&ch=${entry.ch}'">${entry.label}</li>`;
    })
    .join("");
  const footer = ch < chapters
    ? `<button class="readerFooter_button" title="下一章" onclick="location.href='${base}/reader?book=${book}&ch=${ch + 1}'">下一章</button>`
    : `<div class="readerFooter_ending_title">全 书 完</div>`;

  const script = `${reportScript(base)}
    const nav = performance.getEntriesByType("navigation")[0];
    report(nav && nav.type === "reload" ? "reload" : "chapter", { book: "${book}", ch: "${ch}" });
    const toggle = document.getElementById("toggle");
    if (sessionStorage.getItem("vertical")) {
      toggle.remove();
    } else {
      toggle.onclick = () => { sessionStorage.setItem("vertical", "1"); toggle.remove(); report("vertical"); };
    }
    document.getElementById("catalogButton").onclick = () => { document.getElementById("catalog").style.display = "block"; };
    document.addEventListener("keydown", (e) => { if (e.key === "ArrowDown") report("press"); });`;

  return page(
    `Mock Book ${book} - Mock Author - 微信读书`,
    `<div><button id="catalogButton" class="readerControls_item catalog" title="目录">目录</button>
       <button id="toggle" class="readerControls_item isHorizontalReader">切换</button></div>
     <ul id="catalog" style="display:none">${catalog}</ul>
     <div class="readerChapterContent" style="height:${scenario.contentHeight || 1800}px">第 ${ch} 章正文</div>
     ${footer}`,
    script
  );
}

function startMockWeread() {
  const scenarios = new Map();
  const events = new Map();

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    const match = url.pathname.match(/^\/s\/([^/]+)\/(.*)$/);
    const scenario = match && scenarios.get(match[1]);
    if (!scenario) {
      res.writeHead(404);
      res.end("unknown scenario");
      return;
    }
    const [, name, rest] = match;
    const send = (type, body) => {
      res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-store" });
      res.end(body);
    };

    if (rest === "") {
      const loggedIn = scenario.loggedIn || /(?:^|;\s*)wr_vid=1/.test(req.headers.cookie || "");
      send("text/html; charset=utf-8", homePage(name, scenario, loggedIn));
    } else if (rest === "qr.png") {
      send("image/png", qrPng(loginUrlFor(name, url.searchParams.get("n"))));
    } else if (rest === "reader") {
      send("text/html; charset=utf-8", readerPage(name, scenario, url.searchParams.get("book"), Number(url.searchParams.get("ch"))));
    } else if (rest === "__event") {
      events.get(name).push({ ...Object.fromEntries(url.searchParams), at: Date.now() });
      send("text/plain", "ok");
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  return new Promise((resolve) => {
    server.listen(0, "0.0.0.0", () => {
      const { port } = server.address();
      const host = process.env.MOCK_HOST || "127.0.0.1";
      resolve({
        baseUrl: `http://${host}:${port}`,
        addScenario(name, scenario) {
          scenarios.set(name, scenario);
          events.set(name, []);
          return `http://${host}:${port}/s/${name}/`;
        },
        events: (name) => events.get(name) || [],
        loginUrlFor,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

module.exports = {
  startMockWeread,
};
