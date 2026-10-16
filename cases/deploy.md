## 真机部署验收用例

在树莓派（64 位系统）上按 README“部署”一节操作，需要真实微信账号扫码。发布 `0.1.0` 之前用 `dev` 镜像验收（`.env` 中写 `WEREAD_ASSISTANT_TAG=dev`），通过后再推送 `v0.1.0` tag。

| 场景 | 操作 | 预期结果 |
| --- | --- | --- |
| 启动 | 下载 `docker-compose.yml`，`docker compose up -d` | 两个容器都在运行，`app` 健康检查为 `healthy`；`docker compose logs app` 中有面板初始密码；`docker image inspect` 显示架构为 arm64 |
| 登录与改密码 | 用初始密码登录，在设置中修改面板密码 | 修改后其他已登录的页面回到登录页；新密码可以登录 |
| 反向代理 | 按 `docs/panel.md`“反向代理”配置 HTTPS（可放在子路径，如 `/weread/`），设置 `PANEL_BASE_PATH`、`PANEL_TRUST_PROXY` | 经代理访问正常；实时推送不断开（日志实时更新）；浏览器开发者工具中会话 cookie 带 `Secure`、`HttpOnly`、`SameSite=Strict` |
| Selenium 状态 | 打开总览 | 顶部显示 Selenium 就绪、已用 0/1 个会话 |
| 新建账号与扫码 | 新建账号，点“仅登录”，用微信扫码 | 页面显示二维码；手机上可复制登录链接在微信中打开；扫码后状态变为成功，`data/accounts/<id>/cookies.json` 存在 |
| 阅读 | 点“立即运行”（可在账号配置中把阅读时长临时改为 5 分钟） | 状态依次为启动中、阅读中，显示书名、进度与每分钟的截图；结束后为成功；今天的分钟数增加，达到 5 分钟后显示已打卡；开启通知时收到“阅读完成” |
| 停止 | 阅读中点“停止” | 几秒内状态变为已停止；总览中 Selenium 的已用会话数回到 0 |
| 调度 | 添加几分钟后的每天固定时间规则 | 总览显示下次运行时间；到点后自动开始运行，历史中触发方式为定时 |
| 通知 | 配置 Bark / ntfy / 邮件中的至少一种，发送测试通知 | 收到测试通知；结果显示对应渠道成功 |
| Selenium 停止 | `docker compose stop selenium`，刷新总览，再点“立即运行” | 总览红色提示无法连接 Selenium 与处理办法；运行失败，错误为“无法连接 Selenium（http://selenium:4444）：…”；`docker compose up -d selenium` 后恢复就绪 |
| noVNC（可选） | 按 `docker-compose.yml` 注释开启 7900 端口并修改 VNC 密码，在设置中填写 noVNC 地址 | 设置页显示安全提示；总览与运行中的实时页面出现“查看浏览器画面”链接，打开后输入 VNC 密码可看到浏览器 |
| 重启 | 阅读中执行 `docker compose restart app`；另外重启设备 | 面板重启后该运行记为中断；设备重启后两个容器自动启动，登录状态、调度与历史都在 |
| 升级 | `docker compose pull && docker compose up -d` | 数据保留，页面底部显示新版本号 |
| 资源占用 | 阅读中执行 `docker stats --no-stream` | 记录内存占用，确认设备内存充足 |
