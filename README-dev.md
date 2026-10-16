## 开发说明

浏览器只在 Selenium 中运行，本地开发也需要一个 Selenium 服务。

```bash
# 安装依赖
npm install

# 启动 Selenium（Chromium 在容器中运行，7900 端口可用浏览器查看画面）
docker run -d --name selenium -p 4444:4444 -p 7900:7900 --shm-size 2g selenium/standalone-chromium:latest

# 启动面板（首次启动时在输出中打印初始密码），浏览器打开 http://localhost:26868/
# SELENIUM_URL 只在首次启动时写入面板的全局配置，之后在面板中修改
SELENIUM_URL=http://localhost:4444 npm start

# 用 Docker 启动面板与 Selenium
docker compose up -d

# 查看帮助与面板环境变量
node src/cli.js help

# 测试
npm run test:notify
npm run test:panel     # 面板鉴权、接口、运行队列（桩子进程）与调度，不需要浏览器
npm run test:config    # 配置解析与校验
SELENIUM_URL=http://localhost:4444 npm run test:reader   # 用本地模拟页面跑阅读流程，需要 Selenium
SELENIUM_URL=http://localhost:4444 npm run test:ui       # 用浏览器走通面板各页面并截图（桌面与手机宽度），需要 Selenium
npm run test:runtime   # 需要 Docker

# 按面板中的账号配置在命令行运行一次（账号、配置与调度都在面板中设置），用于调试
node src/cli.js run --account <id>
node src/cli.js run --account <id> --login-only   # 只登录并保存 cookies
```

没有 Docker 时，可以用与本机 Chrome 版本一致的 chromedriver 代替 Selenium：先执行 `chromedriver --port=9515`，再以 `SELENIUM_URL=http://localhost:9515` 运行。

`test:reader` 会在本机启动模拟页面服务，浏览器需要能访问它：Selenium 跑在容器里时用 `--network host` 启动，或通过 `MOCK_HOST` 指定浏览器访问本机时使用的地址。`test:ui` 同理（`PANEL_HOST_FOR_BROWSER`），截图保存位置见输出，也可用 `UI_SMOKE_SCREENSHOTS` 指定。

面板前端免构建，直接修改 `src/panel/public/assets/app/` 下的文件后刷新页面即可。

### 代码结构

| 路径 | 内容 |
| --- | --- |
| `src/cli.js` | 命令行入口 |
| `src/config/` | 配置项清单（`schema.js`）与配置解析（`resolve.js`） |
| `src/reader/` | 自动阅读流程：连接浏览器、登录、选书、阅读循环、单次运行编排，以及由面板启动的阅读子进程 `worker.js`；页面定位器集中在 `selectors.js`，见 `docs/reader.md` |
| `src/notify/` | Bark、ntfy、邮件通知 |
| `src/panel/` | Web 面板：服务端、鉴权、`panel.json` 存储、运行队列与页面，见 `docs/panel.md` |
| `src/shared/` | 日志、HTTP、版本号等公共工具 |
| `scripts/` | smoke 测试与镜像构建脚本 |
| `docs/`、`cases/` | 功能说明与验收用例；整体设计见 `docs/design.md` |
