# CI 中外部 Selenium 兼容性测试使用的镜像（见 .github/workflows/ci.yml 的 browser 任务）。
# 只有一行 FROM，放在这里是为了让 Dependabot 的 docker 生态跟踪它的版本
FROM selenium/standalone-chromium:4.51.0-20261010
