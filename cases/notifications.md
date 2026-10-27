## 推送通知验收用例

| 场景 | 前置条件 / 输入 | 预期结果 |
| --- | --- | --- |
| smoke 自查 | 在仓库根目录执行 `node scripts/notify-smoke.js` | 15 个场景全部通过并退出码 0，全程不访问外网、不需要真实密钥 |
| Bark 负载保持 | 配置 `barkKey` 与指向 mock 服务的 `barkServer`，调用 `sendBark` | 请求路径为 `/<barkKey>`，负载包含 `title`/`body`/`sound`/`group`/`level` 及可选 `subtitle`/`url`/`image`；日志记录 `发送Bark推送: <服务器地址>`，不出现 Bark Key |
| ntfy 负载映射 | 配置 `ntfyTopic` 与指向 mock 服务的 `ntfyServer`，调用 `sendNtfy` 并传入 `level=critical`、`sound=alarm`、`url`、`image`、`actions` | 请求为 JSON POST 到服务器根路径，负载包含 `topic`/`message`/`priority=5`/`tags=[rotating_light]`/`click`/`attach`/`actions` |
| ntfy 认证 | 分别只配置 `ntfyToken`，以及只配置 `ntfyUsername` + `ntfyPassword` | 请求头分别为 `Authorization: Bearer <token>` 与 `Authorization: Basic <base64>` |
| ntfy 覆盖项 | 配置 `ntfyPriority` 为 `5`、`ntfyTags` 为 `book,heavy_check_mark` 后发送 | 负载使用 `priority=5` 与配置的标签列表，不再使用默认映射 |
| 非法主题拦截 | 配置包含空格或特殊字符的 `ntfyTopic` | 打印明确错误，`sendNtfy` 返回 `false`，且不发起任何 HTTP 请求 |
| 多渠并推 | 同时配置 `barkKey` 与 `ntfyTopic`，调用 `notify` | 两个渠道并发各收到一次请求，返回 `[{channel:"bark",ok:true},{channel:"ntfy",ok:true}]` |
| 未配置渠道 | 不配置任何推送渠道，调用 `notify` | 打印未启用提示，返回空数组，不发起请求、不抛异常 |
| 失败隔离 | Bark 指向不可达地址，ntfy 指向可用 mock 服务，调用 `notify` | ntfy 仍返回成功；Bark 结果为 `ok:false`，主流程不中断 |
| 推送接口异常响应 | 本地服务分别：返回响应头后每 50ms 发送一个字节且从不结束、返回一部分后断开连接、返回 2 MB 响应体；以 0.3 秒或 3 秒的时限调用 `postJson` | 持续发送数据时 3 秒内返回 `ok:false`、`request timeout after 300ms`；中途断开与响应过大（超过 1 MB）时返回 `ok:false`，不会一直等待 |
| 登录链接推送 | 配置 `ntfyTopic`，用 `createNotifier(config).loginLink(url)` 推送同一链接两次 | 只发出一次 ntfy 通知；标题为 `WeReadAssistant · 需要扫码`、优先级 4，正文含登录链接，`click` 为登录链接，只有「打开登录链接」一个按钮，没有 `attach`，负载中不出现 `qrserver` |
| 登录链接限频 | `createNotifier(config, { loginLinkIntervalMs: 60000 })` 连续推送两个不同链接 | 只推送第一个链接 |
| 账号名与事件开关 | 配置 `accountName` 为 `小明`，依次触发 `start`、`loginSuccess`、`done`、`failure` | 只推送 `done` 与 `failure`，标题分别为 `WeReadAssistant · 小明 · 阅读完成`、`WeReadAssistant · 小明 · 运行失败`；设置 `notifyOnStart` 为 true、`notifyOnDone` 为 false 后改为推送 `start`、不推送 `done` |
| 邮件 | 启动本地 SMTP 服务（不支持 TLS），配置账号名 `小明` 与邮件（端口为该服务端口），触发 `done` 并附一张截图；再发送测试通知；之后让 SMTP 拒绝认证、再关闭 SMTP 服务，各发送一次测试通知 | 以 `AUTH PLAIN` 认证，用户名与密码正确；发件人为邮箱账号、收件人为配置的地址；主题为 `WeReadAssistant · 小明 · 阅读完成 [v<版本号>]`；截图以 `screenshot-1.png` 内嵌（`Content-ID: <screenshot-1.png>`），带 HTML 正文；测试通知返回 `[{channel:"email",ok:true}]`，主题含“测试通知”；认证失败与无法连接时返回 `ok:false`；日志中不出现邮箱密码 |
