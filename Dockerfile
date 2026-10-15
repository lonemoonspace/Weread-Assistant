FROM node:24-alpine

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
