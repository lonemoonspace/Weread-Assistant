# Alpine 只在最新的稳定分支更新 Chromium：升级 Alpine 版本时一并修改，旧分支中的 Chromium 不再获得安全更新
FROM node:24-alpine3.24

LABEL org.opencontainers.image.title="WeReadAssistant" \
      org.opencontainers.image.description="非官方的微信读书自动阅读助手，带 Web 管理面板（与腾讯无关）" \
      org.opencontainers.image.source="https://github.com/lonemoonspace/Weread-Assistant" \
      org.opencontainers.image.licenses="MIT"

# su-exec：入口脚本修正数据目录属主后，以 node 用户运行
# tini：作为 1 号进程转发信号、回收浏览器退出后留下的进程
# chromium、chromium-chromedriver：内置浏览器，面板设置中的 Selenium 地址留空时使用；font-wqy-zenhei：中文字体
RUN apk add --no-cache su-exec tini chromium chromium-chromedriver font-wqy-zenhei

WORKDIR /app
COPY package.json package-lock.json ./
# 生产依赖都不需要安装脚本：不运行，避免以 root 执行依赖中的代码
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY src ./src
COPY docker-entrypoint.sh /usr/local/bin/weread-entrypoint.sh
RUN chmod 755 /usr/local/bin/weread-entrypoint.sh

ENV NODE_ENV=production
EXPOSE 26868
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "src/panel/healthcheck.js"]

ENTRYPOINT ["weread-entrypoint.sh"]
CMD ["node", "src/cli.js", "panel"]
