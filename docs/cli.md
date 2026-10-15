## CLI 说明

> `run --account <id>` 按面板中保存的账号配置运行，停用的账号会被拒绝。按环境变量运行的 `run` 保留到第 6 步（面板能调度阅读之后删除），目前由 `docker-compose.yml` 中的 `reader` 服务使用：`docker compose run --rm reader`。面板的配置与接口见 `docs/panel.md`。

### 职责

| 命令 | 职责 | 输入 | 输出 | 关键约束 |
| --- | --- | --- | --- | --- |
| `run --account <id>` | 按面板中的账号配置执行一次自动阅读 | `PANEL_DATA_DIR` 下的 `panel.json` | 控制台日志、`accounts/<id>/` 下的 `output.log`、cookies、登录二维码、截图、通知 | 账号覆盖 > 全局默认 > 内置默认；不读取运行相关的环境变量 |
| `run` | 按环境变量执行一次自动阅读（临时保留） | 环境变量 | 控制台日志、`<数据目录>/output.log`、cookies、登录二维码、截图、通知 | 只连接 `SELENIUM_URL` 指向的远程 Chromium |
| `--login-only` | 与上面两种 `run` 搭配，只登录（需要时扫码）并保存 cookies | 同上 | 同上，不选书、不阅读 | 用于刷新登录态 |
| `panel` / 无参数 | 启动 Web 面板 | `PANEL_*` 环境变量 | HTTP 服务、`<面板数据目录>/panel.log` | 镜像默认命令；不接受额外参数；端口被占用时报错退出 |
| `help` / `-h` / `--help` | 输出帮助与环境变量清单 | 无 | 帮助文本 | 不启动浏览器 |

### 配置

环境变量与配置项一一对应，清单以 `src/config/schema.js` 为准，`help` 输出同一份清单。未设置或为空的变量使用默认值。

取值会按清单校验，非法时直接报错并以退出码 1 结束：整数必须是完整的十进制数（`10abc` 不接受）且在安全整数范围内；`WEREAD_DURATION`、`WEREAD_LOGIN_TIMEOUT` 在 1–1440 分钟之间；`EMAIL_PORT`、`PANEL_PORT` 在 1–65535 之间；`WEREAD_SELECTION` 只能是 -1 到 4；`WEREAD_SPEED` 只能是 `slow`、`normal`、`fast`；布尔值只接受 `true/false`、`1/0`、`yes/no`、`y/n`、`on/off`。

相对上游的变化：

| 上游变量 | 现状 |
| --- | --- |
| `WEREAD_REMOTE_BROWSER` | 改名为 `SELENIUM_URL`，默认 `http://selenium:4444` |
| `WEREAD_BROWSER` | 删除，只支持 Chromium |
| `WEREAD_AGREE_TERMS` | 删除，不再上报使用统计 |
| `WEREAD_DATA_DIR` | 默认 `data`（相对当前目录，镜像内为 `/app/data`），不再自动沿用 `.weread` 或旧版 `data` 目录 |
| `run` 的 `--weread-*` 参数 | 删除，只读环境变量 |
| `WEREAD_SPEED` | 含义改为两次翻动之间的间隔，见 `docs/reader.md` |
| 新增 `WEREAD_LOGIN_TIMEOUT` | 等待扫码的总时长（分钟），默认 15 |
| 新增 `WEREAD_ACCOUNT_NAME` | 显示在通知标题中的账号名称 |
| 新增 `NOTIFY_ON_*` | 各通知事件的开关，见 `docs/notifications.md` |

### 流程

```mermaid
flowchart TD
  A[src/cli.js] --> B{命令}
  B -->|help| C[输出帮助]
  B -->|panel / 无参数| P[启动面板，见 docs/panel.md]
  B -->|run --account| A2[读取 panel.json，合并账号配置]
  A2 --> E
  B -->|run| D[configFromEnv 生成不可变配置]
  D --> E[创建数据目录与 output.log]
  E --> F[runOnce，流程见 docs/reader.md]
  F --> K{结果}
  K -->|success| M[退出码 0]
  K -->|login-timeout / error| N[退出码 1]
  B -->|其他| L[报错，退出码 1]
```

### 关键约束

| 约束 | 说明 |
| --- | --- |
| 只用远程浏览器 | 不在本机启动浏览器；本地开发同样需要一个 Selenium 服务或 chromedriver |
| 退出码 | `run` 成功时为 0；等待扫码超时、运行出错、命令或参数错误、账号不存在或已停用、面板数据不存在时为 1 |
| 日志完整 | 退出前等待日志文件写入完成，`output.log` 包含最后的 `Run finished` 行 |
| 配置不可变 | 每次运行生成一份冻结的配置对象，各模块通过参数接收，不再读写模块级变量 |
| 配置校验 | 拼写错误或超出范围的取值不会被悄悄改成默认值或截断，而是报错退出，见 `cases/config.md` |
| 不上报 | 不向任何服务器发送使用数据 |
