# Alpine 只在最新的稳定分支更新 Chromium：升级 Alpine 版本时一并修改，旧分支中的 Chromium 不再获得安全更新
FROM node:24-alpine3.24

LABEL org.opencontainers.image.title="WeReadAssistant" \
      org.opencontainers.image.description="非官方的微信读书自动阅读助手，带 Web 管理面板（与腾讯无关）" \
      org.opencontainers.image.source="https://github.com/lonemoonspace/Weread-Assistant" \
      org.opencontainers.image.licenses="MIT"

# su-exec：入口脚本修正数据目录属主后，以 node 用户运行
# tini：作为 1 号进程转发信号、回收浏览器退出后留下的进程
# chromium、chromium-chromedriver：内置浏览器，面板设置中的 Selenium 地址留空时使用；font-wqy-zenhei：中文字体
# （Alpine 把 Chromium 的界面语言包拆在 chromium-lang 中，这里没有安装，不需要另外删除）
RUN apk add --no-cache su-exec tini chromium chromium-chromedriver font-wqy-zenhei

WORKDIR /app
COPY package.json package-lock.json ./
# 生产依赖都不需要安装脚本：不运行，避免以 root 执行依赖中的代码。
# selenium-webdriver 自带的 Selenium Manager（各平台的二进制）用不到：内置浏览器使用系统的 chromedriver
# 装完依赖后删掉基础镜像自带的 npm、corepack（以及可能存在的 yarn）：运行时只需要 node，
# 它们内部打包的依赖（如 undici、brace-expansion）是每周漏洞扫描告警的来源（#55）
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force \
  && rm -rf node_modules/selenium-webdriver/bin \
  && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
    /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
    /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn-* /root/.npm
COPY src ./src
COPY docker-entrypoint.sh /usr/local/bin/weread-entrypoint.sh
RUN chmod 755 /usr/local/bin/weread-entrypoint.sh

ENV NODE_ENV=production
EXPOSE 26868
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "src/panel/healthcheck.js"]

ENTRYPOINT ["weread-entrypoint.sh"]
CMD ["node", "src/cli.js", "panel"]
