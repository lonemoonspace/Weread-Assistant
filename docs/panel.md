## Web 面板说明

> 已完成：登录、会话、修改密码、反向代理支持，以及全局设置、默认配置与账号管理接口。调度、运行队列、运行记录与完整的页面按 `docs/design.md` 的开发计划逐步加入。

### 启动

```bash
node src/cli.js                      # 不带参数即启动面板
PANEL_PORT=30000 node src/cli.js panel
```

镜像默认命令就是启动面板。首次启动且未设置 `PANEL_PASSWORD` 时，面板随机生成一个 16 位密码，只在标准输出（`docker logs`）中打印一次，不写入 `panel.log`：

```bash
docker logs <容器名> 2>&1 | grep 面板初始密码
```

### 配置

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PANEL_PORT` | `26868` | 监听端口，1–65535；选用不常见端口，避开常被占用的 8080 等端口。只能通过环境变量设置，与镜像健康检查读取同一个值 |
| `PANEL_HOST` | `0.0.0.0` | 监听地址 |
| `PANEL_PASSWORD` | 空 | 面板密码；设置后以它为准，界面中不能修改 |
| `PANEL_BASE_PATH` | `/` | 部署在反向代理子路径下时设置，例如 `/weread/` |
| `PANEL_TRUST_PROXY` | `false` | `true` 表示信任 1 层代理，也可填信任的代理层数 |
| `PANEL_PUBLIC_URL` | 空 | 面板的外网地址，后续用于推送中的跳转链接 |
| `PANEL_DATA_DIR` | `data` | 面板数据目录，保存 `panel.json`、`panel.log` 与各账号的数据 |
| `SELENIUM_URL` | 空 | 首次初始化全局默认配置时写入 Selenium 地址；之后以面板中的设置为准 |

### 职责

| 组件 | 职责 | 关键约束 |
| --- | --- | --- |
| `src/panel/options.js` | 读取 `PANEL_*` 环境变量 | 规范化子路径、代理层数与端口；取值非法时报错退出 |
| `src/panel/settings.js` | 面板设置（时区、并发数、保留策略、noVNC 地址）的清单与校验 | 值为 null 时恢复默认 |
| `src/panel/config.js` | 运行配置的表单清单、全局默认与账号覆盖的修改、合并与密钥掩码 | 面板管理的配置项不出现在接口中 |
| `src/panel/accounts.js` | 账号增删改查 | 账号 ID 创建后不可修改；删除时默认保留数据目录 |
| `src/panel/store.js` | `panel.json` 读写 | 串行写入、先写临时文件再重命名、权限 0600；启动时把已有文件的权限收紧为 0600，改不了或文件损坏时拒绝启动；补齐缺少的部分（旧文件自动升级） |
| `src/panel/auth.js` | 密码哈希、会话、登录限速、修改密码 | 密码以 scrypt 哈希保存；会话只在内存中保存令牌哈希，面板重启后需重新登录 |
| `src/panel/server.js` | Express 应用、页面与接口 | 统一安全响应头；修改类请求校验自定义请求头 |
| `src/panel/healthcheck.js` | 镜像 `HEALTHCHECK` 使用 | 请求 `<子路径>healthz` |
| `src/panel/public/` | 登录页与占位页面 | 不使用内联脚本与样式 |

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
| `GET api/accounts` | 是 | 账号列表，含是否已有 cookies |
| `POST api/accounts` | 是 | `{ id, name? }`；成功 201，ID 已存在 409，ID 或名称非法 400；同时创建账号数据目录 |
| `GET api/accounts/:id` | 是 | `{ account, effective }`：账号与实际生效的运行配置 |
| `PATCH api/accounts/:id` | 是 | `{ name?, enabled?, overrides? }`；ID 不可修改 |
| `DELETE api/accounts/:id` | 是 | `{ deleteData? }`；默认只从面板移除，`deleteData: true` 时同时删除账号数据目录 |

接口返回的错误为 `{ error, message }`，`message` 可直接展示给用户。

### 数据与配置

```
data/
  panel.json              # 面板设置、全局默认配置、账号、密码哈希（0600）
  panel.log
  accounts/<id>/          # 账号数据：cookies.json、login.png、login-qr.png、截图、output.log
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
    { "id": "me", "name": "小明", "enabled": true, "createdAt": "2026-10-15T00:00:00.000Z", "overrides": { "selection": -1 } }
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
| 删除账号 | 默认保留数据目录，重新添加同 ID 的账号时沿用其中的 cookies |
| 按账号运行 | `node src/cli.js run --account <id>` 按上述合并结果运行一次，见 `docs/cli.md` |

### 安全

| 项目 | 做法 |
| --- | --- |
| 密码 | scrypt（N=16384, r=8, p=1）加盐哈希，比较使用定长时间比较；新密码至少 8 位 |
| 会话 | 32 字节随机令牌；cookie `wa_session` 为 `HttpOnly`、`SameSite=Strict`，HTTPS 时加 `Secure`，`Path` 为面板子路径；7 天滑动过期，cookie 最多每小时重新下发一次 |
| 登录限速 | 同一 IP 连续失败 5 次后锁定 30 秒，之后每次失败锁定时长翻倍，最长 15 分钟；所有 IP 在 15 分钟内累计失败 100 次后暂停全部登录 15 分钟 |
| 跨站请求伪造 | 修改类请求必须带 `X-WA-Request: 1` 请求头且为 JSON，配合 `SameSite=Strict` |
| 响应头 | `Content-Security-Policy`（只允许同源脚本、样式与连接，禁止被嵌入）、`X-Frame-Options: DENY`、`Referrer-Policy: no-referrer`、`X-Content-Type-Options: nosniff`；接口响应 `Cache-Control: no-store` |
| 文件 | `panel.json` 权限 0600，已有文件在启动时收紧；初始密码不写入日志文件 |
| 容器 | 以 `node` 用户运行；入口脚本先把数据目录中不属于 `node` 的文件改过来再降权 |

### 反向代理

面板应部署在自有反向代理之后，由代理提供 HTTPS。以 Nginx 子路径为例（面板设置 `PANEL_BASE_PATH=/weread/`、`PANEL_TRUST_PROXY=true`）：

```nginx
location /weread/ {
    proxy_pass http://127.0.0.1:26868/weread/;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
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
| 停止信号 | 收到 SIGTERM / SIGINT 时关闭服务后退出，`docker stop` 不需要等待超时 |
| 日志 | 写入标准输出与 `<数据目录>/panel.log`（每次启动覆盖） |
