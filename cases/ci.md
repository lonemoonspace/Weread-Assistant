## CI 与发布验收用例

CI 见 `.github/workflows/ci.yml`，镜像发布见 `.github/workflows/release.yml` 与 `docs/docker-image-publish.md`“自动发布”。

| 场景 | 前置条件 / 输入 | 预期结果 |
| --- | --- | --- |
| 自查 | 执行 `npm run check` | 输出语法检查、第三方文件校验值、页面约定 3 项并退出码 0 |
| 自查发现问题 | 分别：面板页面的 ES 模块中写入语法错误；模板中加 `style="..."` 或 `v-html`；`index.html` 中加内联脚本；`login.html` 引用不存在的脚本；改动 `assets/vendor/README.md` 中的校验值；CommonJS 脚本中写入语法错误 | 每种情况都退出码 1，并指出文件与问题（ES 模块按模块方式检查，不会因 `import` 语句被跳过） |
| Pull Request 检查 | 向 `main` 发起 Pull Request | 运行 4 个任务并全部通过：自查与 smoke（`npm run check`、`docker compose config`、通知、配置、面板）；依赖安全检查（`npm audit --omit=dev --audit-level=high`）；阅读流程与页面（主机网络的 `selenium/standalone-chromium`，页面截图作为 artifact 保存 7 天；另在本机构建的 amd64 镜像中用内置浏览器运行阅读流程 smoke）；arm64 镜像构建与运行检查（QEMU，`RUNTIME_SMOKE_ARCH=arm64`） |
| 同一分支再次推送 | Pull Request 的 CI 运行中再次推送 | 旧的运行被取消 |
| 第三方 Action | 查看工作流文件 | 每个 Action 都按提交 SHA 固定，注释中写明版本；`actions/checkout` 不保留凭据 |
| main 发布 dev | 合并到 `main` 后 CI 通过 | “发布镜像”工作流运行，构建并检查 arm64 镜像后推送 `docker.io/lonemoonspace/weread-assistant:dev`；`docker buildx imagetools inspect lonemoonspace/weread-assistant:dev` 只有 `linux/arm64`，镜像标签中的 revision 为该提交 |
| main 的 CI 失败 | CI 中任一任务失败 | 不发布 |
| Pull Request 的 CI | Pull Request 触发的 CI 完成 | “发布镜像”工作流不发布（跳过） |
| 缺少凭据 | 仓库中没有 `DOCKERHUB_USERNAME` / `DOCKERHUB_TOKEN` | 在构建前失败，提示在 Settings → Secrets and variables → Actions 中添加 |
| 合并即发布 | `package.json` 版本改为还没有 tag 的 `0.1.0`，`CHANGELOG.md` 有 `## 0.1.0`，合并到 `main` 后 CI 通过 | 推送 `0.1.0`、`latest` 与 `dev`（同一个镜像）；在该提交上创建 tag `v0.1.0` 与 GitHub Release `v0.1.0`，标题 `WeReadAssistant 0.1.0`，说明为 `CHANGELOG.md` 中 0.1.0 一节；之后 main 上的提交只发布 `dev` |
| 合并即发布但缺少说明 | 同上，但 `CHANGELOG.md` 中没有 `## 0.1.0` | 在构建前失败，提示 CHANGELOG 中没有该版本的说明，不推送镜像、不创建 tag |
| 发布版本 | `package.json` 版本为 `0.1.0`，`CHANGELOG.md` 有 `## 0.1.0`，推送 tag `v0.1.0` | 推送 `0.1.0` 与 `latest`（同一个镜像）；创建 GitHub Release `v0.1.0`，标题 `WeReadAssistant 0.1.0`，说明为 `CHANGELOG.md` 中 0.1.0 一节 |
| tag 与版本不一致 | `package.json` 版本为 `0.1.0` 时推送 `v0.2.0` | 失败并提示应为 `v0.1.0`，不构建、不推送 |
| 其他分支手动运行 | 在非 `main` 分支上手动运行“发布镜像” | 失败并提示只从 main 发布 dev 或从版本 tag 发布 |
| Dependabot | 每月 | npm、GitHub Actions、Dockerfile 基础镜像的更新各合并为一个 Pull Request（npm 只合并次要版本与补丁）；不提 Node.js 镜像的主版本升级（如 `node:24-alpine` → `node:25-alpine`） |
