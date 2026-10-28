## 真机部署验收用例

在树莓派（64 位系统）上按 README“部署”一节操作，需要真实微信账号扫码。发布 `0.1.0` 之前用 `dev` 镜像验收（`.env` 中写 `WEREAD_ASSISTANT_TAG=dev`），通过后再合并改版本号的 Pull Request 发布。

| 场景 | 操作 | 预期结果 |
| --- | --- | --- |
| 启动 | 下载 `docker-compose.yml`，`docker compose up -d` | 只有 `app` 一个容器，健康检查为 `healthy`；`docker compose logs app` 中有面板初始密码；`docker image inspect` 显示架构为 arm64 |
| 登录与改密码 | 用初始密码登录，在设置中修改面板密码 | 修改后其他已登录的页面回到登录页；新密码可以登录 |
| 反向代理 | 按 `docs/panel.md`“反向代理”配置 HTTPS（可放在子路径，如 `/weread/`），设置 `PANEL_BASE_PATH`、`PANEL_TRUST_PROXY` | 经代理访问正常；实时推送不断开（日志实时更新）；浏览器开发者工具中会话 cookie 带 `Secure`、`HttpOnly`、`SameSite=Strict` |
| 浏览器状态 | 打开总览 | 顶部显示“内置浏览器”就绪与 Chromium 版本 |
| 新建账号与扫码 | 新建账号，点“仅登录”，用微信扫码 | 页面显示二维码；手机上可复制登录链接在微信中打开；扫码后状态变为成功，`data/accounts/<id>/cookies.json` 存在 |
| 阅读 | 点“立即运行”（可在账号配置中把阅读时长临时改为 5 分钟） | 状态依次为启动中、阅读中，显示书名、进度与每分钟的截图；结束后为成功；今天的分钟数增加，达到 5 分钟后显示已打卡；开启通知时收到“阅读完成” |
| 停止 | 阅读中点“停止” | 几秒内状态变为已停止；`docker compose exec app ps` 中没有残留的 chromium 与 chromedriver 进程 |
| 阅读时长计入 | 用一个账号按平时的计划运行 3–5 天 | 微信读书 App 中的阅读时长与面板记录的分钟数一致（内置浏览器以无界面模式运行，验证时长正常计入） |
| 调度 | 添加几分钟后的每天固定时间规则 | 总览显示下次运行时间；到点后自动开始运行，历史中触发方式为定时 |
| 通知 | 配置 Bark / ntfy / 邮件中的至少一种，发送测试通知 | 收到测试通知；结果显示对应渠道成功 |
| 改用 Selenium（可选） | 另行部署 `selenium/standalone-chromium`（开启 7900 端口并修改 VNC 密码），在设置中填写 Selenium 地址与 noVNC 地址；之后停止 Selenium，刷新总览，再点“立即运行” | 总览显示 Selenium 就绪、已用 0/1 个会话，设置页显示 noVNC 安全提示，运行中的实时页面出现“查看浏览器画面”链接；停止后总览红色提示无法连接 Selenium 与处理办法，运行失败，错误为“无法连接 Selenium（<地址>）：…”；清空地址后恢复使用内置浏览器 |
| 重启 | 阅读中执行 `docker compose restart app`；另外重启设备 | 面板重启后该运行记为中断；设备重启后容器自动启动，登录状态、调度与历史都在 |
| 升级 | `docker compose pull && docker compose up -d --remove-orphans` | 数据保留，页面底部显示新版本号 |
| 从 Selenium 版本升级 | 在使用 0.1.x 与 `selenium` 容器的设备上重新下载 `docker-compose.yml`，执行上一行的命令 | `selenium` 容器被删除；`docker compose logs app` 中有“已把配置中的 Selenium 地址 http://selenium:4444 清空，改用内置浏览器”；设置中的 Selenium 地址为空；原有账号不需要重新扫码即可运行 |
| 资源占用 | 阅读中执行 `docker stats --no-stream` | 记录内存占用，确认设备内存充足 |
