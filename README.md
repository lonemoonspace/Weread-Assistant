# WeReadAssistant

> **非官方项目。** 本项目与腾讯公司及微信读书没有任何关联。“微信读书”“WeRead”是腾讯公司的商标，这里仅用于说明本项目的适用对象。

适用于微信读书的自动阅读助手：在树莓派等 arm64 设备上用 Docker 部署，通过 Web 管理面板管理多个账号、扫码登录、安排阅读计划，并查看运行记录和打卡情况。

## 功能

- **多账号**：每个账号单独登录、单独配置，也可以共用全局默认配置
- **在面板中扫码登录**：二维码在浏览器本地生成，手机上可以复制登录链接发到微信中打开
- **调度**：每天固定时间、每 N 小时或 cron 表达式，按面板时区；可随时立即运行、仅登录或停止
- **实时查看**：阅读进度、最新截图与日志；可选的 noVNC 链接，直接查看浏览器画面
- **记录与打卡**：运行历史、每天的阅读分钟数、打卡日历与月卡 / 年卡进度（按本工具的运行记录计算，不是微信读书官方数据）
- **通知**：Bark、ntfy、邮件，可按事件开关（需要扫码、阅读完成、运行失败等）
- **Selenium 状态**：总览页显示浏览器服务是否就绪与会话数，停止时有明确提示
- 不收集、不上报任何使用数据；所有数据只保存在你自己的设备上

## 使用须知

自动阅读可能不符合微信读书的用户协议，可能导致阅读时长不被计入或账号受限，请自行评估风险。本项目仅供学习交流使用。

## 部署

### 准备

| 项目 | 要求 |
| --- | --- |
| 设备 | arm64（aarch64）Linux，如安装 64 位系统的树莓派 4 / 5；镜像只发布 `linux/arm64` |
| 内存 | 建议 2GB 以上；同时运行多个账号时需要更多 |
| 磁盘 | 约 4GB（主要是 Selenium 镜像） |
| 软件 | Docker 与 Docker Compose 插件（`docker compose version` 能输出版本） |

### 启动

```bash
mkdir weread-assistant && cd weread-assistant
# 下载仓库中的 docker-compose.yml
curl -fsSLO https://raw.githubusercontent.com/lonemoonspace/Weread-Assistant/main/docker-compose.yml
docker compose up -d

# 首次启动时生成的面板密码，只打印这一次
docker compose logs app | grep 面板初始密码
```

`docker-compose.yml` 启动两个容器：面板 `app`（`lonemoonspace/weread-assistant`）与浏览器服务 `selenium`（`selenium/standalone-chromium`）。面板数据保存在当前目录的 `data/` 中。

面板默认只监听本机 `127.0.0.1:26868`：

| 访问方式 | 做法 |
| --- | --- |
| 在设备本机打开 | 浏览器访问 `http://127.0.0.1:26868/` |
| 从局域网其他设备打开 | 把 `docker-compose.yml` 中的端口改为 `"26868:26868"`，再执行 `docker compose up -d`，访问 `http://<设备 IP>:26868/`。面板是 HTTP，只在可信的局域网中这样用 |
| 从外网打开 | 经自己的反向代理（Nginx、Caddy 等）提供 HTTPS，端口保持只映射到本机，见 [docs/panel.md](docs/panel.md#反向代理) |

想固定版本时，在 `docker-compose.yml` 同目录的 `.env` 中写入 `WEREAD_ASSISTANT_TAG=0.1.0`（默认 `latest`；`dev` 为 main 分支的最新构建）。

### 开始使用

1. 用初始密码登录面板，在“设置 → 面板密码”中修改为自己的密码
2. “新建账号”，填写账号 ID（如 `me`）与名称；进入账号页面后点“仅登录”，用微信扫描页面上的二维码
3. 在账号的“调度”中添加运行时间，例如每天 06:00；保存后立即生效，总览显示下次运行时间
4. 需要通知时，在“设置 → 全局默认配置”或账号的“配置”中填写 Bark、ntfy 或邮件，点“发送测试通知”确认
5. 想看到浏览器画面时，参考 `docker-compose.yml` 中 noVNC 的注释开启，并在设置中填写 noVNC 地址（画面就是已登录的浏览器，务必修改默认 VNC 密码，不要暴露到公网）

登录状态保存在 cookies 中，过期后运行会提示需要扫码（开启通知时会推送），在面板中重新扫码即可。

### 升级

```bash
# 重新下载 docker-compose.yml：其中固定了经过测试的 Selenium 版本，新版本可能随之更新（改过该文件时先备份，再把改动合并回去）
curl -fsSLO https://raw.githubusercontent.com/lonemoonspace/Weread-Assistant/main/docker-compose.yml
docker compose pull
docker compose up -d
```

数据在 `data/` 中，升级不受影响。版本说明见 [CHANGELOG.md](CHANGELOG.md)。

### 备份与迁移

备份整个 `data/` 目录即可（停止后复制最稳妥：`docker compose stop`）。其中 `accounts/<账号 ID>/cookies.json` 等同于微信读书的登录状态，`panel.json` 含通知渠道的密钥，请妥善保管，不要分享。

### 常见问题

| 问题 | 处理 |
| --- | --- |
| 忘记面板密码 | 在 `docker-compose.yml` 的 `app` 中设置环境变量 `PANEL_PASSWORD=新密码`（至少 8 位） 后执行 `docker compose up -d`。设置该变量时面板以它为准（界面中不能再修改密码），需要一直保留；去掉后恢复为原来保存的密码 |
| 总览显示“无法连接 Selenium” | 执行 `docker compose ps` 确认 `selenium` 在运行，停止时执行 `docker compose up -d selenium`；仍有问题时查看 `docker compose logs selenium` |
| 总览提示“同时运行的账号数”超过会话数 | 把设置中的“同时运行的账号数”调低，或调大 `docker-compose.yml` 中 Selenium 的 `SE_NODE_MAX_SESSIONS`（两者保持一致） |
| 端口 26868 被占用 | 修改 `docker-compose.yml` 中端口映射左侧的端口，例如 `"127.0.0.1:30000:26868"` |
| 运行失败 | 在账号的“历史”中展开日志与截图查看原因；面板自身的日志为 `data/panel.log` 与 `docker compose logs app` |

### 卸载

```bash
docker compose down
# 同时删除所有数据（账号、登录状态、运行记录）时：
sudo rm -rf data
```

## 文档

| 文档 | 内容 |
| --- | --- |
| [docs/panel.md](docs/panel.md) | 面板：环境变量、页面、接口、调度、数据保留、反向代理与安全 |
| [docs/reader.md](docs/reader.md) | 自动阅读流程 |
| [docs/notifications.md](docs/notifications.md) | 通知渠道 |
| [docs/cli.md](docs/cli.md) | 命令行：启动面板、按账号运行一次（调试用） |
| [docs/design.md](docs/design.md) | 整体设计 |
| [docs/docker-image-publish.md](docs/docker-image-publish.md) | 镜像构建与发布 |
| [README-dev.md](README-dev.md) | 本地开发与测试 |

## 致谢

本项目基于 [jqknono/weread-challenge-selenium](https://github.com/jqknono/weread-challenge-selenium)（MIT License）开发，感谢原作者的工作。

## 许可证

[MIT](LICENSE)，保留了原项目的版权声明。
