## Web 面板验收用例

`scripts/panel-smoke.js` 在本机启动面板，用 HTTP 请求验证以下场景，不需要浏览器与 Selenium。运行队列的场景使用桩子进程 `scripts/fixtures/stub-worker.js`（与阅读子进程协议相同，按账号 ID 前缀决定行为），停止的等待时间缩短为 0.5 秒。执行方式：`npm run test:panel`。

| 场景 | 前置条件 / 输入 | 预期结果 |
| --- | --- | --- |
| smoke 自查 | 执行 `npm run test:panel` | 30 个场景全部通过并退出码 0 |
| 首次启动生成密码 | 空数据目录、未设置 `PANEL_PASSWORD` | 生成 16 位密码；`panel.json` 只保存 scrypt 哈希且权限为 0600；再次启动不再生成，原密码可登录 |
| 未登录访问 | 不带会话 | `healthz` 返回 `{"status":"ok"}`；`/` 302 到 `login`；登录页与静态资源可访问；`api/auth/session` 返回 401 |
| 登录与退出 | 设置 `PANEL_PASSWORD` | 错误密码 401；正确密码 204，`Set-Cookie` 带 `HttpOnly`、`SameSite=Strict`、`Path=/`，HTTP 下不带 `Secure`；登录后可访问首页；退出后会话失效 |
| 跨站请求伪造防护 | 不带 `X-WA-Request` 或使用表单格式提交 | 分别返回 403 与 415；非法 JSON 返回 400 |
| 按 IP 限速 | 同一 IP 连续 5 次密码错误 | 第 5 次返回 401 并带 `Retry-After`；锁定期间正确密码也返回 429；解锁后可正常登录 |
| 信任代理 | `PANEL_TRUST_PROXY=1`，不同的 `X-Forwarded-For` | 按转发的 IP 分别计数；`X-Forwarded-Proto: https` 时 cookie 带 `Secure`；不信任代理时伪造的请求头不起作用 |
| 全局限速 | 不同 IP 累计失败达到上限 | 所有 IP 暂停登录，窗口过后恢复 |
| 子路径部署 | `PANEL_BASE_PATH=/weread/` | `/weread?x=1` 301 到 `/weread/?x=1`；`/weread/healthz` 200、`/healthz` 404；cookie `Path=/weread/` |
| 修改密码 | 两个会话中的一个修改密码 | 当前密码错误、新密码过短时拒绝；成功后两个旧会话都失效、新会话可用，旧密码不能登录；密码来自环境变量时返回 409 |
| 并发修改密码 | 两个会话同时用同一个当前密码修改为不同的新密码 | 只有一个返回 204，另一个返回 400 `wrong_password`；成功者的新会话保持有效，只有成功者的新密码能登录 |
| 收紧已有文件权限 | 启动前 `panel.json` 权限为 0644 | 启动后权限为 0600，日志提示已修改 |
| 全局设置与默认配置 | 修改时区、并发数与默认阅读时长；提交非法时区、并发数 0、阅读时长 0 或 400 位数字、选书方式 9、未知项、`dataDir` | 合法值生效；非法值返回 400，`message` 指出字段名称与原因；一项非法时整个请求不生效；`null` 恢复默认 |
| SELENIUM_URL 只写入一次 | 首次启动设置 `SELENIUM_URL`，在面板中改为其他地址后用新的 `SELENIUM_URL` 重启 | 全局默认中的 Selenium 地址保持面板中的设置 |
| 账号增删改查 | 新建、重复新建、非法 ID（`Bad_ID`、`-x`、`x-`、33 位、`../etc`）、修改名称与启用状态、修改 ID、删除 | 新建 201 并创建数据目录；重复 409；非法 ID 400；不能修改 ID；不存在的账号 404；不带请求体也能删除，默认保留数据目录，重新添加时沿用 cookies；`deleteData: true` 时删除目录；缺少 `X-WA-Request` 时 403 |
| 单实例 | 同一数据目录先后启动两个面板 | 第二个报错 `另一个面板实例…正在使用数据目录`；第一个关闭后删除 `panel.lock`，可以重新启动 |
| 遗留的锁文件 | `panel.lock` 指向本机已不存在的进程、其他主机且 60 秒未更新、内容损坏；另有其他主机且刚更新 | 前三种情况接管并正常启动；其他主机刚更新时报错，提示该主机名与进程号 |
| 配置合并 | 全局默认阅读时长 68、速度 normal；账号覆盖速度 fast、选书方式 -1 | 实际配置为 68、fast、-1，其余为内置默认；删除账号的速度覆盖后回到 normal；接口不返回数据目录等面板管理项；按账号解析时数据目录为 `accounts/<id>` |
| 密钥只写不读 | 设置 Bark key、ntfy token 与账号的邮箱密码 | 所有接口只返回掩码，响应中不出现密钥原文；提交掩码或空字符串不修改；`null` 清除 |
| 配置接口鉴权 | 未登录访问 `api/schema`、`api/settings`、`api/accounts` | 返回 401；schema 不包含数据目录、浏览器配置名、账号名称 |
| 旧文件升级 | 只有 `auth` 的 `panel.json` | 启动后补齐 `settings`、`defaults`、`accounts`，原密码可登录 |
| 安全响应头 | 访问页面与接口 | 带 CSP（不含 `unsafe-inline`）、`X-Frame-Options: DENY`、`Referrer-Policy: no-referrer`、`X-Content-Type-Options: nosniff`，不带 `X-Powered-By`；接口 `Cache-Control: no-store` |
| 运行成功 | 设置全局 Bark key；环境中有 `PANEL_SMOKE_SECRET`；账号 `ok-1` 立即运行 | 返回 202，`mode` 为 `read`、`trigger` 为 `manual`；状态依次为排队中、启动中、阅读中、成功；`minutes` 2、`book` 为书名、`screenshot` 为最新截图；子进程收到的数据目录为 `accounts/ok-1`、收到了 Bark key，环境变量中没有任何 `PANEL_*`；`meta.json` 状态为成功、退出码 0、不含登录链接；日志接口返回 `text/plain`，含 `[PANEL]` 行与子进程日志，不含密钥原文；`?download=1` 时为附件；运行 ID 格式非法或路径穿越时 404；未登录 401 |
| 排队与并发 | 并发数 1；依次运行 `slow-a`、`slow-b`、`slow-c`；再次运行 `slow-a`；运行停用的账号、不存在的账号；`mode` 非法或带未知字段；缺少 `X-WA-Request` | `slow-a` 启动中，`slow-b`、`slow-c` 排队中；重复运行 409 `run_active`；停用 409 `account_disabled`；不存在 404；参数非法 400；缺少请求头 403；`api/runs` 按顺序列出 3 个运行并带日志；停止排队中的 `slow-c` 立即记为已停止，日志有“已取消排队”；并发数改为 2 后 `slow-b` 立即启动；停止后 `api/runs` 为空 |
| 运行失败 | 并发数 3；`fail-1` 上报错误、`timeout-1` 等待扫码超时、`crash-1` 不上报结果以退出码 3 退出 | 都记为失败，`error` 分别为错误信息、`等待扫码超时`、`阅读子进程异常退出（退出码 3）`；`meta.json` 记录退出码 3 |
| 停止与强制结束 | 全局 Selenium 地址指向模拟服务；`slow-1`、`stubborn-1`（忽略 SIGTERM）阅读中时分别停止 | 停止返回 202 且 `stopRequested` 为 true；`slow-1` 收到 SIGTERM 后退出，记为已停止；`stubborn-1` 0.5 秒后被 SIGKILL，记为已停止，`exitSignal` 为 `SIGKILL`，日志有“强制结束”；模拟 Selenium 只收到 `DELETE /session/stub-session-stubborn-1`；再次停止返回 404 `run_not_active` |
| 仅登录 | `login-1` 以 `mode: "login"` 运行 | 等待扫码时 `loginUrl` 为登录链接；成功后 `loginUrl` 清空，`plannedMinutes` 为 0；`meta.json` 中没有登录链接 |
| 运行时长上限 | 上限缩短为 0.3 秒；`hang-1` 建立会话后无动作 | 记为失败，`error` 为 `运行超时，已强制结束` |
| 面板停止与重启 | 并发数 1，`slow-1` 阅读中、`slow-2` 排队中时关闭面板；再写入一条状态为阅读中的旧记录后重新启动 | 两个运行都记为中断（`面板停止时运行被中断`、`面板停止时仍在排队`）；重启后旧记录记为中断，保留原有的 `minutes`，`endedAt` 为最后写入时间，日志追加“标记为中断”；已结束的记录不变 |
| 实时推送 | 未登录访问 `api/events`；登录后连接，运行 `ok-1`；`slow-1` 阅读中时再连接一次；退出登录 | 未登录 401；响应头为 `text/event-stream`、`Cache-Control: no-cache`、`X-Accel-Buffering: no`；先收到 `snapshot`（`runs` 为空），之后收到 `run`（含成功状态）、`log`（含 `accountId` 与日志行）和心跳注释；中途连接时 `snapshot` 中的运行带最近日志；退出登录后两个连接都在 3 秒内断开 |
| 删除运行中的账号 | `slow-1` 运行中时删除；停止后带 `deleteData: true` 删除 | 运行中返回 409 `account_busy`；停止后删除成功，`runs/slow-1` 与 `accounts/slow-1` 都被删除 |
| 端口被占用 | 端口已被其他进程监听 | 报错 `端口 <端口> 已被占用，请通过 PANEL_PORT 更换端口` |
| 镜像 | 执行 `npm run test:runtime` | 容器健康检查通过；面板进程以 `node` 用户运行；`panel.json` 属于 `node` 且权限 600；`docker logs` 中有初始密码；`docker stop` 在 5 秒内完成 |
