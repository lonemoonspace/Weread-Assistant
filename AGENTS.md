# Repository Guidelines

## 项目结构与模块组织
- 整体设计与开发计划见 `docs/design.md`，改动前先确认属于计划中的哪一步。
- `src/cli.js` 是唯一入口；`src/config/` 定义配置项清单与解析，`src/reader/` 是自动阅读流程（浏览器、登录、选书、阅读循环），`src/notify/` 是 Bark / ntfy / 邮件通知，`src/panel/` 是 Web 面板（服务端、鉴权与 passkey、存储、运行队列与页面），`src/shared/` 放日志、HTTP 等公共工具。
- 新增运行配置项时只改 `src/config/schema.js`，面板表单与校验都由它生成，不新增对应的环境变量；整数项用 `min` / `max` 限定范围，枚举项用 `options` 列出可选值，解析时会据此校验。
- 页面定位器与关键文案集中在 `src/reader/selectors.js`；浏览器隐式等待为 0，需要等元素出现时使用 `src/reader/dom.js` 中的显式等待。
- 面板中的每次运行由 `src/panel/runner.js` fork 阅读子进程 `src/reader/worker.js` 执行：配置经 IPC 下发，不放进环境变量；子进程经 IPC 上报事件，新增事件时同步更新 `docs/reader.md` 与 `docs/panel.md`。阅读流程中较长的等待要传入 `ctx.signal`，保证停止时能立即结束。
- 运行产物写入数据目录（默认 `data/`）：账号的 cookies.json、login.png 在 `accounts/<id>/`，每次运行的 meta.json、output.log、阅读截图在 `runs/<id>/<运行 ID>/`。该目录已在 `.gitignore` 与 `.dockerignore` 中排除。按天统计以 meta.json 中的 `minuteMarks` 为准，改动运行记录格式时保持兼容旧记录。

## 构建、测试与开发命令
- `npm install`：安装依赖，依赖升级时记录 package-lock 差异。
- `npm start`（同 `npm run panel`）：本地启动面板（默认端口 26868，首次启动在输出中打印初始密码）。阅读配置、通知与调度都在面板中设置，不支持按环境变量运行阅读。面板设置中的 Selenium 地址留空时使用内置浏览器（阅读子进程在本机启动 chromedriver 与无界面的 Chromium，见 `src/shared/local-browser.js`）；填写时连接该地址的 Selenium，首次启动可用 `SELENIUM_URL` 写入。
- `node src/cli.js run --account <id>`：按面板中的账号配置在命令行运行一次，用于调试。
- `node src/cli.js help`：查看命令与面板环境变量。
- `docker compose up -d`：拉起面板（`app`，镜像中带 Chromium 与 chromedriver）；结束后执行 `docker compose down` 清理资源。

## 编码风格与命名约定
- 统一采用 2 space 缩进；CommonJS `require` / `module.exports`；异步流程优先 async/await。
- 常量使用 SCREAMING_SNAKE_CASE，内部变量与函数沿用 camelCase。
- 运行配置是不可变对象，通过参数传给各模块，不要新增模块级可变状态。
- 日志通过 `console.info|warn|error` 输出，由 `src/shared/log.js` 统一加前缀并写入日志文件。

## 测试指南
- 提交前至少执行 `npm run check`、`npm run test:notify`、`npm run test:panel` 与 `npm run test:config`；改动阅读流程或阅读子进程时执行 `SELENIUM_URL=... npm run test:reader`（本地模拟页面；`SELENIUM_URL=` 为空时用内置浏览器）；改动镜像时执行 `npm run test:runtime`。
- 改动阅读流程或定位器时，再连接 Selenium 对真实站点运行一次，确认登录、翻页链路；验收用例见 `cases/`。

## 提交与 Pull Request 指南
- Git 历史遵循 Conventional Commits，格式为 `type(scope?): subject`，例如 `feat(panel): add login page`、`fix(reader): ...`。
- Pull Request 描述需包含：背景、变更要点、运行命令、环境变量配置、截图或 `output.log` 片段；若关联 issue 请在描述结尾附 `Closes #id`。
- 发布版本：修改 `package.json` 的 `version`（同步 lockfile）并在 `CHANGELOG.md` 中加一节，合并到 `main` 后 CI 通过时，由 GitHub Actions 构建、检查并推送 arm64 镜像，并创建 `v<版本号>` tag 与 GitHub Release（不需要手动推送 tag）；不要从本机手动推送正式版本。
- GitHub Actions 中的第三方 Action 按提交 SHA 固定并在注释中写明版本；改动工作流后用 actionlint 检查。

## 配置与安全提示
- 本项目是非官方项目，不得以微信读书或腾讯官方名义描述或包装。
- 不收集、不上报任何使用数据，不要新增统计上报。
- 所有敏感凭据通过配置传递，严禁在仓库中硬编码邮箱密码、Bark key、ntfy topic/token；本地可用 `.env.local`（已在 `.gitignore` 中）。
- 面板页面不得使用内联脚本或内联样式（CSP 只允许同源资源）；修改类接口需校验 `X-WA-Request` 请求头。
- 面板前端免构建：页面代码是 `src/panel/public/assets/app/` 下的 ES 模块，模板写在组件的 `template` 字符串中；不要使用 DOM 模板、`v-html` 或 `:style` 字符串，样式写在 `assets/panel.css`。第三方文件放在 `assets/vendor/`，升级时同步更新其中的 README（版本与 SHA-256）。改动页面时执行 `SELENIUM_URL=... npm run test:ui` 并查看截图。
- 部署 Selenium 时保证 `--shm-size 2gb` 以避免 Chrome crash（内置浏览器以 `--disable-dev-shm-usage` 启动，不需要）；远程运行后及时清理 `login.png` 并注意 cookies 等同于登录态。
- noVNC 只在连接 Selenium 时可用，画面就是已登录的浏览器：不要在文档或配置示例中建议经反向代理或公网暴露 7900 端口；开启时修改 Selenium 默认 VNC 密码，建议只读模式。
