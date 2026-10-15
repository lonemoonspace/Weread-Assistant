## 开发说明

浏览器只在 Selenium 中运行，本地开发也需要一个 Selenium 服务。

```bash
# 安装依赖
npm install

# 启动 Selenium（Chromium 在容器中运行，7900 端口可用浏览器查看画面）
docker run -d --name selenium -p 4444:4444 -p 7900:7900 --shm-size 2g selenium/standalone-chromium:latest

# 运行一次自动阅读，产物写入 ./data
SELENIUM_URL=http://localhost:4444 npm start

# 调试日志
SELENIUM_URL=http://localhost:4444 npm run debug

# 查看帮助与全部环境变量
node src/cli.js help

# 测试
npm run test:notify
SELENIUM_URL=http://localhost:4444 npm run test:reader   # 用本地模拟页面跑阅读流程，需要 Selenium
npm run test:runtime   # 需要 Docker

# 只登录并保存 cookies
SELENIUM_URL=http://localhost:4444 node src/cli.js run --login-only
```

没有 Docker 时，可以用与本机 Chrome 版本一致的 chromedriver 代替 Selenium：先执行 `chromedriver --port=9515`，再以 `SELENIUM_URL=http://localhost:9515` 运行。

`test:reader` 会在本机启动模拟页面服务，浏览器需要能访问它：Selenium 跑在容器里时用 `--network host` 启动，或通过 `MOCK_HOST` 指定浏览器访问本机时使用的地址。

### 代码结构

| 路径 | 内容 |
| --- | --- |
| `src/cli.js` | 命令行入口 |
| `src/config/` | 配置项清单（`schema.js`）与配置解析（`resolve.js`） |
| `src/reader/` | 自动阅读流程：连接浏览器、登录、选书、阅读循环、单次运行编排；页面定位器集中在 `selectors.js`，见 `docs/reader.md` |
| `src/notify/` | Bark、ntfy、邮件通知 |
| `src/shared/` | 日志、HTTP、版本号等公共工具 |
| `scripts/` | smoke 测试与镜像构建脚本 |
| `docs/`、`cases/` | 功能说明与验收用例；整体设计见 `docs/design.md` |
