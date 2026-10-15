## 配置解析验收用例

`scripts/config-smoke.js` 验证运行配置与面板参数的解析，不需要浏览器与网络。执行方式：`npm run test:config`。

| 场景 | 输入 | 预期结果 |
| --- | --- | --- |
| smoke 自查 | 执行 `npm run test:config` | 10 个场景全部通过并退出码 0 |
| 默认值 | 不设置任何变量 | 阅读时长 10、选书方式 2、速度 `slow`、不发邮件；配置对象不可修改 |
| 整数格式 | `WEREAD_DURATION=10abc`、`WEREAD_SELECTION=2xyz`、`EMAIL_PORT=465oops`、`WEREAD_DURATION=1.5` | 报错 `<变量> 必须是整数：<值>`；前后空格可以接受 |
| 正整数 | `WEREAD_DURATION=0` 或 `-5`、`WEREAD_LOGIN_TIMEOUT=0` | 报错 `<变量> 必须不小于 1：<值>` |
| 端口范围 | `EMAIL_PORT=70000`、`PANEL_PORT=0`、`PANEL_PORT=70000`、`PANEL_PORT=26868foo` | 报错，端口需在 1–65535 之间且为整数 |
| 可选值 | `WEREAD_SELECTION=-2` 或 `5`、`WEREAD_SPEED=turbo` | 报错 `<变量> 只能是 <可选值>：<值>`；`-1`、`0`、`1`–`4` 与 `fast` 等列出的值可以接受 |
| 布尔值 | `ENABLE_EMAIL=ture` | 报错 `ENABLE_EMAIL 只能是 true 或 false：ture`；`yes`、`off` 等可以接受 |
| 面板代理与子路径 | `PANEL_TRUST_PROXY=maybe`、`PANEL_BASE_PATH=/a b/` | 报错；`true` 为 1 层、`2` 为 2 层、`weread` 规范为 `/weread/` |
| CLI 退出码 | `WEREAD_DURATION=0 node src/cli.js run`、`PANEL_PORT=0 node src/cli.js panel`、`node src/cli.js panel --port 1234`、`node src/cli.js run --account` | 输出对应错误并以退出码 1 结束 |
| 按账号运行 | 面板数据中有账号 `me`（全局 Selenium 地址不可达），执行 `run --account me --login-only`；另执行 `run --account nobody`，以及在没有 `panel.json` 的目录中执行 | 账号不存在、面板数据不存在时分别报错；`me` 的日志写入 `accounts/me/output.log`，使用面板中的 Selenium 地址而不是环境变量，最后一行为 `Run finished: error`，退出码 1 |
