## 自动阅读流程验收用例

`scripts/reader-smoke.js` 用本地模拟页面驱动真实浏览器运行 `runOnce`，并以面板的方式启动阅读子进程，不访问微信读书（书架中找不到书时打开的默认阅读链接也指向模拟页面）。执行方式：`SELENIUM_URL=<Selenium 或 chromedriver 地址> npm run test:reader`。

| 场景 | 前置条件 / 输入 | 预期结果 |
| --- | --- | --- |
| smoke 自查 | 启动 Selenium（或 chromedriver）后执行 `npm run test:reader` | 11 个场景全部通过并退出码 0 |
| 扫码登录 | 未登录；二维码 3 秒过期，第 2 张二维码出现 1.5 秒后扫码；仅登录模式 | 结果为 `success`；至少刷新一次二维码；推送一次「需要扫码」，`click` 为第 1 张二维码解析出的链接；生成 `login.png`、`login-qr.png`；`cookies.json` 含 `wr_vid` |
| 等待扫码超时 | 未登录；二维码 1.5 秒过期且不扫码；等待时长 25 秒 | 结果为 `login-timeout`；二维码刷新不少于 3 次；推送「运行失败」，正文含“等待扫码超时” |
| 二维码图片迟迟不出现 | 未登录，首页有 3 张图片地址含 `wfqqreader` 的书籍封面；弹窗打开 60 秒后才加载二维码图片；数据目录中有之前的 `login-qr.png`；等待时长 3 秒 | 结果为 `login-timeout`；生成整页 `login.png`；之前的 `login-qr.png` 已删除，书籍封面没有被当作二维码截图 |
| cookies 损坏 | `cookies.json` 内容为 `{broken`；已登录 | 结果为 `success`；生成 `cookies.json.corrupt-*` 备份；新的 `cookies.json` 是合法的 JSON 数组 |
| 阅读 | 已登录；书架加载 1.5 秒前只有占位卡片，加载后为 1 篇公众号文章与 3 本书、每本 2 章；选书方式 2；阅读 30 秒，翻动间隔 0.1–0.2 秒 | 不点击占位卡片与公众号文章，打开第 2 本书第 1 章并切换到上下滚动模式；翻到第 2 章；读完后回到第 1 章；30 秒内翻动不少于 30 次；推送「阅读完成」，不推送「登录成功」 |
| 目录只有一项、白屏刷新 | 已登录；书只有 1 章且目录开头有“扉页”；直接打开阅读链接；开启截图，每 4 秒算一分钟 | 读完后点击目录中唯一的条目（扉页）且不报错；生成 `screenshot-1.png`；截图小于 100KB 时刷新页面 |
| 阅读子进程：事件 | fork `src/reader/worker.js` 并经 IPC 下发配置与截图目录；未登录，第 1 张二维码出现 6 秒后扫码；直接打开阅读链接；阅读 9 秒，每 3 秒算一分钟，开启截图 | 退出码 0；事件依次为 `started`、`session`、`login-required`（`url` 为二维码中的链接）、`login-ok`、`book-opened`（`title` 为书名）、逐分钟的 `reading-minute`（`total` 为 3，`screenshot` 为截图文件名）、`done`；截图写入指定的截图目录而不是账号数据目录，是可解码的 PNG、权限 0600，cookies 仍在账号数据目录；结束后浏览器会话已关闭；标准输出每行带级别与时间，连接浏览器前记录 `Selenium 状态（<地址>）：就绪`，不含二维码字符画；日志中出现 `已解析登录链接`，不出现登录链接与 `uid=` |
| 阅读子进程：停止 | 已登录；阅读 2 分钟，翻动间隔 8–10 秒；收到第一个 `reading-minute` 1.5 秒后发送 SIGTERM | 4 秒内以退出码 0 退出（实测约 0.1 秒）；不上报 `error` 与 `done`；浏览器会话已关闭；日志出现 `收到 SIGTERM，停止运行`、`Browser closed.`、`Run finished: stopped`；不推送「运行失败」 |
| 阅读子进程：连不上 Selenium | Selenium 地址为 `http://robot:pw-9527@127.0.0.1:<没有程序监听的端口>` | 退出码 0；上报 `error`，消息为 `无法连接 Selenium（http://127.0.0.1:<端口>）：连接被拒绝（ECONNREFUSED），请确认 Selenium 正在运行、地址正确`；日志中有 `Selenium 状态（http://127.0.0.1:<端口>）：无法连接，连接被拒绝（ECONNREFUSED）`，不出现密码 `pw-9527`；推送「运行失败」 |
| 真实站点：仅登录 | 面板中账号 `me` 的等待扫码时长设为 2 分钟，执行 `node src/cli.js run --account me --login-only`，不扫码 | 日志依次出现找到二维码、`已解析登录链接`（`output.log` 中没有登录链接本身）、`Refreshing QR code...`（约每分钟一次）、`距上次推送登录链接不足 3 分钟，本次不推送`、`等待扫码超时（2 分钟）`；进程退出码 1 |
| 真实站点：完整阅读 | 扫码登录后执行 `node src/cli.js run --account me`，或在面板中立即运行 | 打开书籍并切换上下滚动，日志出现书名、每分钟的 `Reading minute`，按配置的节奏翻动，结束时推送「阅读完成」 |
