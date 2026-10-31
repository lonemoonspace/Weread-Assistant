## 开发说明

面板设置中的 Selenium 地址留空时使用内置浏览器：阅读子进程在本机启动 chromedriver 与 Chromium（无界面模式），Docker 镜像中已安装。本地开发时可以安装 Chromium 与同版本的 chromedriver 使用内置浏览器，也可以连接一个 Selenium 服务。

```bash
# 安装依赖
npm install

# 启动面板（首次启动时在输出中打印初始密码），浏览器打开 http://localhost:26868/
# 本机 PATH 中有 chromedriver 与 chromium-browser / chromium 时直接使用（也可用 CHROMEDRIVER_PATH、CHROME_BIN 指定）
npm start

# 或连接 Selenium（Chromium 在容器中运行，http://localhost:7900/ 可查看画面；在面板设置中填写该地址后，总览会显示 noVNC 链接）。
# 两个端口都只绑定本机：Selenium 没有认证，能访问 4444 的人都可以驱动这个浏览器；用 SE_VNC_PASSWORD 改掉默认的 VNC 密码。
# SELENIUM_URL 只在首次启动时写入面板的全局配置，之后在面板中修改
docker run -d --name selenium -p 127.0.0.1:4444:4444 -p 127.0.0.1:7900:7900 -e SE_VNC_PASSWORD=换成你的密码 --shm-size 2g selenium/standalone-chromium:4.51.0-20261010
SELENIUM_URL=http://localhost:4444 npm start

# 用 Docker 启动面板：docker-compose.yml 只拉取发布的镜像，测试本地改动时先构建同名镜像
docker build -t lonemoonspace/weread-assistant:local .
WEREAD_ASSISTANT_TAG=local docker compose up -d

# 查看帮助与面板环境变量
node src/cli.js help

# 测试
npm run check          # 自查：语法（面板页面按 ES 模块）、第三方文件校验值、页面约定
npm run test:notify
npm run test:panel     # 面板鉴权、接口、运行队列（桩子进程）与调度，不需要浏览器
npm run test:config    # 配置解析与校验
SELENIUM_URL=http://localhost:4444 npm run test:reader   # 用本地模拟页面跑阅读流程，需要 Selenium；SELENIUM_URL= 时用内置浏览器
SELENIUM_URL=http://localhost:4444 npm run test:ui       # 用浏览器走通面板各页面并截图（桌面与手机宽度），需要 Selenium
npm run test:runtime   # 需要 Docker

# 按面板中的账号配置在命令行运行一次（账号、配置与调度都在面板中设置），用于调试
node src/cli.js run --account <id>
node src/cli.js run --account <id> --login-only   # 只登录并保存 cookies
```

测试只在 Linux 与 macOS 上运行：`test:panel` 会检查文件权限（0600 / 0700）、子进程的环境变量白名单，以及子进程收到 SIGTERM 后先关闭浏览器再退出，这些在 Windows 上的行为不同。在 Windows 上开发时请使用 WSL；仓库的 `.gitattributes` 固定以 LF 检出，`npm run check` 校验第三方文件的 SHA-256 不受 `core.autocrlf` 影响。

没有 Docker 时，可以用与本机 Chrome 版本一致的 chromedriver 代替 Selenium：先执行 `chromedriver --port=9515`，再以 `SELENIUM_URL=http://localhost:9515` 运行。`test:reader` 也可以用内置浏览器运行（`SELENIUM_URL= npm run test:reader`），CI 在镜像中这样运行，验证镜像中的 Chromium。

`test:reader` 会在本机启动模拟页面服务，浏览器需要能访问它：Selenium 跑在容器里时用 `--network host` 启动，或通过 `MOCK_HOST` 指定浏览器访问本机时使用的地址。`test:ui` 同理（`PANEL_HOST_FOR_BROWSER`），截图保存位置见输出，也可用 `UI_SMOKE_SCREENSHOTS` 指定；passkey 部分需要浏览器用 `localhost` 访问面板（passkey 只能在 HTTPS 或 localhost 上使用），设置了 `PANEL_HOST_FOR_BROWSER` 时跳过。

面板前端免构建，直接修改 `src/panel/public/assets/app/` 下的文件后刷新页面即可。

Pull Request 上的 CI 运行以上全部检查（阅读流程与页面 smoke 使用主机网络的 Selenium 容器，阅读流程 smoke 还在 amd64 镜像中用内置浏览器运行一次；镜像在 QEMU 中按 arm64 构建并运行）；合并到 `main` 后发布 `dev` 镜像，合并改版本号的提交（或推送版本 tag）时发布正式版本，见 `docs/docker-image-publish.md`“自动发布”与 `cases/ci.md`。

### 代码结构

| 路径 | 内容 |
| --- | --- |
| `src/cli.js` | 命令行入口 |
| `src/config/` | 配置项清单（`schema.js`）与配置解析（`resolve.js`） |
| `src/reader/` | 自动阅读流程：连接浏览器、登录、选书、阅读循环、单次运行编排，以及由面板启动的阅读子进程 `worker.js`；页面定位器集中在 `selectors.js`，见 `docs/reader.md` |
| `src/notify/` | Bark、ntfy、邮件通知 |
| `src/panel/` | Web 面板：服务端、鉴权、`panel.json` 存储、运行队列与页面，见 `docs/panel.md` |
| `src/shared/` | 日志、HTTP、Selenium 状态、内置浏览器（`local-browser.js`）、版本号等公共工具 |
| `scripts/` | smoke 测试与镜像构建脚本 |
| `docs/`、`cases/` | 功能说明与验收用例；整体设计见 `docs/design.md` |
