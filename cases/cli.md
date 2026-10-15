## CLI 验收用例

| 场景 | 前置条件 / 输入 | 预期结果 |
| --- | --- | --- |
| 查看帮助 | 执行 `node src/cli.js help`（或不带参数、`-h`、`--help`） | 输出 `run`、`help` 用法与全部环境变量清单，不启动浏览器 |
| 未知命令 | 执行 `node src/cli.js bogus` | 报错 `Unknown command: bogus`，退出码 1 |
| `run` 拒绝额外参数 | 执行 `node src/cli.js run --weread-duration 30` | 报错 `Unexpected arguments for run`，退出码 1 |
| 连接 Selenium | 启动 Selenium（或 chromedriver）后执行 `SELENIUM_URL=http://localhost:4444 node src/cli.js run` | 日志依次出现 `Selenium 健康检查 /status 响应: ready=true`、`SELENIUM_URL:`、`Browser launched successfully.`、`Successfully opened the url: https://weread.qq.com/` |
| 未登录时展示二维码 | 数据目录中没有 `cookies.json` | 保存 `login.png`，日志输出 `登录链接: https://weread.qq.com/web/confirm?uid=...`，进入 `Waiting for login...`；约 1 分钟后二维码过期，日志出现 `Refreshing QR code...` 并自动刷新 |
| 默认数据目录 | 不设置 `WEREAD_DATA_DIR` 执行 `run` | 产物写入当前目录下的 `data/` |
| 镜像默认命令 | 执行 `docker run --rm -e SELENIUM_URL=<地址> -v ./data:/app/data <镜像>` | 执行 `run`，产物写入宿主机 `./data` |
