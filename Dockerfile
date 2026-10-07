# syntax=docker/dockerfile:1
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY scripts ./scripts
COPY web ./web
COPY tailwind.config.cjs ./
RUN npm run build:web

FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server ./server
COPY bot ./bot
COPY --from=build /app/web/dist ./web/dist
USER node
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# Default: the API. The Telegram bot (bot/) uses this same image with its CMD overridden to
# ["node", "bot/src/index.js"] and its healthcheck disabled (see docker-compose.yml) - it has no
# HTTP server of its own to probe.
CMD ["node", "server/src/index.js"]
