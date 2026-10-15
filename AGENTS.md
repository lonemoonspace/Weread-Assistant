# Repository Guidelines

## 项目结构与模块组织
- 整体设计与开发计划见 `docs/design.md`，改动前先确认属于计划中的哪一步。
- `src/cli.js` 是唯一入口；`src/config/` 定义配置项清单与解析，`src/reader/` 是自动阅读流程（浏览器、登录、选书、阅读循环），`src/notify/` 是 Bark / ntfy / 邮件通知，`src/panel/` 是 Web 面板（服务端、鉴权、存储与页面），`src/shared/` 放日志、HTTP 等公共工具。
- 新增配置项时只改 `src/config/schema.js`，帮助输出与后续面板表单都由它生成；整数项用 `min` / `max` 限定范围，枚举项用 `options` 列出可选值，解析时会据此校验。
- 页面定位器与关键文案集中在 `src/reader/selectors.js`；浏览器隐式等待为 0，需要等元素出现时使用 `src/reader/dom.js` 中的显式等待。
- 运行产物（cookies.json、login.png、截图、output.log）写入数据目录（默认 `data/`），该目录已在 `.gitignore` 与 `.dockerignore` 中排除。

## 构建、测试与开发命令
- `npm install`：安装依赖，依赖升级时记录 package-lock 差异。
- `SELENIUM_URL=http://localhost:4444 npm start`：连接本地 Selenium 运行一次；`npm run debug` 打开调试日志。浏览器只在 Selenium 中运行，不支持在本机启动浏览器。
- `npm run panel`：本地启动面板（默认端口 26868，首次启动在输出中打印初始密码）。
- `node src/cli.js help`：查看命令与全部环境变量。
- `docker compose up -d`：拉起面板（`app`）与 `selenium`；`docker compose run --rm reader` 按环境变量运行一次阅读（第 6 步前的临时方式）；结束后执行 `docker compose down` 清理资源。

## 编码风格与命名约定
- 统一采用 2 space 缩进；CommonJS `require` / `module.exports`；异步流程优先 async/await。
- 常量使用 SCREAMING_SNAKE_CASE，内部变量与函数沿用 camelCase。
- 运行配置是不可变对象，通过参数传给各模块，不要新增模块级可变状态。
- 日志通过 `console.info|warn|error` 输出，由 `src/shared/log.js` 统一加前缀并写入日志文件。

## 测试指南
- 提交前至少执行 `npm run test:notify`、`npm run test:panel` 与 `npm run test:config`；改动阅读流程时执行 `SELENIUM_URL=... npm run test:reader`（本地模拟页面）；改动镜像时执行 `npm run test:runtime`。
- 改动阅读流程或定位器时，再连接 Selenium 对真实站点运行一次，确认登录、翻页链路；验收用例见 `cases/`。

## 提交与 Pull Request 指南
- Git 历史遵循 Conventional Commits，格式为 `type(scope?): subject`，例如 `feat(panel): add login page`、`fix(reader): ...`。
- Pull Request 描述需包含：背景、变更要点、运行命令、环境变量配置、截图或 `output.log` 片段；若关联 issue 请在描述结尾附 `Closes #id`。

## 配置与安全提示
- 本项目是非官方项目，不得以微信读书或腾讯官方名义描述或包装。
- 不收集、不上报任何使用数据，不要新增统计上报。
- 所有敏感凭据通过配置传递，严禁在仓库中硬编码邮箱密码、Bark key、ntfy topic/token；本地可用 `.env.local`（已在 `.gitignore` 中）。
- 面板页面不得使用内联脚本或内联样式（CSP 只允许同源资源）；修改类接口需校验 `X-WA-Request` 请求头。
- 部署 Selenium 时保证 `--shm-size 2gb` 以避免 Chrome crash；远程运行后及时清理 `login.png` 并注意 cookies 等同于登录态。
