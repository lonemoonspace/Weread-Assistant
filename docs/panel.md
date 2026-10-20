## Web 面板说明

> 已完成：登录、会话、修改密码、反向代理支持，全局设置、默认配置与账号管理接口，运行队列（立即运行、仅登录、停止、运行日志、实时推送），按账号的调度规则与定时运行，运行历史、按天统计、打卡日历与挑战进度、按保留策略清理，Selenium 状态与 noVNC 链接，以及完整的页面。

### 启动

```bash
docker compose up -d                 # 启动面板（app）与 Selenium，面板映射到 127.0.0.1:26868
node src/cli.js                      # 本地开发：不带参数即启动面板
PANEL_PORT=30000 node src/cli.js panel
```

镜像默认命令就是启动面板。首次启动且未设置 `PANEL_PASSWORD` 时，面板随机生成一个 16 位密码，只在标准输出（`docker logs`）中打印一次，不写入 `panel.log`：

```bash
docker compose logs app | grep 面板初始密码
```

阅读配置、通知与调度都在面板中设置，不再支持按环境变量运行阅读。

### 配置

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PANEL_PORT` | `26868` | 监听端口，1–65535；选用不常见端口，避开常被占用的 8080 等端口。只能通过环境变量设置，与镜像健康检查读取同一个值 |
| `PANEL_HOST` | `0.0.0.0` | 监听地址 |
| `PANEL_PASSWORD` | 空 | 面板密码，至少 8 位（不足时拒绝启动）；设置后以它为准，界面中不能修改 |
| `PANEL_BASE_PATH` | `/` | 部署在反向代理子路径下时设置，例如 `/weread/` |
| `PANEL_TRUST_PROXY` | `false` | `true` 表示信任 1 层代理，也可填信任的代理层数 |
| `PANEL_PUBLIC_URL` | 空 | 面板的外网地址（不含用户名与密码的 http(s) 地址，例如 `https://example.com/weread/`）：扫码推送附带该账号实时页面的链接；二维码解析不出登录链接时改为推送面板链接，在面板中扫二维码截图。地址无效时拒绝启动；设置了 `PANEL_BASE_PATH` 而外网地址的路径不以它结尾时，启动日志给出提示（反向代理去掉前缀、`PANEL_BASE_PATH` 为 `/` 时外网地址带路径是正常的）；`run --account` 不读取它 |
| `PANEL_DATA_DIR` | `data` | 面板数据目录，保存 `panel.json`、`panel.log` 与各账号的数据 |
| `SELENIUM_URL` | 空 | 首次初始化全局默认配置时写入 Selenium 地址；之后以面板中的设置为准 |

### 职责

| 组件 | 职责 | 关键约束 |
| --- | --- | --- |
| `src/panel/options.js` | 读取 `PANEL_*` 环境变量 | 规范化子路径、代理层数与端口；取值非法时报错退出 |
| `src/panel/settings.js` | 面板设置（时区、并发数、保留策略、noVNC 地址）的清单与校验 | 值为 null 时恢复默认 |
| `src/panel/config.js` | 运行配置的表单清单、全局默认与账号覆盖的修改、合并与密钥掩码 | 面板管理的配置项不出现在接口中 |
| `src/panel/accounts.js` | 账号增删改查 | 账号 ID 创建后不可修改；删除时默认保留数据目录；运行或排队中的账号不能删除 |
| `src/panel/runner.js` | 运行队列：fork 阅读子进程、下发配置、处理事件、停止、保存日志 | 同一账号同时只有一个运行；并发数取面板设置，修改后立即生效 |
| `src/panel/schedules.js` | 调度规则的校验、换算为 cron 表达式、计算接下来的触发时间 | 时间按面板时区解释 |
| `src/panel/scheduler.js` | 按调度规则定时把运行加入队列（croner） | `panel.json` 每次修改后重建定时任务；错过的时间不补跑 |
| `src/panel/runs.js` | 运行目录与运行记录（`meta.json`）的读写，启动时标记中断 | 运行 ID 与账号 ID 校验格式后才拼接路径 |
| `src/panel/history.js` | 运行历史、按天统计、打卡日历与挑战进度、按保留策略清理 | 按面板时区统计；口径为本工具的运行记录，非微信读书官方数据 |
| `src/panel/challenge.js` | 阅读挑战（月卡、年卡）的规则与设置校验 | |
| `src/shared/selenium.js` | 查询 Selenium 的 `/status`：是否就绪、已用/总会话数；面板总览与阅读子进程的运行日志共用 | 先 `/status`，不是 Selenium 状态时再试 `/wd/hub/status`；3 秒超时；展示的地址去掉其中的用户名与密码 |
| `src/reader/worker.js` | 阅读子进程入口：经 IPC 接收配置、上报事件，收到 SIGTERM 时关闭浏览器后退出 | 只由面板启动，见 `docs/reader.md` |
| `src/panel/store.js` | `panel.json` 读写 | 串行写入、先写临时文件并刷到磁盘再重命名、权限 0600；每次修改前把上一版保存为 `panel.json.bak`；启动时把已有文件的权限收紧为 0600，改不了时拒绝启动；文件损坏时另存为 `panel.json.corrupt-<时间>`（只保留最近 3 份）并从上一版恢复，`panel.json` 不见了而上一版还在时同样从上一版恢复，上一版也不可用时拒绝启动（重置面板需同时删除 `panel.json` 与 `panel.json.bak`）；补齐缺少的部分（旧文件自动升级） |
| `src/panel/auth.js` | 密码哈希、会话、登录限速、修改密码 | 密码以 scrypt 哈希保存；会话只在内存中保存令牌哈希，面板重启后需重新登录 |
| `src/panel/server.js` | Express 应用、页面与接口 | 统一安全响应头；修改类请求校验自定义请求头 |
| `src/panel/healthcheck.js` | 镜像 `HEALTHCHECK` 使用 | 请求 `<子路径>healthz` |
| `src/panel/public/` | 登录页与面板页面（`index.html` + `assets/app/`），见下文“页面” | 不使用内联脚本与样式；第三方文件在 `assets/vendor/`，版本与校验值见其中的 README |

### 接口

| 方法与路径（相对子路径） | 鉴权 | 说明 |
| --- | --- | --- |
| `GET healthz` | 否 | 返回 `{"status":"ok"}` |
| `GET /` | 是 | 未登录时 302 到 `login` |
| `GET login` | 否 | 登录页；已登录时 302 到 `./` |
| `POST api/auth/login` | 否 | `{ password }`；成功 204 并下发会话 cookie，密码错误 401，被限速 429（带 `Retry-After`） |
| `GET api/auth/session` | 是 | 返回版本号、密码是否来自环境变量、最短密码长度 |
| `POST api/auth/logout` | 是 | 注销当前会话 |
| `POST api/auth/password` | 是 | `{ current, next }`；成功后所有会话失效，并为当前请求下发新会话；密码来自环境变量时返回 409。多个请求依次处理，后到的请求按新密码校验 |
| `GET api/schema` | 是 | 表单清单：配置分组、运行配置字段（类型、可选值、范围、是否密钥）、面板设置字段 |
| `GET api/settings` | 是 | `{ settings, defaults }`：面板设置与全局默认运行配置（密钥为掩码） |
| `PATCH api/settings` | 是 | `{ settings?, defaults? }`：只修改提交的项；任一项非法时返回 400 且整个请求不生效 |
| `GET api/accounts` | 是 | 账号列表，含是否已有 cookies、调度规则（带接下来的触发时间）、下一次定时运行时间 `nextRunAt`、挑战设置 `challenge`、今天的阅读分钟数 `today`（`{ date, minutes, checkedIn }`）与最近一次运行 `lastRun` |
| `POST api/accounts` | 是 | `{ id, name? }`；成功 201，ID 已存在 409，ID 或名称非法 400；同时创建账号数据目录 |
| `GET api/accounts/:id` | 是 | `{ account, challengeProgress, effective }`：账号、本轮挑战进度（未设置挑战时为 null）与实际生效的运行配置 |
| `PATCH api/accounts/:id` | 是 | `{ name?, enabled?, overrides?, challenge? }`；ID 不可修改；`challenge` 为 `{ type: "month" \| "year", startDate: "YYYY-MM-DD" }` 或 null |
| `GET api/accounts/:id/schedules` | 是 | `{ timezone, enabled, nextRunAt, schedules }`：每条规则带 `description` 与接下来 5 次触发时间 `nextRuns` |
| `PUT api/accounts/:id/schedules` | 是 | `{ schedules: [...] }`：整体替换账号的调度规则，保存后立即生效；任一条非法时返回 400，`message` 指出第几条规则与原因，整个请求不生效 |
| `POST api/schedules/preview` | 是 | `{ schedules: [...] }`：校验并返回每条规则接下来的触发时间，不保存，供填写表单时预览 |
| `DELETE api/accounts/:id` | 是 | `{ deleteData? }`，可以不带请求体；默认只从面板移除，`deleteData: true` 时同时删除账号数据目录与运行记录；账号正在运行或排队时返回 409 `account_busy` |
| `POST api/accounts/:id/runs` | 是 | `{ mode? }`，`read`（默认）或 `login`（仅登录），可以不带请求体；加入队列后返回 202 与运行状态；账号不存在 404，已停用 409 `account_disabled`，已在运行或排队 409 `run_active` |
| `POST api/accounts/:id/stop` | 是 | 停止账号当前的运行：排队中的直接取消，进行中的结束子进程；返回 202 与运行状态；没有运行时 404 `run_not_active` |
| `POST api/notifications/test` | 是 | `{ accountId? }`：按账号的实际配置（不提供时按全局默认配置）向已配置的 Bark、ntfy、邮件各发送一条测试通知，不受事件开关影响；返回 `{ results: [{ channel, ok }] }`，没有配置任何渠道时为空数组 |
| `GET api/runs` | 是 | 排队中与进行中的运行，按加入队列的顺序，每个运行带最近 200 行日志 |
| `GET api/selenium/status` | 是 | 全局默认配置与各账号实际使用的每个 Selenium 地址的状态与会话数，见下文“Selenium 状态与 noVNC” |
| `GET api/accounts/:id/runs` | 是 | 运行历史，最新的在前：`{ runs, nextBefore }`；`?limit=`（1–100，默认 20）、`?before=<nextBefore>` 翻页。每条为运行记录加 `hasLog` 与截图文件名 `screenshots` |
| `GET api/accounts/:id/runs/:runId` | 是 | `{ run }`：运行记录、截图文件名与按天拆分的阅读分钟数 `minutesByDate` |
| `GET api/accounts/:id/runs/:runId/screenshots/:name` | 是 | 截图（`image/png`），运行中也可读取最新的截图；文件名只接受 `screenshot-<分钟>.png`（0.1.0 的旧记录中还可能有发邮件时留下的 `screenshot.png`，同样可读取） |
| `GET api/accounts/:id/login-qr` | 是 | 账号正在等待扫码时，这次运行保存的二维码截图（`image/png`，只含二维码的 `login-qr.png` 优先，没有时为整页 `login.png`）；没有等待扫码或截图早于这次运行时 404。二维码解析不出登录链接时页面用它代替本地生成的二维码 |
| `GET api/accounts/:id/runs/:runId/log` | 是 | 运行日志（`text/plain`）；`?download=1` 时作为附件下载；超过保留天数被清理后返回 404 |
| `GET api/accounts/:id/calendar` | 是 | 打卡日历，`?month=YYYY-MM`（默认本月）：每天的阅读分钟数与是否打卡、今天、本月合计与本轮挑战进度，见下文 |
| `GET api/events` | 是 | 实时推送（SSE），见下文 |

接口返回的错误为 `{ error, message }`，`message` 可直接展示给用户。

### 页面

面板页面免构建：Vue 3（包含模板编译器的 ES 模块版本）、Pico.css 与 qrcode-generator 放在 `assets/vendor/`，页面代码是 `assets/app/` 下的 ES 模块，地址使用 hash 路由（`#/accounts/me/live`），部署在子路径下时相对路径始终正确。

| 页面 | 地址 | 内容 |
| --- | --- | --- |
| 登录 | `login` | 面板密码登录 |
| 总览 | `#/` | 顶部 Selenium 状态（就绪、已用/总会话数，连不上时的提示与处理办法）与 noVNC 链接；需要扫码的账号置顶并直接显示二维码；运行队列；每个账号一张卡片：运行状态或上次运行结果、今天的阅读分钟与是否打卡、下次运行时间、立即运行 / 仅登录 / 停止 |
| 账号 · 实时 | `#/accounts/<id>/live` | 状态、“正在读《书名》第 23/68 分钟”与进度条、二维码与“复制登录链接”、最新截图、实时日志；运行进行中且设置了 noVNC 地址时显示查看浏览器画面的链接 |
| 账号 · 历史 | `#/accounts/<id>/history` | 运行列表（开始时间、时长、触发方式、结果、阅读分钟），展开查看日志与截图，下载日志，加载更多 |
| 账号 · 打卡日历 | `#/accounts/<id>/calendar` | 按月显示每天的阅读分钟与打卡状态（已打卡、不足 5 分钟、今天未打卡高亮），本月合计；挑战进度与设置 |
| 账号 · 调度 | `#/accounts/<id>/schedules` | 编辑多条规则（每天固定时间 / 每 N 小时 / cron），单独启停，预览接下来的运行时间，保存后立即生效 |
| 账号 · 配置 | `#/accounts/<id>/config` | 名称与启用状态；运行配置的每一项可“继承全局”或“单独设置”；发送测试通知；删除账号（可选同时删除数据） |
| 新建账号 | `#/accounts/new` | 账号 ID 与名称，创建后进入账号页面并提示扫码 |
| 设置 | `#/settings` | 面板设置（时区、并发数、保留策略、noVNC 地址，填写 noVNC 地址时显示安全提示）；全局默认配置与测试通知；修改面板密码 |

| 规则 | 说明 |
| --- | --- |
| 时间显示 | 按面板设置中的时区显示，与调度、统计一致 |
| 实时推送 | 连接 `api/events`，断开时页面顶部提示，浏览器自动重连并以重连后的完整状态为准；断线期间结束的运行（重连后的完整状态中已没有它）从接口取回最终记录与日志，实时页面仍显示它的结果；会话失效时回到登录页 |
| 二维码 | 由登录链接在浏览器本地生成（不经过第三方服务）；手机上可复制登录链接发到微信中打开，非 HTTPS 访问时浏览器不允许写剪贴板，改为显示链接供手动复制 |
| 密钥 | 表单中只显示“已设置 / 未设置”，留空表示不修改，点“清除”删除 |
| 手机 | 390px 宽度下各页面没有横向滚动；表格在自身区域内横向滚动 |
| CSP | 面板主页面在浏览器内编译模板，需要 `'unsafe-eval'`，只对该页面放开（登录页、接口与静态文件不放开）。模板只写在 `assets/app/` 的脚本中，不使用 DOM 模板，不用 `v-html` 渲染内容 |

### 运行队列

每次运行（立即运行、仅登录或定时触发）都 fork 一个阅读子进程 `src/reader/worker.js`。子进程经 IPC 接收本次运行的配置（账号覆盖 > 全局默认 > 内置默认，在开始运行时合并），密钥不进入子进程的环境变量。

子进程只继承以下环境变量（白名单）：`PATH`、`HOME`、`USER`、`TZ`、`TMPDIR`、`LANG`、`LANGUAGE`、`LC_*`、`NODE_OPTIONS`、`NODE_EXTRA_CA_CERTS`、`NODE_USE_ENV_PROXY`，以及 `HTTP_PROXY`、`HTTPS_PROXY`、`NO_PROXY`（含小写形式）。面板所在环境中的其他变量都不会传给子进程，包括 `PANEL_PASSWORD`，以及 `BARK_KEY`、`EMAIL_PASS` 等按环境变量运行时使用的配置。

| 状态 | 值 | 进入条件 |
| --- | --- | --- |
| 排队中 | `queued` | 加入队列，等待并发槽位 |
| 启动中 | `starting` | 子进程已启动，正在连接浏览器、打开首页；登录成功后、打开书之前也是这个状态 |
| 等待扫码 | `waiting-login` | 子进程上报 `login-required`；`loginUrl` 为二维码中的登录链接，二维码刷新后随之更新；`loginQrAt` 为最近一次上报的时间，`loginUrl` 为空（解析不出链接）时页面据此加载 `login-qr` 截图（两者都不写入 meta.json） |
| 阅读中 | `reading` | 子进程上报 `book-opened`；`reading-minute` 更新 `minutes`、`plannedMinutes` 与最新截图文件名 `screenshot` |
| 成功 | `success` | 子进程上报 `done` |
| 失败 | `failed` | 子进程上报 `error`（`error` 为错误信息）或 `login-timeout`（`等待扫码超时`）；子进程退出前没有上报结果（`阅读子进程异常退出（退出码 N）`）；超过运行时长上限（`运行超时，已强制结束`） |
| 已停止 | `stopped` | 在面板中停止；排队时账号被停用也记为已停止 |
| 中断 | `interrupted` | 面板停止时仍在进行或排队；面板启动时发现上次遗留的进行中记录（断电、崩溃） |

| 规则 | 说明 |
| --- | --- |
| 同一账号 | 同时只有一个排队中或进行中的运行，重复触发返回 409 |
| 并发 | 同时运行的数量取面板设置 `maxConcurrentRuns`（应与 Selenium 的 `SE_NODE_MAX_SESSIONS` 一致），调大后立即启动排队中的运行；先到先运行 |
| 等待扫码 | 等待扫码期间一直占用并发槽位 |
| 停止 | 先发 SIGTERM，子进程关闭浏览器后退出；15 秒内没有退出则 SIGKILL，并请求 Selenium `DELETE /session/<会话 ID>` 清理会话 |
| 异常退出 | 子进程被信号结束或退出码不为 0 时，同样请求 Selenium 删除它留下的会话；删除完成后才启动下一个排队的运行 |
| 运行时长上限 | 等待扫码时长 + 阅读时长 + 30 分钟，超过后按停止流程结束子进程并记为失败，防止 Selenium 卡住时一直占用槽位 |
| 上报结果后 | 子进程上报结果后 3 分钟内仍未退出（关闭浏览器或发送通知卡住）时结束它，结果保持不变 |
| 面板停止 | 取消排队，结束所有子进程并等待退出（最长 15 秒），这些运行记为中断；`docker-compose.yml` 中 `stop_grace_period` 设为 30 秒，留出关闭浏览器的时间 |
| 面板断开 | 面板进程意外退出时，子进程检测到 IPC 断开后关闭浏览器并退出 |

每次运行保存在 `runs/<账号 ID>/<运行 ID>/` 下。运行 ID 由精确到毫秒的 UTC 时间与随机后缀组成，例如 `20261015T063000123Z-3f9a`，按字典序即按时间排序；第 7 步之前的运行 ID 只精确到秒（`20261015T063000Z-3f9a`），同样可以读取。

| 文件 | 内容 |
| --- | --- |
| `output.log` | 子进程的标准输出与标准错误，加上面板写入的 `[PANEL]` 行（加入队列、启动、停止请求、强制结束、退出码、运行结束）。写入与实时推送前，把本次运行配置中的密钥值（Bark Key、ntfy 主题、Token 与密码、SMTP 密码，4 个字符以上）以及微信读书登录链接中的 uid 替换为 `••••••`；子进程上报的错误信息同样处理 |
| `meta.json` | `id`、`accountId`、`accountName`、`mode`、`trigger`（`manual` 或 `schedule`）、`scheduleId`、`status`、`queuedAt`、`startedAt`、`endedAt`、`book`、`readingStartedAt`、`minutes`、`plannedMinutes`、`screenshot`、`minuteMarks`（每一分钟阅读完成的时间，按天统计使用；接口中不返回）、`error`、`exitCode`、`exitSignal`；状态变化与每分钟进度都会更新；不保存登录链接 |
| `screenshot-<分钟>.png` | 阅读截图，子进程直接写入运行目录（按保留策略清理） |

### 运行历史与统计

| 规则 | 说明 |
| --- | --- |
| 当日阅读分钟 | 当天所有运行中每一分钟阅读进度的累计，失败、停止的运行已读的部分也计入；跨午夜的运行按每一分钟完成的时间拆到各自的日期 |
| 日期 | 按面板设置中的时区划分；修改时区后，历史数据按新的时区重新归属 |
| 有效打卡 | 当日阅读分钟 ≥ 5 |
| 本轮挑战 | 月卡：开始日起 30 天内打卡 29 天、累计 30 小时；年卡：365 天内打卡 360 天、累计 300 小时。进度包括第几天（`dayNumber`，未开始为 0）、状态（`not-started` / `active` / `ended`）、已打卡天数、累计分钟、已漏打卡天数（不含今天）、可漏打卡天数（月卡 1 天、年卡 5 天）与是否达成 |
| 旧记录 | 第 7 步之前的运行没有逐分钟时间，按开始阅读后每分钟一条估算 |
| 口径 | 接口返回 `note`：“按本工具运行记录统计，非微信读书官方数据” |

打卡日历（`GET api/accounts/:id/calendar`）返回：

```json
{
  "timezone": "Asia/Shanghai",
  "month": "2026-10",
  "checkInMinutes": 5,
  "today": { "date": "2026-10-16", "minutes": 68, "checkedIn": true },
  "days": [{ "date": "2026-10-01", "minutes": 70, "checkedIn": true, "future": false }],
  "monthMinutes": 1036,
  "monthCheckedDays": 15,
  "challenge": { "type": "month", "label": "月卡", "startDate": "2026-10-01", "endDate": "2026-10-30", "status": "active", "dayNumber": 16, "totalDays": 30, "checkedDays": 15, "requiredDays": 29, "totalMinutes": 1036, "requiredMinutes": 1800, "missedDays": 0, "allowedMissedDays": 1, "achieved": false },
  "note": "按本工具运行记录统计，非微信读书官方数据"
}
```

### 数据保留

| 数据 | 保留 | 说明 |
| --- | --- | --- |
| 阅读截图 | 每个账号最近 `screenshotRetentionRuns` 次有截图的运行（默认 3，0 为不保留） | 仅登录等没有截图的运行不占名额 |
| 运行日志 | `logRetentionDays` 天（默认 30），按运行结束时间计算 | 删除后日志接口返回 404，运行历史中 `hasLog` 为 false |
| 运行记录 | 永久 | 打卡日历依赖它 |

清理在面板启动时、每次运行结束后、修改这两项设置后以及每 6 小时执行一次；进行中的运行不清理。已删除账号留下的运行记录同样按此清理。

### 调度

每个账号可以有多条调度规则，到点后以“定时”方式把阅读加入运行队列。时间按面板设置中的时区（默认 `Asia/Shanghai`）解释，夏令时由时区数据处理。

| 类型 | 字段 | 示例 | 换算的 cron 表达式 |
| --- | --- | --- | --- |
| 每天固定时间 | `times`：1–24 个 `HH:MM`，去重并排序 | `{ "type": "daily", "times": ["06:00", "18:30"] }` | `0 6 * * *`、`30 18 * * *` |
| 每 N 小时 | `hours`：1、2、3、4、6、8、12（24 的约数）；`minute`：0–59，默认 0 | `{ "type": "interval", "hours": 6, "minute": 30 }` | `30 */6 * * *`（00:30、06:30、12:30、18:30） |
| cron | `expression`：5 段（分 时 日 月 周），不接受秒字段与 `@daily` 等别名，必须会触发 | `{ "type": "cron", "expression": "30 6 * * 1-5" }` | 原样使用 |

每条规则还有 `id`（小写字母与数字，1–16 位；不提交或重复时自动生成 6 位 ID）与 `enabled`（默认 true）。每个账号最多 10 条规则。

| 规则 | 说明 |
| --- | --- |
| 生效时机 | `panel.json` 每次修改后整体重建定时任务：修改规则、启用或停用账号、修改时区、删除账号都立即生效 |
| 停用 | 停用的规则、停用账号的所有规则都不触发，接口中也没有触发时间 |
| 重复触发 | 账号已在运行或排队时跳过本次触发，在 `panel.log` 中记录 `定时触发跳过：账号 <id>，规则 <规则 ID>（<说明>）：账号已在运行或排队：<id>` |
| 运行记录 | 定时触发的运行 `trigger` 为 `schedule`，`scheduleId` 为规则 ID；运行日志第一行为 `加入队列：定时触发（规则 <规则 ID>），阅读` |
| 错过的时间 | 面板停机期间错过的时间不补跑 |
| 手工修改 | 手工写入 `panel.json` 的无效规则在启动时跳过并记录日志，不影响其他规则 |

### 实时推送

`GET api/events` 为 SSE（`text/event-stream`），前端用 `EventSource` 连接：

| 事件 | 数据 | 说明 |
| --- | --- | --- |
| `snapshot` | `{ runs }` | 连接后立即发送一次，内容同 `GET api/runs`；断线重连后以它为准 |
| `run` | 运行状态 | 任一运行的状态或进度变化 |
| `log` | `{ runId, accountId, line }` | 运行日志新增一行 |

响应头带 `Cache-Control: no-cache` 与 `X-Accel-Buffering: no`，`retry: 3000` 让浏览器断线 3 秒后重连。退出登录、修改密码时立即断开相应会话的连接（修改密码会断开所有旧会话的连接）。每 15 秒发送一次心跳注释，同时检查会话是否过期，过期的连接在下一次心跳时断开。长连接不会延长会话有效期。

### Selenium 状态与 noVNC

`GET api/selenium/status` 对全局默认配置与各账号实际生效配置中的每个 Selenium 地址查询一次 `/status`（同一地址同时只发一个请求）：

```json
{
  "checkedAt": "2026-10-16T10:00:00.000Z",
  "maxConcurrentRuns": 1,
  "servers": [
    {
      "url": "http://selenium:4444",
      "isDefault": true,
      "accounts": [{ "id": "me", "name": "我" }],
      "panelRuns": 1,
      "state": "busy",
      "ready": false,
      "message": "Selenium Grid not ready.",
      "sessions": { "used": 1, "total": 1 },
      "nodes": 1,
      "error": ""
    }
  ]
}
```

| 字段 | 说明 |
| --- | --- |
| `url` | Selenium 地址，没有协议时按 `http://` 处理；去掉了其中的用户名与密码（查询时仍会带上） |
| `isDefault` / `accounts` | 是否为全局默认配置中的地址；实际使用该地址的账号（配置无效的账号不列出） |
| `panelRuns` | 面板在该地址上已启动的运行数，每个运行占用一个会话 |
| `state` | `ready` 就绪；`busy` 会话已满（Grid 在会话全部占用时 `ready` 为 false，不算故障）；`not-ready` 未就绪（刚启动、没有可用节点等）；`unreachable` 无法连接 |
| `sessions` | `{ used, total }`：Selenium Grid（含 `selenium/standalone-*` 镜像）由节点的会话槽位得到，`total` 只计状态为 UP 的节点、每个节点不超过其 `maxSessions`；chromedriver 不提供会话数，为 null |
| `error` | 无法连接时的原因：连接被拒绝、找不到主机、3 秒内没有响应、返回的不是 Selenium 状态、HTTP 状态码等 |

| 页面行为 | 说明 |
| --- | --- |
| 刷新 | 打开总览时查询，之后每 30 秒（页面在后台时跳过）、运行开始或结束 3 秒后各刷新一次，也可点“刷新” |
| 无法连接 | 卡片变红并提示“阅读和扫码登录都无法开始”，给出处理办法：确认 Selenium 容器在运行（`docker compose up -d selenium`）、检查设置中的 Selenium 地址 |
| 不属于面板的会话 | 已用会话数多于面板自己的运行时提示：可能是其他程序在用，或没有正常关闭的会话（Selenium 会在会话空闲超时后回收） |
| 并发数超过会话数 | 设置中的“同时运行的账号数”（不超过使用该地址的账号数）大于该 Selenium 的会话数时提示：多出的运行会在 Selenium 中等待，超时后失败；应调低设置或调大 `SE_NODE_MAX_SESSIONS` |
| 多个地址 | 每个地址一行，标出是否为全局默认与使用它的账号；整体状态取最差的一个 |

阅读子进程连接浏览器前也会查询一次，在运行日志中记录 `Selenium 状态（<地址>）：就绪，已用 0/1 个会话：Selenium Grid ready.`；连不上时运行失败，错误为 `无法连接 Selenium（<地址>）：连接被拒绝（ECONNREFUSED），请确认 Selenium 正在运行、地址正确`。日志中的地址同样去掉用户名与密码。

noVNC 默认关闭：只有在设置中填写“noVNC 地址”后，总览与进行中运行的实时页面才显示“查看浏览器画面（noVNC）”链接（新窗口打开，`rel="noopener noreferrer"`）。`selenium/standalone-*` 镜像在容器内 7900 端口提供 noVNC，`docker-compose.yml` 中有注释掉的端口映射与 VNC 环境变量示例。地址后可加 noVNC 参数，如 `http://192.168.1.10:7900/?autoconnect=1&resize=scale&view_only=1`。

| 安全 | 说明 |
| --- | --- |
| 画面即已登录的浏览器 | 能打开 noVNC 并知道 VNC 密码的人可以看到并操作已登录微信读书的浏览器 |
| 不经反向代理暴露 | 不建议经反向代理或公网暴露 7900 端口；只映射到本机（`127.0.0.1:7900:7900`）或可信局域网的地址 |
| 修改默认密码 | Selenium 镜像默认 VNC 密码为 `secret`，开启前用 `SE_VNC_PASSWORD` 修改 |
| 只读 | `SE_VNC_VIEW_ONLY=1` 让 VNC 只能看、不能操作；同一 Selenium 同时运行多个会话时，画面中多个浏览器窗口重叠显示 |
| 地址中的密码 | noVNC 支持在地址中带 `password=` 参数，但设置中的地址会显示在页面上，不建议写入 |

### 数据与配置

```
data/
  panel.json              # 面板设置、全局默认配置、账号与调度规则、密码哈希（0600）
  panel.json.bak          # 上一版 panel.json，损坏时自动恢复（0600）
  panel.log
  panel.lock              # 面板运行期间存在，防止同一数据目录启动多个面板
  accounts/<id>/          # 账号数据（0700）：cookies.json、login.png、login-qr.png（0600；命令行运行时的截图也在这里）
  runs/<id>/<runId>/      # 每次运行：meta.json、output.log、screenshot-*.png
```

`panel.json` 的结构：

```json
{
  "version": 1,
  "auth": { "passwordHash": "scrypt$..." },
  "settings": {
    "timezone": "Asia/Shanghai",
    "maxConcurrentRuns": 1,
    "logRetentionDays": 30,
    "screenshotRetentionRuns": 3,
    "vncUrl": ""
  },
  "defaults": { "seleniumUrl": "http://selenium:4444", "duration": 68 },
  "accounts": [
    {
      "id": "me",
      "name": "小明",
      "enabled": true,
      "createdAt": "2026-10-15T00:00:00.000Z",
      "overrides": { "selection": -1 },
      "schedules": [{ "id": "a1b2c3", "type": "daily", "times": ["06:00"], "enabled": true }],
      "challenge": { "type": "month", "startDate": "2026-10-01" }
    }
  ]
}
```

| 规则 | 说明 |
| --- | --- |
| 配置合并 | 账号覆盖 > 全局默认 > 内置默认 |
| 面板管理的配置项 | 数据目录为 `accounts/<id>`、浏览器配置名为账号 ID、通知中的账号名称为账号名称，不能通过接口修改 |
| 修改语义 | 提交的项按配置清单校验并转换类型；`null` 或空字符串表示删除该项，回到上一级的值 |
| 密钥只写不读 | 接口返回 `••••••`；提交掩码或空字符串表示不修改，提交 `null` 表示清除 |
| 账号 ID | 小写字母、数字与短横线，1–32 位，不以短横线开头或结尾；创建后不可修改 |
| 删除账号 | 默认保留数据目录与运行记录，重新添加同 ID 的账号时沿用其中的 cookies |
| 停用账号 | `enabled: false` 的账号不会被定时运行，也不能手动运行（接口返回 409，`run --account` 直接报错）；已在排队的运行开始前发现账号被停用时记为已停止 |
| 按账号运行 | `node src/cli.js run --account <id>` 按上述合并结果运行一次，见 `docs/cli.md` |

### 安全

| 项目 | 做法 |
| --- | --- |
| 密码 | scrypt（N=16384, r=8, p=1）加盐哈希，比较使用定长时间比较；新密码至少 8 位 |
| 会话 | 32 字节随机令牌；cookie `wa_session` 为 `HttpOnly`、`SameSite=Strict`，HTTPS 时加 `Secure`，`Path` 为面板子路径；7 天滑动过期，cookie 最多每小时重新下发一次 |
| 登录限速 | 同一 IP 连续失败 5 次后锁定 30 秒，之后每次失败锁定时长翻倍，最长 15 分钟；所有 IP 在 15 分钟内累计失败 100 次后暂停全部登录 15 分钟 |
| 跨站请求伪造 | 修改类请求必须带 `X-WA-Request: 1` 请求头且为 JSON，配合 `SameSite=Strict` |
| 响应头 | `Content-Security-Policy`（只允许同源脚本、样式与连接，禁止被嵌入；面板主页面额外允许 `'unsafe-eval'`，见“页面”）、`X-Frame-Options: DENY`、`Referrer-Policy: no-referrer`、`X-Content-Type-Options: nosniff`；接口响应 `Cache-Control: no-store` |
| 文件 | `panel.json` 权限 0600，已有文件在启动时收紧；账号数据目录 0700，`cookies.json` 与登录二维码图片 0600（等同于登录状态）；初始密码不写入日志文件 |
| 容器 | 面板进程以 `node` 用户运行：入口脚本以 root 把数据目录中不属于 `node` 的文件改过来后再降权。镜像的 `HEALTHCHECK` 由 Docker 以镜像默认用户（root）执行，只请求本机的 `/healthz`，不读写数据目录 |

### 反向代理

面板应部署在自有反向代理之后，由代理提供 HTTPS。以 Nginx 子路径为例（面板设置 `PANEL_BASE_PATH=/weread/`、`PANEL_TRUST_PROXY=true`）：

```nginx
location /weread/ {
    proxy_pass http://127.0.0.1:26868/weread/;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}

# 实时推送：关闭缓冲，并让长连接不因读超时被断开（面板每 15 秒发送一次心跳）
location /weread/api/events {
    proxy_pass http://127.0.0.1:26868/weread/api/events;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_buffering off;
    proxy_read_timeout 1h;
}
```

| 注意事项 | 说明 |
| --- | --- |
| 代理层数 | `PANEL_TRUST_PROXY` 填面板前面的代理层数。面板取 `X-Forwarded-For` 中从右往左数第 N 个地址作为客户端 IP，客户端自己伪造的部分会被忽略 |
| 不信任代理时 | 忽略 `X-Forwarded-*` 请求头，按连接地址限速，cookie 不加 `Secure` |
| 端口映射 | 代理与面板在同一主机时映射为 `127.0.0.1:26868:26868`，不直接暴露到公网 |
| 额外防护 | 建议在代理层再加一层认证（Basic Auth、Cloudflare Access 等） |

### 关键约束

| 约束 | 说明 |
| --- | --- |
| 端口被占用 | 直接报错退出并提示通过 `PANEL_PORT` 更换，不自动换用其他端口 |
| 单实例 | 同一数据目录只能运行一个面板：启动时创建 `panel.lock`（记录主机名与进程号，每 10 秒更新修改时间），已被其他运行中的面板持有时报错退出。持有者进程已不存在、是本进程号（容器重启）或其他主机的锁超过 30 秒未更新时视为遗留并接管；正常停止时删除 |
| 只由面板写入 | `panel.json` 只由持有锁的面板写入；`run --account` 以只读方式读取 |
| 请求体 | 修改类请求带请求体时必须是 JSON；不带请求体（如删除账号、退出登录）时只需 `X-WA-Request` 请求头 |
| 停止信号 | 收到 SIGTERM / SIGINT 时结束进行中的运行（见“运行队列”），关闭服务后退出 |
| 日志 | 写入标准输出与 `<数据目录>/panel.log`（每次启动覆盖） |
