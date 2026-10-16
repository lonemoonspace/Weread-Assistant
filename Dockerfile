FROM node:24-alpine

LABEL org.opencontainers.image.title="WeReadAssistant" \
      org.opencontainers.image.description="非官方的微信读书自动阅读助手，带 Web 管理面板（与腾讯无关）" \
      org.opencontainers.image.source="https://github.com/lonemoonspace/Weread-Assistant" \
      org.opencontainers.image.licenses="MIT"

# su-exec：入口脚本修正数据目录属主后，以 node 用户运行
RUN apk add --no-cache su-exec

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src
COPY docker-entrypoint.sh /usr/local/bin/weread-entrypoint.sh
RUN chmod 755 /usr/local/bin/weread-entrypoint.sh

ENV NODE_ENV=production
EXPOSE 26868
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "src/panel/healthcheck.js"]

ENTRYPOINT ["weread-entrypoint.sh"]
CMD ["node", "src/cli.js", "panel"]
