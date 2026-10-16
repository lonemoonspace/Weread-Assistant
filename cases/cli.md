## CLI 验收用例

| 场景 | 前置条件 / 输入 | 预期结果 |
| --- | --- | --- |
| 查看帮助 | 执行 `node src/cli.js help`（或 `-h`、`--help`） | 输出 `panel`、`run --account`、`help` 用法与面板环境变量清单（含 `SELENIUM_URL`），不列出阅读相关的环境变量，不启动浏览器 |
| 启动面板 | 执行 `node src/cli.js`（或 `panel`、`PANEL_PORT=30000 node src/cli.js`） | 输出 `面板已启动：http://0.0.0.0:<端口>/`；首次启动时额外输出初始密码 |
| 面板不接受参数 | 执行 `node src/cli.js panel --port 1234` | 报错 `Unexpected arguments for panel: --port 1234`，退出码 1；端口只能通过 `PANEL_PORT` 设置 |
| `run` 必须指定账号 | 执行 `node src/cli.js run` 或 `node src/cli.js run --login-only`（即使设置了 `WEREAD_DURATION` 等旧环境变量） | 报错 `run 需要指定账号：node src/cli.js run --account <id>（账号在面板中创建）`，退出码 1，不启动浏览器 |
| 未知命令 | 执行 `node src/cli.js bogus` | 报错 `Unknown command: bogus`，退出码 1 |
| `run` 拒绝额外参数 | 执行 `node src/cli.js run --weread-duration 30` | 报错 `Unexpected arguments for run`，退出码 1 |
| 连接 Selenium | 面板全局配置中的 Selenium 地址指向已启动的 Selenium（或 chromedriver），执行 `node src/cli.js run --account me` | 日志依次出现 `Selenium 状态（<地址>）：就绪`（Selenium Grid 还带已用/总会话数）、`SELENIUM_URL:`、`Browser launched successfully.`、`Successfully opened the url: https://weread.qq.com/` |
| 未登录时展示二维码 | 数据目录中没有 `cookies.json` | 保存 `login.png` 与 `login-qr.png`；日志输出 `已解析登录链接…`，终端另外显示二维码与 `登录链接: https://weread.qq.com/web/confirm?uid=...`（只输出到终端，`output.log` 中没有登录链接）；进入 `Waiting for login...`；二维码约 1 分钟过期，日志出现 `Refreshing QR code...` 并自动刷新，直到扫码成功或超过等待扫码时长 |
| 按账号运行 | 面板中已有账号 `me`，执行 `node src/cli.js run --account me` | 日志首行为 `账号: me 数据目录: <面板数据目录>/accounts/me`，按面板中的配置运行，产物写入该目录 |
| 账号不存在 | 执行 `node src/cli.js run --account nobody` | 报错 `账号不存在：nobody`，退出码 1 |
| 账号已停用 | 账号 `off` 在面板中已停用，执行 `node src/cli.js run --account off` | 报错 `账号已停用：off，请先在面板中启用`，退出码 1，不连接浏览器 |
| 仅登录 | 执行 `node src/cli.js run --account me --login-only` | 登录并保存 `cookies.json` 后结束，不打开书籍；成功时退出码 0 |
| 停止 | `run --account me --login-only` 等待扫码时发送 SIGTERM（或按 Ctrl+C） | 日志出现 `收到 SIGTERM，正在停止...`、`Browser closed.`、`Run finished: stopped`，约 0.1 秒内以退出码 1 退出，不推送「运行失败」 |
| 退出码 | 账号 `me` 的等待扫码时长设为 2 分钟，不扫码执行 `run --account me` | 约 2 分钟后日志出现 `等待扫码超时（2 分钟）`、`Run finished: login-timeout`，退出码 1 |
| 默认数据目录 | 不设置 `PANEL_DATA_DIR` 执行 `run --account me` | 读取当前目录下的 `data/panel.json`，产物写入 `data/accounts/me/` |
| 镜像默认命令 | 执行 `docker run -d -p 127.0.0.1:26868:26868 -v ./data:/app/data <镜像>` | 启动面板，`panel.json` 写入宿主机 `./data` |
