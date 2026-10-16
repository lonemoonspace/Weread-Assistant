## 运行 Smoke 验收用例

| 场景 | 前置条件 / 输入 | 预期结果 |
| --- | --- | --- |
| 查看 smoke 帮助 | 执行 `node scripts/runtime-smoke.js` 或 `node scripts/runtime-smoke.js help` | 输出 `docker` 子命令与 `RUNTIME_SMOKE_IMAGE` 说明，不执行镜像构建 |
| 容器版 CLI 可运行 | 在仓库根目录执行 `npm run test:runtime`，且本机 Docker 可用 | 基于当前 `Dockerfile` 构建本地镜像，`node src/cli.js help` 输出包含 `src/cli.js run`、`help`、`SELENIUM_URL`、`PANEL_PORT` |
| 面板容器 | 同上 | 健康检查变为 `healthy`；1 号进程属于 `node`；`panel.json` 属于 `node` 且权限 600；`docker logs` 中有 16 位初始密码；`docker stop` 在 5 秒内完成；结束后删除容器与临时镜像 |
| 使用已有镜像 | 执行 `RUNTIME_SMOKE_IMAGE=<镜像> npm run test:runtime` | 跳过构建，其余检查相同，结束后不删除该镜像 |
| 检查架构 | `RUNTIME_SMOKE_IMAGE=<amd64 镜像> RUNTIME_SMOKE_ARCH=amd64`；同一镜像改为 `RUNTIME_SMOKE_ARCH=arm64` | 前者通过并输出 `image and Node.js process are amd64`（容器内 Node.js 报告 `x64`）；后者失败，提示镜像为 amd64、Node.js 为 x64 |
| arm64 镜像（CI） | CI 中用 QEMU 构建 `linux/arm64` 镜像，`RUNTIME_SMOKE_ARCH=arm64` | 镜像与容器内 Node.js 都是 arm64，其余检查全部通过 |
