## 推送通知验收用例

| 场景 | 前置条件 / 输入 | 预期结果 |
| --- | --- | --- |
| smoke 自查 | 在仓库根目录执行 `node scripts/notify-smoke.js` | 8 个场景全部通过并退出码 0，全程不访问外网、不需要真实密钥 |
| Bark 负载保持 | 配置 `BARK_KEY` 与指向 mock 服务的 `BARK_SERVER`，调用 `sendBark` | 请求路径为 `/<BARK_KEY>`，负载包含 `title`/`body`/`sound`/`group`/`level` 及可选 `subtitle`/`url`/`image` |
| ntfy 负载映射 | 配置 `NTFY_TOPIC` 与指向 mock 服务的 `NTFY_SERVER`，调用 `sendNtfy` 并传入 `level=critical`、`sound=alarm`、`url`、`image`、`actions` | 请求为 JSON POST 到服务器根路径，负载包含 `topic`/`message`/`priority=5`/`tags=[rotating_light]`/`click`/`attach`/`actions` |
| ntfy 认证 | 分别只配置 `NTFY_TOKEN`，以及只配置 `NTFY_USERNAME` + `NTFY_PASSWORD` | 请求头分别为 `Authorization: Bearer <token>` 与 `Authorization: Basic <base64>` |
| ntfy 覆盖项 | 配置 `NTFY_PRIORITY=5` 与 `NTFY_TAGS=book,heavy_check_mark` 后发送 | 负载使用 `priority=5` 与配置的标签列表，不再使用默认映射 |
| 非法主题拦截 | 配置包含空格或特殊字符的 `NTFY_TOPIC` | 打印明确错误，`sendNtfy` 返回 `false`，且不发起任何 HTTP 请求 |
| 多渠并推 | 同时配置 `BARK_KEY` 与 `NTFY_TOPIC`，调用 `notify` | 两个渠道并发各收到一次请求，返回 `[{channel:"bark",ok:true},{channel:"ntfy",ok:true}]` |
| 未配置渠道 | 不配置任何推送渠道，调用 `notify` | 打印未启用提示，返回空数组，不发起请求、不抛异常 |
| 失败隔离 | Bark 指向不可达地址，ntfy 指向可用 mock 服务，调用 `notify` | ntfy 仍返回成功；Bark 结果为 `ok:false`，主流程不中断 |
| 登录链接推送 | 配置 `NTFY_TOPIC` 并触发 `notifyLoginLink` | ntfy 通知包含登录链接正文、`click` 为登录链接、`attach` 为二维码图片，并附带「打开登录链接」「查看二维码」两个 `view` 按钮 |
| CLI 参数覆盖 | 执行 `node src/weread-challenge.js run --ntfy-topic t1 --ntfy-server http://127.0.0.1:9 --ntfy-priority high` | 运行配置中的 `NTFY_TOPIC`/`NTFY_SERVER`/`NTFY_PRIORITY` 分别被覆盖为 `t1`/`http://127.0.0.1:9`/`high` |
| 帮助可见性 | 执行 `node src/weread-challenge.js help run` | 输出包含 `--ntfy-topic`、`--ntfy-server`、`--ntfy-token`、`--ntfy-username`、`--ntfy-password`、`--ntfy-priority`、`--ntfy-tags` 及其对应环境变量名 |
