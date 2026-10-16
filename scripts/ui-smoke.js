#!/usr/bin/env node
/**
 * 面板页面 smoke 测试：启动面板（用桩子进程代替阅读子进程），用浏览器走通各个页面并截图。
 * 检查页面内容与操作结果、浏览器控制台没有错误（包括 CSP 拦截），手机宽度下页面没有横向滚动。
 * 不访问微信读书。
 *
 * 用法: SELENIUM_URL=http://localhost:4444 node scripts/ui-smoke.js
 *   SELENIUM_URL 默认 http://localhost:4444，也可以直接指向 chromedriver（如 http://localhost:9515）。
 *   UI_SMOKE_SCREENSHOTS=<目录> 截图保存位置，默认在系统临时目录下新建。
 *   浏览器需要能访问本机的面板；Selenium 跑在容器里时用 --network host 启动，
 *   或通过 PANEL_HOST_FOR_BROWSER 指定浏览器访问本机时使用的地址。
 */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { Builder, By, Key, logging, until } = require("selenium-webdriver");
const chrome = require("selenium-webdriver/chrome");

const { startPanel } = require(path.resolve(__dirname, "..", "src", "panel", "server"));
const { dateInZone } = require(path.resolve(__dirname, "..", "src", "panel", "history"));
const { minutesFrom, writeRun } = require("./fixtures/run-records");

const SELENIUM_URL = process.env.SELENIUM_URL || "http://localhost:4444";
const BROWSER_HOST = process.env.PANEL_HOST_FOR_BROWSER || "127.0.0.1";
const STUB_WORKER = path.resolve(__dirname, "fixtures", "stub-worker.js");
const SHOTS = process.env.UI_SMOKE_SCREENSHOTS || fs.mkdtempSync(path.join(os.tmpdir(), "ui-smoke-"));
const TIMEZONE = "Asia/Shanghai";
const NEW_PASSWORD = "new-password-123";

// ---------- 面板与数据 ----------

async function startSeededPanel() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ui-smoke-data-"));
  const panel = await startPanel({
    port: 0,
    host: "0.0.0.0",
    basePath: "/",
    trustProxy: false,
    publicUrl: "",
    password: "",
    dataDir,
    seleniumUrl: "",
    runner: { workerPath: STUB_WORKER, killTimeoutMs: 500 },
  });
  const base = `http://127.0.0.1:${panel.port}/`;
  let cookie = "";
  const call = async (method, urlPath, body) => {
    const headers = { Cookie: cookie };
    if (method !== "GET") {
      headers["X-WA-Request"] = "1";
      headers["Content-Type"] = "application/json";
    }
    const res = await fetch(base + urlPath, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const setCookie = res.headers.get("set-cookie");
    if (setCookie) {
      cookie = setCookie.split(";")[0];
    }
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  };
  await call("POST", "api/auth/login", { password: panel.generatedPassword });
  await call("POST", "api/accounts", { id: "ok-1", name: "小明" });
  await call("POST", "api/accounts", { id: "qr-1", name: "扫码测试" });
  await call("POST", "api/accounts", { id: "slow-1", name: "长时间阅读" });
  await call("PUT", "api/accounts/ok-1/schedules", {
    schedules: [
      { type: "daily", times: ["06:00", "18:30"] },
      { type: "interval", hours: 6, minute: 15, enabled: false },
    ],
  });

  // 本月之前的每一天都有阅读记录（第 3 天只读了 3 分钟），挑战从本月 1 日开始
  const today = dateInZone(new Date(), TIMEZONE);
  const monthStart = `${today.slice(0, 7)}-01`;
  await call("PATCH", "api/accounts/ok-1", { challenge: { type: "month", startDate: monthStart } });
  for (let day = 1; day < Number(today.slice(8)); day += 1) {
    const date = `${today.slice(0, 7)}-${String(day).padStart(2, "0")}`;
    const start = `${date}T01:00:00.000Z`;
    writeRun(dataDir, "ok-1", { queuedAt: start, marks: minutesFrom(start, day === 3 ? 3 : 68), endedAt: start });
  }
  return { panel, dataDir, call, base: `http://${BROWSER_HOST}:${panel.port}/` };
}

// ---------- 浏览器 ----------

async function createDriver({ mobile = false } = {}) {
  const options = new chrome.Options();
  options.addArguments("--no-sandbox", "--disable-dev-shm-usage", "--lang=zh-CN");
  if (mobile) {
    options.setMobileEmulation({ deviceMetrics: { width: 390, height: 844, pixelRatio: 2 } });
  }
  const prefs = new logging.Preferences();
  prefs.setLevel(logging.Type.BROWSER, logging.Level.ALL);
  options.setLoggingPrefs(prefs);
  const driver = await new Builder().usingServer(SELENIUM_URL).forBrowser("chrome").setChromeOptions(options).build();
  await driver.manage().setTimeouts({ implicit: 0 });
  if (!mobile) {
    await driver.manage().window().setRect({ width: 1280, height: 1000 });
  }
  return driver;
}

function helpers(driver, prefix) {
  const shots = [];
  const h = {
    async shot(name) {
      const file = path.join(SHOTS, `${prefix}${name}.png`);
      fs.writeFileSync(file, await driver.takeScreenshot(), "base64");
      shots.push(file);
    },
    shots,
    async open(base, hash = "") {
      await driver.get(base + hash);
    },
    async go(hash) {
      await driver.executeScript("location.hash = arguments[0]", hash);
    },
    async waitFor(css, timeout = 10000) {
      return driver.wait(until.elementLocated(By.css(css)), timeout, `等待元素 ${css}`);
    },
    async waitText(css, text, timeout = 10000) {
      let found;
      await driver.wait(
        async () => {
          for (const el of await driver.findElements(By.css(css))) {
            if ((await el.getText()).includes(text)) {
              found = el;
              return true;
            }
          }
          return false;
        },
        timeout,
        `等待 ${css} 中出现“${text}”`
      );
      return found;
    },
    async button(text, scope = driver) {
      for (const el of await scope.findElements(By.css("button, a[role=button]"))) {
        if ((await el.getText()).trim() === text && (await el.isDisplayed())) {
          return el;
        }
      }
      throw new Error(`找不到按钮“${text}”`);
    },
    // 点击前滚动到页面中间，避免被底部提示条挡住
    async click(el) {
      await driver.executeScript("arguments[0].scrollIntoView({ block: 'center' })", el);
      await el.click();
    },
    async clickButton(text, scope) {
      await h.click(await h.button(text, scope));
    },
    async card(name) {
      for (const card of await driver.findElements(By.css(".account-card"))) {
        if ((await card.findElement(By.css(".account-name")).getText()) === name) {
          return card;
        }
      }
      throw new Error(`找不到账号卡片“${name}”`);
    },
    async type(el, text) {
      await el.sendKeys(Key.chord(Key.CONTROL, "a"), Key.BACK_SPACE, text);
    },
    // 展开表单中折叠的分组
    async openGroup(label) {
      for (const summary of await driver.findElements(By.css("details > summary"))) {
        if ((await summary.getText()).trim() === label) {
          const details = await summary.findElement(By.xpath(".."));
          if ((await details.getAttribute("open")) === null) {
            await h.click(summary);
          }
          return;
        }
      }
      throw new Error(`找不到分组“${label}”`);
    },
    // 包含该标签文字的表单项
    async field(label, scope = driver) {
      for (const el of await scope.findElements(By.css(".field"))) {
        if ((await el.findElement(By.css("label")).getText()) === label) {
          return el;
        }
      }
      throw new Error(`找不到表单项“${label}”`);
    },
    async noHorizontalScroll(page) {
      const [scrollWidth, innerWidth] = await driver.executeScript(
        "return [document.documentElement.scrollWidth, window.innerWidth]"
      );
      assert.ok(scrollWidth <= innerWidth + 1, `${page}：页面宽度 ${scrollWidth} 超出窗口 ${innerWidth}`);
    },
    async imagesLoaded(css) {
      await driver.wait(
        () => driver.executeScript(
          "const imgs = [...document.querySelectorAll(arguments[0])]; return imgs.length > 0 && imgs.every((img) => img.complete && img.naturalWidth > 0)",
          css
        ),
        10000,
        `等待图片 ${css} 加载完成`
      );
    },
    async consoleErrors() {
      const entries = await driver.manage().logs().get(logging.Type.BROWSER);
      return entries.filter((entry) => entry.level.value >= logging.Level.WARNING.value).map((entry) => entry.message);
    },
  };
  return h;
}

async function login(h, base, password) {
  await h.open(base, "login");
  await h.waitFor("#login-form");
  const input = await h.waitFor("#password");
  await input.sendKeys(password, Key.ENTER);
  await h.waitFor(".account-card");
}

// ---------- 桌面 ----------

async function desktop(env, h, driver, results) {
  const { base, call, panel } = env;
  const step = (name) => {
    results.push(name);
    console.log(`✅ ${name}`);
  };

  await h.open(base, "login");
  await h.waitFor("#login-form");
  await h.shot("01-login");
  const wrong = await h.waitFor("#password");
  await wrong.sendKeys("wrong-password", Key.ENTER);
  await h.waitText("#message", "密码错误");
  // 密码错误时接口返回 401，浏览器会记一条请求失败；只允许这一条
  const expected = await h.consoleErrors();
  assert.ok(expected.every((line) => /api\/auth\/login .*401/.test(line)), `登录页不应有其他错误：\n${expected.join("\n")}`);
  await login(h, base, panel.generatedPassword);
  assert.strictEqual((await driver.findElements(By.css(".account-card"))).length, 3);
  await h.waitText(".account-card", "下次运行");
  await h.shot("02-overview");
  step("登录与总览：密码错误有提示；登录后显示 3 个账号卡片、今日分钟数与下次运行时间");

  await h.clickButton("仅登录", await h.card("扫码测试"));
  const qr = await h.waitFor(".scan-card img.qr");
  assert.match(await qr.getAttribute("src"), /^data:image\/gif;base64,/);
  await h.waitText(".scan-card", "扫码测试 需要扫码登录");
  await h.button("复制登录链接");
  await h.shot("03-overview-scan");
  await h.go("#/accounts/qr-1/live");
  await h.waitFor(".live .qr-login img.qr");
  await h.waitText(".live-status", "等待扫码");
  await h.shot("04-live-scan");
  await h.clickButton("停止");
  await h.waitText(".live-status", "已停止");
  step("扫码：需要扫码的账号在总览置顶显示本地生成的二维码与复制按钮，实时页面同样显示；停止后状态为已停止");

  await h.go("#/accounts/ok-1/live");
  await h.clickButton("立即运行");
  await h.waitText(".live-status", "成功");
  await h.imagesLoaded(".screenshot img");
  await h.waitText("pre.log", "运行结束：成功");
  await h.waitText("pre.log", "加入队列：手动触发，阅读");
  await h.shot("05-live-done");
  step("实时：立即运行后显示状态、最新截图与实时日志，结束后显示结果");

  await h.go("#/accounts/slow-1/live");
  await h.clickButton("立即运行");
  await h.waitText(".reading", "正在读《测试书》第");
  await h.waitFor(".live progress");
  await h.shot("06-live-reading");
  await h.clickButton("停止");
  await h.waitText(".live-status", "已停止");
  step("实时：阅读中显示书名、进度条与日志；停止后状态更新");

  await h.go("#/accounts/ok-1/history");
  const firstRow = await h.waitFor("table.history tbody tr");
  await h.waitText("table.history", "成功");
  await h.clickButton("截图 2", firstRow);
  await h.imagesLoaded(".gallery img");
  await h.shot("07-history-screenshots");
  await h.clickButton("日志", firstRow);
  await h.waitText("tr.expanded pre.log", "[PANEL]");
  await h.button("下载日志").catch(() => h.waitText("tr.expanded a", "下载日志"));
  await h.shot("08-history-log");
  step("历史：运行列表显示结果与分钟数，可展开查看截图与日志");

  await h.go("#/accounts/ok-1/calendar");
  await h.waitFor(".calendar .day");
  await h.waitText(".challenge", "月卡");
  await h.waitText(".challenge", "已打卡");
  const today = dateInZone(new Date(), TIMEZONE);
  if (Number(today.slice(8)) > 1) {
    assert.ok((await driver.findElements(By.css(".calendar .day.checked"))).length >= 1, "应有已打卡的日期");
  }
  assert.strictEqual((await driver.findElements(By.css(".calendar .weekday"))).length, 7);
  await h.waitFor(".calendar .day.today");
  await h.shot("09-calendar");
  step("打卡日历：按月显示每天的分钟数与打卡状态，今天高亮，显示月卡进度");

  await h.go("#/accounts/ok-1/schedules");
  await h.waitText(".schedule-rule", "每天 06:00、18:30");
  await h.clickButton("添加规则");
  const rules = await driver.findElements(By.css(".schedule-rule"));
  assert.strictEqual(rules.length, 3);
  await h.type(await rules[2].findElement(By.css("input")), "07:30");
  await h.clickButton("预览运行时间");
  await h.waitText(".schedule-rule", "每天 07:30：接下来");
  await h.clickButton("保存");
  await h.waitText(".notice", "调度已保存");
  assert.strictEqual((await call("GET", "api/accounts/ok-1/schedules")).schedules.length, 3);
  await h.shot("10-schedules");
  step("调度：添加规则、预览接下来的运行时间、保存后立即生效");

  await h.go("#/accounts/ok-1/config");
  const duration = await h.field("阅读时长（分钟）");
  await h.waitText(".config-form", "继承：10");
  await h.click(await duration.findElement(By.css(".override-toggle input")));
  await h.type(await duration.findElement(By.css("input[type=number]")), "30");
  await h.clickButton("保存配置");
  await h.waitText(".notice", "运行配置已保存");
  assert.strictEqual((await call("GET", "api/accounts/ok-1")).account.overrides.duration, 30);
  await h.clickButton("发送测试通知");
  await h.waitText(".test-notification", "没有配置任何通知渠道");
  await h.shot("11-config");
  step("配置：单独设置阅读时长并保存；发送测试通知显示结果");

  await h.go("#/settings");
  const concurrency = await h.waitText(".settings-grid label", "同时运行的账号数");
  await h.type(await concurrency.findElement(By.css("input")), "2");
  await h.clickButton("保存");
  await h.waitText(".notice", "面板设置已保存");
  assert.strictEqual((await call("GET", "api/settings")).settings.maxConcurrentRuns, 2);
  const globalDuration = await h.field("阅读时长（分钟）");
  await h.type(await globalDuration.findElement(By.css("input")), "68");
  await h.openGroup("Bark 推送");
  const bark = await h.field("Bark Key");
  await h.type(await bark.findElement(By.css("input")), "ui-secret-key");
  await h.clickButton("保存配置");
  await h.waitText(".notice", "全局默认配置已保存");
  const settings = await call("GET", "api/settings");
  assert.deepStrictEqual([settings.defaults.duration, settings.defaults.barkKey], [68, "••••••"]);
  await h.waitText(".config-form", "已设置，留空不修改", 5000).catch(async () => {
    const placeholder = await (await h.field("Bark Key")).findElement(By.css("input")).getAttribute("placeholder");
    assert.strictEqual(placeholder, "已设置，留空不修改");
  });
  const passwordForm = await h.waitText("form.narrow", "当前密码");
  const inputs = await passwordForm.findElements(By.css("input"));
  await inputs[0].sendKeys(panel.generatedPassword);
  await inputs[1].sendKeys(NEW_PASSWORD);
  await inputs[2].sendKeys(NEW_PASSWORD);
  await h.clickButton("修改密码");
  await h.waitText(".notice", "密码已修改");
  // 修改密码后其他会话（包括本脚本调用接口的会话）失效，新密码可以登录
  await call("POST", "api/auth/login", { password: NEW_PASSWORD });
  assert.ok(Array.isArray((await call("GET", "api/accounts")).accounts), "新密码应能登录");
  await h.shot("12-settings");
  step("设置：保存面板设置与全局默认配置（密钥只显示已设置）；修改面板密码");

  await h.go("#/accounts/new");
  const form = await h.waitFor("article.narrow form");
  const [idInput, nameInput] = await form.findElements(By.css("input"));
  await idInput.sendKeys("new-1");
  await nameInput.sendKeys("新账号");
  await h.shot("13-new-account");
  await h.clickButton("创建");
  await driver.wait(async () => (await driver.getCurrentUrl()).endsWith("#/accounts/new-1/live"), 10000, "创建后应进入账号页面");
  await h.waitText(".notice", "账号已创建");
  await h.go("#/accounts/new-1/config");
  await h.clickButton("删除账号");
  await driver.wait(until.alertIsPresent(), 5000);
  await (await driver.switchTo().alert()).accept();
  await driver.wait(async () => (await driver.getCurrentUrl()).endsWith("#/"), 10000, "删除后应回到总览");
  assert.ok(!(await call("GET", "api/accounts")).accounts.some((account) => account.id === "new-1"));
  step("新建账号后进入账号页面；删除账号前确认，删除后回到总览");

  // 断线重连：服务端断开所有连接后，页面提示并自动重连，之后的运行状态照常推送
  await h.go("#/accounts/slow-1/live");
  await h.waitFor(".run-buttons button");
  panel.server.closeAllConnections();
  await h.waitText(".connection", "实时连接已断开");
  await driver.wait(async () => (await driver.findElements(By.css(".connection"))).length === 0, 15000, "应自动重新连接");
  await call("POST", "api/accounts/slow-1/runs", {});
  await h.waitText(".live-status", "阅读中");
  await h.clickButton("停止");
  await h.waitText(".live-status", "已停止");
  step("实时推送断开后提示并自动重连，重连后继续收到运行状态");

  const errors = (await h.consoleErrors()).filter((line) => !/api\/events .*net::ERR/.test(line));
  assert.deepStrictEqual(errors, [], `浏览器控制台不应有错误或警告：\n${errors.join("\n")}`);
  step("浏览器控制台没有错误与警告（包括 CSP 拦截）");

  await h.click(await h.waitText("header nav a", "退出"));
  await h.waitFor("#login-form");
  step("退出后回到登录页");
}

// ---------- 手机 ----------

async function mobile(env, h, driver, results) {
  const { base } = env;
  await login(h, base, NEW_PASSWORD);
  await h.clickButton("仅登录", await h.card("扫码测试"));
  await h.waitFor(".scan-card img.qr");
  const pages = [
    ["m01-overview", "#/", ".account-card"],
    ["m02-live-scan", "#/accounts/qr-1/live", ".live .qr-login img.qr"],
    ["m03-history", "#/accounts/ok-1/history", "table.history tbody tr"],
    ["m04-calendar", "#/accounts/ok-1/calendar", ".calendar .day"],
    ["m05-schedules", "#/accounts/ok-1/schedules", ".schedule-rule"],
    ["m06-config", "#/accounts/ok-1/config", ".config-form"],
    ["m07-settings", "#/settings", ".settings-grid"],
  ];
  for (const [name, hash, css] of pages) {
    await h.go(hash);
    await h.waitFor(css);
    await driver.sleep(300);
    await h.noHorizontalScroll(name);
    await h.shot(name);
  }
  await h.go("#/accounts/qr-1/live");
  await h.clickButton("停止");
  await h.waitText(".live-status", "已停止");
  const errors = await h.consoleErrors();
  assert.deepStrictEqual(errors, [], `浏览器控制台不应有错误或警告：\n${errors.join("\n")}`);
  results.push("手机");
  console.log("✅ 手机宽度（390px）：总览、实时、历史、日历、调度、配置、设置都没有横向滚动，控制台没有错误");
}

async function main() {
  const env = await startSeededPanel();
  const results = [];
  const drivers = [];
  try {
    for (const [run, options, prefix] of [
      [desktop, {}, "d"],
      [mobile, { mobile: true }, ""],
    ]) {
      const driver = await createDriver(options);
      drivers.push(driver);
      await run(env, helpers(driver, prefix), driver, results);
    }
    console.log(`\n页面 smoke 全部通过（${results.length} 项）。截图：${SHOTS}`);
  } finally {
    await Promise.all(drivers.map((driver) => driver.quit().catch(() => {})));
    await env.panel.close();
    fs.rmSync(env.dataDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(`页面 smoke 失败: ${error.message}`);
  console.error(`截图：${SHOTS}`);
  process.exit(1);
});
