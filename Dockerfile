FROM node:lts-alpine

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm install --omit=dev
COPY src ./src

CMD ["node", "src/cli.js", "run"]
