## 运行 Smoke 验收用例

| 场景 | 前置条件 / 输入 | 预期结果 |
| --- | --- | --- |
| 查看 smoke 帮助 | 执行 `node scripts/runtime-smoke.js` 或 `node scripts/runtime-smoke.js help` | 输出 `docker` 子命令说明，不执行镜像构建 |
| 容器版 CLI 可运行 | 在仓库根目录执行 `node scripts/runtime-smoke.js docker`，且本机 Docker 可用 | 基于当前 `Dockerfile` 成功构建本地镜像，`docker run --rm <image> node src/cli.js help` 输出包含 `src/cli.js run`、`help`、`SELENIUM_URL`；结束后删除临时镜像 |
