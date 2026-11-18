# WeReadAssistant

> **非官方项目。** 本项目与腾讯公司及微信读书没有任何关联。“微信读书”“WeRead”是腾讯公司的商标，这里仅用于说明本项目的适用对象。

适用于微信读书的自动阅读助手：在云服务器、NAS、树莓派等设备上用 Docker 部署一个容器，通过 Web 管理面板管理多个账号、扫码登录、安排阅读计划，并查看运行记录、打卡情况与统计。镜像中自带浏览器，同时支持 amd64 与 arm64。

## 功能

**账号与登录**

- 多账号：每个账号单独登录、单独配置，没有单独设置的项沿用全局默认配置
- 在面板中扫码登录：二维码在浏览器本地生成，手机上可以复制登录链接发到微信中打开；登录状态过期时运行会提示需要扫码，并推送通知
- 内置浏览器按账号保留资料目录（缓存、本地存储与登录状态），跨运行保持登录；账号配置页显示占用，可以一键重置

**调度与可靠性**

- 调度规则：每天固定时间、每 N 小时或 cron 表达式，按面板时区；可随机延后 0–30 分钟开始、时长随机增加 0–30 分钟；也可以随时立即运行、仅登录或停止
- 失败自动重试：定时运行失败后按 5、15、30 分钟的间隔重试，只读剩余的分钟（默认最多 2 次）
- 每日目标：到检查时间当天读得不够时自动补跑差额
- 分段阅读（可选）：不想手写调度时，只设每天读多少分钟、在什么时段、每段多长，每天自动随机排几段
- 晚间断签预警：设了调度、每日目标或分段阅读的账号，到晚上（默认 21:30）今天还没打卡、也没有安排其他运行时推送提醒
- 重启恢复：面板重启或升级镜像后，恢复被中断的运行，补触发停机期间错过的调度
- 阅读出错时保存当时的页面截图，在历史中查看

**记录与统计**

- 实时页：阅读进度、最新截图与日志
- 运行历史（含重试、补跑与恢复）、打卡日历与月卡 / 年卡挑战进度
- 统计页：连续打卡天数与最长记录、本周 / 本月 / 今年累计、每日分钟趋势、最近一年热力图、运行成功率等。统计按本工具的运行记录计算，不是微信读书的官方数据

**笔记（需要微信读书 API Key）**

- 每天自动同步本人在微信读书中的划线与想法，按书保存为 JSON 与 Markdown（数据目录的 `accounts/<id>/notes/`），只重新读取有变化的书
- 账号的“笔记”页面：按书、按章节查看划线与想法，搜索全部笔记，下载一本或全部书的 Markdown

**通知**

- Bark、ntfy、Webhook（通用 JSON、企业微信、飞书、钉钉群机器人）、Telegram、邮件
- 可按事件开关（开始运行、需要扫码、登录成功、阅读完成、超时或出错）；每个渠道可以按账号单独关闭；“发送测试通知”显示每个渠道的结果

**面板**

- 密码登录，通过 HTTPS 访问时可以用 passkey（指纹、面容或设备 PIN）登录，也可以只用 passkey
- 面板重启或升级后已登录的设备保持登录（7 天无操作或登录满 30 天后需要重新登录），可以一键退出其他设备
- 配置备份：导出与导入面板设置、账号、调度与目标，可选包含用备份密码加密的通知密钥与登录状态
- 不收集、不上报任何使用数据，所有数据只保存在你自己的设备上

## 使用须知

自动阅读可能不符合微信读书的用户协议，可能导致阅读时长不被计入或账号受限，请自行评估风险。本项目仅供学习交流使用。

## 快速开始

### 准备

| 项目 | 要求 |
| --- | --- |
| 设备 | amd64（x86_64）或 arm64（aarch64）的 Linux，如云服务器、NAS、安装 64 位系统的树莓派 4 / 5。Docker 按机器架构自动拉取对应的镜像 |
| 内存 | 建议 2GB 以上；每个同时运行的账号（一个浏览器）约需 600MB |
| 磁盘 | 镜像约 1GB（大部分是浏览器），另外每个账号的浏览器资料最多约 300MB |
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

`docker-compose.yml` 只启动一个容器 `app`（镜像 `lonemoonspace/weread-assistant`），阅读用的 Chromium 与 chromedriver 已在镜像中。数据保存在当前目录的 `data/` 中。

### 打开面板

面板默认只监听本机 `127.0.0.1:26868`：

| 访问方式 | 做法 |
| --- | --- |
| 在设备本机打开 | 浏览器访问 `http://127.0.0.1:26868/` |
| 从局域网其他设备打开 | 把 `docker-compose.yml` 中的端口改为 `"26868:26868"` 后执行 `docker compose up -d`，访问 `http://<设备 IP>:26868/`。面板是 HTTP，只在可信的局域网中这样用 |
| 从外网打开 | 经自己的反向代理（Nginx、Caddy、Cloudflare Tunnel 等）提供 HTTPS，端口保持只映射到本机，并设置 `PANEL_TRUST_PROXY=true`，见 [docs/panel.md](docs/panel.md#反向代理) |

### 首次使用

1. 用初始密码登录面板，在“设置 → 登录方式”中修改为自己的密码
2. 点导航中的“新建账号”，填写账号 ID（如 `me`）与名称；进入账号页面后点“仅登录”，用微信扫描页面上的二维码
3. 在账号的“调度”中添加运行时间，例如每天 06:00；保存后立即生效，总览显示下次运行时间。需要时在同一页设置每日目标
4. 需要通知时，在“设置 → 全局默认配置”或账号的“配置”中填写通知渠道，点“发送测试通知”确认
5. 通过 HTTPS 从外网访问时，把 `docker-compose.yml` 中的 `PANEL_PUBLIC_URL` 设为面板的 HTTPS 地址，然后在“设置 → 登录方式”中添加 passkey，见 [docs/panel.md](docs/panel.md#passkey)

常用的面板设置（“设置 → 面板”）：时区、同时运行的账号数、失败重试次数、补触发宽限时间、日志与截图的保留。环境变量见 `docker-compose.yml` 中的注释与 [docs/panel.md](docs/panel.md)。

## 镜像版本

| 标签 | 说明 |
| --- | --- |
| `latest` | 最新的正式版本（默认） |
| `0.4.0` 等版本号 | 固定版本：在 `docker-compose.yml` 同目录的 `.env` 中写 `WEREAD_ASSISTANT_TAG=0.4.0` |
| `dev` | `main` 分支的最新构建，用于试用尚未发布的改动 |

每个标签都同时包含 `linux/amd64` 与 `linux/arm64`。每周会检查最近一个正式版本镜像中的系统包（如 Chromium 的安全更新）与 Node.js 补丁版本，有更新时用同一份源码重新构建，覆盖推送该版本号与 `latest`：固定了版本号也能拿到浏览器的安全更新。使用 WUD、Watchtower 等工具时它们会检测到变化并自动升级，被打断的阅读会在面板重启后恢复。

## 升级

```bash
# 重新下载 docker-compose.yml：新版本可能随之更新（改过该文件时先备份，再把改动合并回去）
curl -fsSLO https://raw.githubusercontent.com/lonemoonspace/Weread-Assistant/main/docker-compose.yml
docker compose pull
# --remove-orphans 删除新版 docker-compose.yml 中已经没有的容器（例如旧版的 selenium）
docker compose up -d --remove-orphans
```

数据在 `data/` 中，升级不受影响，已登录的设备也不需要重新登录。每个版本的变化与升级说明见 [CHANGELOG.md](CHANGELOG.md)。

从 0.3.x 升级到 0.4.0 时值得留意：

- 不想重新下载 `docker-compose.yml` 时，只执行 `docker compose pull && docker compose up -d` 也能正常运行；新的示例文件中增加了 `no-new-privileges` 与日志大小上限，建议照着加上
- Bark 改用 `POST /push` 发送：官方 bark-server 支持，自建的其他兼容服务需要支持这个接口
- 非 465 端口的 SMTP（如 587）现在要求 STARTTLS；服务器确实不支持加密时，在配置中开启“允许不加密的 SMTP 连接”
- 升级后建议在面板中发送一次测试通知，确认各渠道正常

<details>
<summary>从使用 Selenium 容器的旧版本（0.2.0 之前）升级</summary>

先重新下载 `docker-compose.yml` 再执行上面的命令：面板会把设置中的 `http://selenium:4444` 自动清空并改用内置浏览器。只执行 `docker compose pull`、保留旧的 `docker-compose.yml` 时，旧文件中的 `selenium` 容器与 `SELENIUM_URL` 都还在，面板继续使用 Selenium，也能正常运行。确认运行正常后可以执行 `docker image rm selenium/standalone-chromium:4.51.0-20261010` 删除旧的浏览器镜像，释放约 3GB 磁盘。

想继续使用自己部署的 Selenium 时，在 `docker-compose.yml` 中设置 `SELENIUM_URL`，或在面板设置中填写地址。清空只在升级后第一次不带 `SELENIUM_URL` 启动时执行一次，之后在面板中填写的地址不会再被清空。内置浏览器以无界面模式运行，没有可以用 noVNC 查看的画面，运行中的状况看实时页面中的截图与日志；需要 noVNC 时改用自己部署的 Selenium。

</details>

## 备份与迁移

只迁移配置时，在“设置 → 备份与迁移”中导出备份文件，到新的面板中导入（先预览，可合并或整体替换）。可以选择包含通知密钥与各账号的登录状态，这两部分用备份密码加密。定期备份可以用命令行（面板运行中也能执行，见 [docs/cli.md](docs/cli.md)）：

```bash
docker compose exec app node src/cli.js export --out data/backup.json
```

完整备份时备份整个 `data/` 目录（停止后复制最稳妥：`docker compose stop`）。其中：

| 路径 | 内容 | 备份时 |
| --- | --- | --- |
| `panel.json` | 面板设置、账号、调度与通知渠道的密钥 | 必须，妥善保管 |
| `accounts/<账号 ID>/cookies.json` | 微信读书的登录状态 | 需要，等同于账号登录，不要分享 |
| `accounts/<账号 ID>/profile/` | 内置浏览器的资料目录（缓存与登录状态） | 可以排除，缺失时从 `cookies.json` 恢复登录 |
| `runs/` | 运行记录、日志与截图 | 需要保留历史与统计时备份 |
| `planner.json` | 待执行的重试与补跑 | 可选 |
| `sessions.json` | 面板的登录会话（只有令牌哈希） | 建议排除：还原备份会让备份那一刻仍有效的会话重新生效 |

## 常见问题

| 问题 | 处理 |
| --- | --- |
| 运行失败 | 在账号的“历史”中展开日志与出错时的截图查看原因；定时运行失败后会自动重试，最后一次失败才发通知。面板自身的日志为 `data/panel.log` 与 `docker compose logs app` |
| 提示需要扫码 | 登录状态过期了，在账号页面点“仅登录”重新扫码即可 |
| 升级后收不到 Bark 推送 | 0.4.0 起 Bark 改用 `POST /push`；自建的兼容服务需要支持这个接口，先在面板中发送测试通知查看原因 |
| 浏览器资料占用太大或浏览器启动异常 | 资料目录超过 300MB 时自动清空缓存，启动失败时自动重置；也可以在账号“配置”的“浏览器资料”中手动重置（下次运行从 `cookies.json` 恢复登录）。不需要时可以在运行配置中关闭“保留浏览器资料” |
| 同时运行多个账号 | 调大“设置 → 面板”中的“同时运行的账号数”。每个账号单独启动一个浏览器，各约占 600MB 内存，按设备内存设置；使用自己部署的 Selenium 时与它的 `SE_NODE_MAX_SESSIONS` 保持一致 |
| 总览显示“无法连接 Selenium” | 设置中的 Selenium 地址指向的服务连不上。使用内置浏览器时把“全局默认配置”中的 Selenium 地址清空（账号“配置”中填写过的也清空）；使用自己部署的 Selenium 时确认它在运行、地址正确 |
| 登录页没有“使用 passkey 登录” | passkey 需要 `PANEL_PUBLIC_URL` 为 HTTPS 地址，并且从这个地址打开面板；用内网 IP 打开时只能用密码登录。更换域名后原来的 passkey 不能再用，用密码登录后重新添加 |
| 关闭了密码登录，passkey 却用不了 | 在 `docker-compose.yml` 的 `app` 中加上 `PANEL_FORCE_PASSWORD_LOGIN=true` 后执行 `docker compose up -d`，临时用密码登录；添加新的 passkey 后删掉这个变量，再执行一次 `docker compose up -d`。同时忘了密码时再加上 `PANEL_PASSWORD=新密码`，见 [docs/panel.md](docs/panel.md#关闭密码登录) |
| 忘记面板密码 | 在 `docker-compose.yml` 的 `app` 中设置环境变量 `PANEL_PASSWORD=新密码`（至少 8 位）后执行 `docker compose up -d`。设置该变量时面板以它为准（界面中不能再修改密码），需要一直保留；去掉后恢复为原来保存的密码 |
| 端口 26868 被占用 | 修改 `docker-compose.yml` 中端口映射左侧的端口，例如 `"127.0.0.1:30000:26868"` |

## 卸载

```bash
docker compose down
# 同时删除所有数据（账号、登录状态、运行记录）时：
sudo rm -rf data
```

## 文档

| 文档 | 内容 |
| --- | --- |
| [docs/panel.md](docs/panel.md) | 面板：环境变量、页面、接口、调度、重试与恢复、统计、备份、数据保留、反向代理与安全 |
| [docs/reader.md](docs/reader.md) | 自动阅读流程 |
| [docs/notifications.md](docs/notifications.md) | 通知渠道 |
| [docs/cli.md](docs/cli.md) | 命令行：启动面板、导出配置、按账号运行一次（调试用） |
| [docs/design.md](docs/design.md) | 整体设计 |
| [docs/docker-image-publish.md](docs/docker-image-publish.md) | 镜像构建与发布 |
| [README-dev.md](README-dev.md) | 本地开发与测试 |
| [CHANGELOG.md](CHANGELOG.md) | 更新日志 |

## 致谢

本项目基于 [jqknono/weread-challenge-selenium](https://github.com/jqknono/weread-challenge-selenium)（MIT License）开发，感谢原作者的工作。

## 许可证

[MIT](LICENSE)，保留了原项目的版权声明。
