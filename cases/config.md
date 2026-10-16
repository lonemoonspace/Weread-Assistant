## 配置解析验收用例

`scripts/config-smoke.js` 验证运行配置（`resolveConfig`，面板接口使用同一套校验）与面板环境变量的解析，不需要浏览器与网络。错误信息中的名称为配置项的中文名称。执行方式：`npm run test:config`。

| 场景 | 输入 | 预期结果 |
| --- | --- | --- |
| smoke 自查 | 执行 `npm run test:config` | 11 个场景全部通过并退出码 0 |
| 默认值 | 不提供任何配置项 | 阅读时长 10、选书方式 2、速度 `slow`、不发邮件；配置对象不可修改 |
| 整数格式 | 阅读时长 `10abc`、选书方式 `2xyz`、SMTP 端口 `465oops`、阅读时长 `1.5` | 报错 `<配置项名称> 必须是整数：<值>`，如 `阅读时长（分钟） 必须是整数：10abc`；前后空格可以接受 |
| 时长范围 | 阅读时长 `0`、`-5` 或 `1441`，等待扫码时长 `0` | 报错 `<配置项名称> 必须在 1–1440 之间：<值>`；`1` 与 `1440` 可以接受 |
| 超大整数 | 阅读时长为 400 个 9、SMTP 端口 `9007199254740993`、`PANEL_PORT` 为 30 个 9 | 报错 `<名称> 超出允许的范围：<值>`，不会变成 `Infinity` |
| 端口范围 | SMTP 端口 `70000`、`PANEL_PORT=0`、`PANEL_PORT=70000`、`PANEL_PORT=26868foo` | 报错，端口需在 1–65535 之间且为整数 |
| 可选值 | 选书方式 `-2` 或 `5`、阅读速度 `turbo` | 报错 `<配置项名称> 只能是 <可选值>：<值>`；`-1`、`0`、`1`–`4` 与 `fast` 等列出的值可以接受 |
| 布尔值 | 启用邮件通知 `ture` | 报错 `启用邮件通知 只能是 true 或 false：ture`；`yes`、`off` 等可以接受 |
| 面板代理与子路径 | `PANEL_TRUST_PROXY=maybe`、`PANEL_BASE_PATH=/a b/` | 报错；`true` 为 1 层、`2` 为 2 层、`weread` 规范为 `/weread/` |
| CLI 退出码 | `node src/cli.js run` 与 `run --login-only`（设置了 `WEREAD_DURATION`）、`PANEL_PORT=0 node src/cli.js panel`、`node src/cli.js panel --port 1234`、`node src/cli.js run --account` | 输出对应错误并以退出码 1 结束；未指定账号时提示 `run 需要指定账号` |
| 按账号运行 | 面板数据中有账号 `me`（全局 Selenium 地址不可达）与已停用的账号 `off`，执行 `run --account me --login-only`；另执行 `run --account nobody`、`run --account off`，以及在没有 `panel.json` 的目录中执行 | 账号不存在、账号已停用、面板数据不存在时分别报错，停用的账号不开始运行；`me` 的日志写入 `accounts/me/output.log`，使用面板中的 Selenium 地址而不是环境变量，最后一行为 `Run finished: error`，退出码 1；`panel.json` 内容不变 |
