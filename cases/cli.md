## CLI 验收用例

| 场景 | 前置条件 / 输入 | 预期结果 |
| --- | --- | --- |
| 查看帮助 | 执行 `node src/cli.js help`（或 `-h`、`--help`） | 输出 `panel`、`run`、`help` 用法与面板、运行两组环境变量清单，不启动浏览器 |
| 启动面板 | 执行 `node src/cli.js`（或 `panel`、`PANEL_PORT=30000 node src/cli.js`） | 输出 `面板已启动：http://0.0.0.0:<端口>/`；首次启动时额外输出初始密码 |
| 面板不接受参数 | 执行 `node src/cli.js panel --port 1234` | 报错 `Unexpected arguments for panel: --port 1234`，退出码 1；端口只能通过 `PANEL_PORT` 设置 |
| 非法配置 | 执行 `WEREAD_DURATION=0 node src/cli.js run` | 报错 `WEREAD_DURATION 必须在 1–1440 之间：0`，退出码 1，不启动浏览器 |
| 未知命令 | 执行 `node src/cli.js bogus` | 报错 `Unknown command: bogus`，退出码 1 |
| `run` 拒绝额外参数 | 执行 `node src/cli.js run --weread-duration 30` | 报错 `Unexpected arguments for run`，退出码 1 |
| 连接 Selenium | 启动 Selenium（或 chromedriver）后执行 `SELENIUM_URL=http://localhost:4444 node src/cli.js run` | 日志依次出现 `Selenium 健康检查 /status 响应: ready=true`、`SELENIUM_URL:`、`Browser launched successfully.`、`Successfully opened the url: https://weread.qq.com/` |
| 未登录时展示二维码 | 数据目录中没有 `cookies.json` | 保存 `login.png` 与 `login-qr.png`，日志输出 `登录链接: https://weread.qq.com/web/confirm?uid=...`，进入 `Waiting for login...`；二维码约 1 分钟过期，日志出现 `Refreshing QR code...` 并自动刷新，直到扫码成功或超过 `WEREAD_LOGIN_TIMEOUT` |
| 按账号运行 | 面板中已有账号 `me`，执行 `node src/cli.js run --account me` | 日志首行为 `账号: me 数据目录: <面板数据目录>/accounts/me`，按面板中的配置运行，产物写入该目录 |
| 账号不存在 | 执行 `node src/cli.js run --account nobody` | 报错 `账号不存在：nobody`，退出码 1 |
| 账号已停用 | 账号 `off` 在面板中已停用，执行 `node src/cli.js run --account off` | 报错 `账号已停用：off，请先在面板中启用`，退出码 1，不连接浏览器 |
| 仅登录 | 执行 `node src/cli.js run --login-only` | 登录并保存 `cookies.json` 后结束，不打开书籍；成功时退出码 0 |
| 停止 | `run --login-only` 等待扫码时发送 SIGTERM（或按 Ctrl+C） | 日志出现 `收到 SIGTERM，正在停止...`、`Browser closed.`、`Run finished: stopped`，约 0.1 秒内以退出码 1 退出，不推送「运行失败」 |
| 退出码 | 不扫码，`WEREAD_LOGIN_TIMEOUT=2` 执行 `run` | 约 2 分钟后日志出现 `等待扫码超时（2 分钟）`、`Run finished: login-timeout`，退出码 1 |
| 默认数据目录 | 不设置 `WEREAD_DATA_DIR` 执行 `run` | 产物写入当前目录下的 `data/` |
| 镜像默认命令 | 执行 `docker run -d -p 127.0.0.1:26868:26868 -v ./data:/app/data <镜像>` | 启动面板，`panel.json` 写入宿主机 `./data`；按环境变量阅读时需显式执行 `node src/cli.js run` |
