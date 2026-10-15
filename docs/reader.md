## 自动阅读流程说明

### 职责

| 组件 | 职责 | 关键约束 |
| --- | --- | --- |
| `src/reader/run.js` `runOnce(config, options)` | 编排一次运行：连接浏览器、登录、选书、阅读、通知 | 返回 `{ status, minutes, error }`，`status` 为 `success` / `login-timeout` / `error`；不退出进程 |
| `src/reader/browser.js` | 连接 `SELENIUM_URL` 中的 Chromium，设置超时与随机窗口尺寸 | 隐式等待为 0 |
| `src/reader/login.js` | 打开首页、加载 cookies、展示二维码、等待扫码、保存 cookies | 按总时长等待，期间二维码过期就刷新 |
| `src/reader/reading.js` | 选书、切换上下滚动模式、阅读循环 | 每轮一次 `executeScript` 读取页面状态 |
| `src/reader/selectors.js` | 页面地址、定位器与关键文案 | 微信读书改版时只改这里 |
| `src/reader/timing.js` | 由配置得出各类等待时间与翻动间隔 | 测试可通过 `options.timing` 覆盖 |
| `src/reader/dom.js` | 显式等待与批量检查元素的工具函数 | 替代隐式等待 |

### 运行模式

| 模式 | 入口 | 行为 |
| --- | --- | --- |
| 阅读（默认） | `node src/cli.js run` | 登录后选书并按 `WEREAD_DURATION` 阅读 |
| 仅登录 | `node src/cli.js run --login-only` | 登录并保存 cookies 后结束，用于刷新登录态 |

### 流程

```mermaid
flowchart TD
  A[runOnce] --> B[createDriver]
  B --> C[打开首页并加载 cookies]
  C --> D{首页出现}
  D -->|登录入口| E[点击登录，截图并解析二维码，推送登录链接]
  D -->|我的书架| G
  E --> F{每秒检查一次}
  F -->|我的书架| G[登录成功，保存 cookies]
  F -->|二维码过期| H[点击刷新；失败则重新加载页面并再次打开登录弹窗]
  H --> F
  F -->|超过等待时长| T[login-timeout，发送失败通知]
  G --> I{模式}
  I -->|仅登录| S[success]
  I -->|阅读| J[选书并切换上下滚动模式]
  J --> K[阅读循环]
  K --> L[保存 cookies，发送完成通知]
  L --> S
```

### 阅读循环

每轮先等待一个随机翻动间隔，再用一次 `executeScript` 读取页面标题与各元素状态，然后按以下顺序处理：

| 顺序 | 条件 | 动作 |
| --- | --- | --- |
| 1 | 标题含“已读完”、出现“开通后即可阅读”或“全 书 完” | 打开目录，点第 2 个条目（只有一项时点这一项），回到书的开头附近 |
| 2 | “下一章”/“下一页”按钮完整出现在视口内 | 点击 |
| 3 | 出现“点击重试” | 点击 |
| 4 | 其他 | 按住方向键下 50–500 毫秒 |

每分钟截图一次（`WEREAD_SCREENSHOT`）。截图小于 100KB 视为白屏并刷新页面：阅读页正文由 canvas 绘制，无法通过 DOM 文本判断是否白屏。

### 翻动节奏

| `WEREAD_SPEED` | 翻动间隔 |
| --- | --- |
| `slow`（默认） | 13–19 秒 |
| `normal` | 8–12 秒 |
| `fast` | 4–8 秒 |

旧版设置了 5 秒隐式等待，每轮对不存在元素的检查都会被拖慢，实测每轮 10–15 秒，`WEREAD_SPEED` 原有的 0.1–1 秒随机间隔实际上不起作用。现在去掉了隐式等待，翻动节奏完全由上表决定，默认的 `slow` 与旧版的实际节奏接近。

### 关键约束

| 约束 | 说明 |
| --- | --- |
| 隐式等待为 0 | 元素不存在时立即返回；需要等元素出现的地方（首页入口、书架、切换按钮、目录条目）使用显式等待 |
| 等待扫码 | 由 `WEREAD_LOGIN_TIMEOUT`（分钟，默认 15）控制；二维码约 1 分钟过期，期间自动刷新，不限次数 |
| cookies | 先写临时文件再重命名；读取时内容损坏则改名为 `cookies.json.corrupt-<时间戳>` 并转入扫码；单个 cookie 加载失败只跳过该条 |
| 登录二维码 | `login.png` 为整页截图，`login-qr.png` 为二维码区域截图（用作邮件附件） |
| 首页校验 | 首页标题不是“微信读书”时报错 |
| 书名 | 从阅读页标题“书名 - 作者 - 微信读书”中解析，取不到时为空 |
| 日志 | `util.format` 格式化；`console.debug` 只在 `DEBUG=true` 时输出 |
