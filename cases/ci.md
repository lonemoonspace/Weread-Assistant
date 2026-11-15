## CI 与发布验收用例

CI 见 `.github/workflows/ci.yml`，镜像发布见 `.github/workflows/release.yml`、`image.yml` 与 `docs/docker-image-publish.md`“自动发布”，每周重建见 `rebuild.yml`。

| 场景 | 前置条件 / 输入 | 预期结果 |
| --- | --- | --- |
| 自查 | 执行 `npm run check` | 输出语法检查、第三方文件校验值、页面约定 3 项并退出码 0 |
| 自查发现问题 | 分别：面板页面的 ES 模块中写入语法错误；模板中加 `style="..."` 或 `v-html`；`index.html` 中加内联脚本；`login.html` 引用不存在的脚本；改动 `assets/vendor/README.md` 中的校验值；CommonJS 脚本中写入语法错误 | 每种情况都退出码 1，并指出文件与问题（ES 模块按模块方式检查，不会因 `import` 语句被跳过） |
| Pull Request 检查 | 向 `main` 发起 Pull Request | 运行 6 个任务并全部通过：自查与 smoke（`npm run check`、ESLint、单元测试与覆盖率报告、`docker compose config`、通知、配置、面板）；依赖安全检查（`npm audit --omit=dev --audit-level=high`）；阅读流程与页面（主机网络的 Selenium，镜像版本取自 `ci/selenium.Dockerfile`，页面截图作为 artifact 保存 7 天）；工作流检查（actionlint）；镜像构建与检查 amd64、arm64（各自的原生 runner 上构建，摘要中写明镜像体积，运行 `test:runtime`（`RUNTIME_SMOKE_ARCH` 为本架构）与内置浏览器的阅读流程 smoke） |
| 同一分支再次推送 | Pull Request 的 CI 运行中再次推送 | 旧的运行被取消 |
| 第三方 Action | 查看工作流文件 | 每个 Action 都按提交 SHA 固定，注释中写明版本；`actions/checkout` 不保留凭据 |
| main 发布 dev | 合并到 `main` 后 CI 通过 | “发布镜像”工作流运行，amd64 与 arm64 在原生 runner 上分别构建、检查并按摘要推送，汇总任务合成清单后推送 `docker.io/lonemoonspace/weread-assistant:dev`；`docker buildx imagetools inspect lonemoonspace/weread-assistant:dev` 有 `linux/amd64` 与 `linux/arm64`，镜像标签中的 revision 为该提交 |
| 一个架构失败 | 发布时某个架构的检查失败 | 汇总任务不运行，所有 tag 保持原样 |
| main 的 CI 失败 | CI 中任一任务失败 | 不发布 |
| Pull Request 的 CI | Pull Request 触发的 CI 完成 | “发布镜像”工作流不发布（跳过） |
| 缺少凭据 | 仓库中没有 `DOCKERHUB_USERNAME` / `DOCKERHUB_TOKEN` | 在构建前失败，提示在 Settings → Secrets and variables → Actions 中添加 |
| 合并即发布 | `package.json` 版本改为还没有 tag 的 `0.1.0`，`CHANGELOG.md` 有 `## 0.1.0`，合并到 `main` 后 CI 通过 | 推送 `0.1.0`、`latest` 与 `dev`（同一个镜像）；在该提交上创建 tag `v0.1.0` 与 GitHub Release `v0.1.0`，标题 `WeReadAssistant 0.1.0`，说明为 `CHANGELOG.md` 中 0.1.0 一节；之后 main 上的提交只发布 `dev` |
| 合并即发布但缺少说明 | 同上，但 `CHANGELOG.md` 中没有 `## 0.1.0` | 在构建前失败，提示 CHANGELOG 中没有该版本的说明，不推送镜像、不创建 tag |
| 发布版本 | `package.json` 版本为 `0.1.0`，`CHANGELOG.md` 有 `## 0.1.0`，推送 tag `v0.1.0` | 推送 `0.1.0` 与 `latest`（同一个镜像）；创建 GitHub Release `v0.1.0`，标题 `WeReadAssistant 0.1.0`，说明为 `CHANGELOG.md` 中 0.1.0 一节 |
| tag 与版本不一致 | `package.json` 版本为 `0.1.0` 时推送 `v0.2.0` | 失败并提示应为 `v0.1.0`，不构建、不推送 |
| 其他分支手动运行 | 在非 `main` 分支上手动运行“发布镜像” | 只发布 `dev`（版本标签为 `<版本>-dev`），不创建 tag 与 Release；用于验证发布流程 |
| 每周重建：没有更新 | 已发布的 `latest` 中没有可升级的系统包，Node.js 版本与基础镜像一致 | 摘要中列出 Chromium 与 Node.js 版本、“软件包都是最新的”，不重建；照常用 Trivy 扫描 `latest` |
| 每周重建：有更新或强制 | 有可升级的系统包，或手动运行时选择“没有更新时也重建” | 检出最近一个正式版本的 tag，按发布流程构建、检查两个架构，推送该版本号与 `latest`；`latest` 已指向更新的版本时不改动 `latest` |
| 漏洞扫描 | Trivy 发现有修复版本的高危或严重漏洞 | 摘要中列出，创建 issue“镜像中有可修复的高危漏洞”，已有时追加评论；不阻断 |
| 新的 Alpine | Docker Hub 上出现下一个 Alpine 稳定版的 Node.js 镜像 | 创建 issue“升级基础镜像到 …”，已有时不重复创建 |
| Dependabot | 每月 | npm、GitHub Actions、Dockerfile 基础镜像、`ci/selenium.Dockerfile` 的更新各合并为一个 Pull Request（npm 只合并次要版本与补丁）；不提 Node.js 镜像的主版本升级（如 `node:24-alpine` → `node:25-alpine`） |
