## Docker image 推送验收用例

| 场景 | 前置条件 / 输入 | 预期结果 |
| --- | --- | --- |
| 查看帮助 | 执行 `node scripts/docker-image.js` | 输出 `check`、`build`、`push` 的用法，不执行 Docker 构建或推送 |
| 查看默认配置 | 执行 `node scripts/docker-image.js check` | 输出默认镜像名 `docker.io/lonemoonspace/weread-challenge`、默认 tag 为 `package.json` 中的版本号、默认平台 `linux/arm64`，并确认 `Dockerfile` 与构建上下文存在 |
| 自定义单 tag 构建 | 执行 `node scripts/docker-image.js build --tag latest` | 实际构建命令使用 `docker.io/lonemoonspace/weread-challenge:latest`，且不带 `--platform`（使用宿主平台） |
| 发布版本自动补 latest | 执行 `node scripts/docker-image.js push --tag 0.18.1` | 一次 `docker buildx build --platform linux/arm64 ... -t ...:0.18.1 -t ...:latest --push` 同时发布两个 tag |
| 推送 dev | 执行 `npm run docker:image:push:dev` | 一次 `docker buildx build --platform linux/arm64 -t ...:dev --push`，只发布 `dev`，不补 `latest` |
| build 拒绝多平台 | 执行 `node scripts/docker-image.js build --platform linux/amd64,linux/arm64` | 直接报错，提示 `build` 无法 `--load` 多平台镜像，并建议改用 `push` |
| 平台串去空白与去重 | 执行 `node scripts/docker-image.js build --platform "linux/arm64, linux/arm64"` | 转发给 buildx 的 `--platform` 为 `linux/arm64` |
| 缺少参数值 | 执行 `node scripts/docker-image.js build --tag` | 直接报错 `Missing value for --tag`，不执行 Docker 命令 |
| 不支持的参数 | 执行 `node scripts/docker-image.js build --unknown value` | 直接报错 `Unknown option: --unknown`，不执行 Docker 命令 |
