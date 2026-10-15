## Web 面板验收用例

`scripts/panel-smoke.js` 在本机启动面板，用 HTTP 请求验证以下场景，不需要浏览器与 Selenium。执行方式：`npm run test:panel`。

| 场景 | 前置条件 / 输入 | 预期结果 |
| --- | --- | --- |
| smoke 自查 | 执行 `npm run test:panel` | 13 个场景全部通过并退出码 0 |
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
| 安全响应头 | 访问页面与接口 | 带 CSP（不含 `unsafe-inline`）、`X-Frame-Options: DENY`、`Referrer-Policy: no-referrer`、`X-Content-Type-Options: nosniff`，不带 `X-Powered-By`；接口 `Cache-Control: no-store` |
| 端口被占用 | 端口已被其他进程监听 | 报错 `端口 <端口> 已被占用，请通过 PANEL_PORT 更换端口` |
| 镜像 | 执行 `npm run test:runtime` | 容器健康检查通过；面板进程以 `node` 用户运行；`panel.json` 属于 `node` 且权限 600；`docker logs` 中有初始密码；`docker stop` 在 5 秒内完成 |
