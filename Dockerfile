# Datix AI — imagine de producție (server Node + interfața PWA construită).

# ---------------------------------------------------------------- 1. construcție
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY tsconfig.base.json ./
COPY shared shared
COPY server server
COPY web web
RUN npm run build

# ---------------------------------------------------------------- 2. dependențe de rulare
# better-sqlite3 vine cu binare precompilate (N-API): nu e nevoie de compilator, iar scripturile
# de instalare ale pachetelor nu rulează deloc (--ignore-scripts), din motive de siguranță.
FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci --omit=dev --workspace=server --ignore-scripts --no-audit --no-fund

# ---------------------------------------------------------------- 3. imaginea finală
FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    DATA_DIR=/data \
    WEB_DIST=/app/web/dist \
    INTEGRATIONS_DIR=/app/integrations \
    TZ=Europe/Bucharest
WORKDIR /app
RUN mkdir -p /data && chown node:node /data
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/web/dist ./web/dist
COPY server/package.json ./server/package.json
COPY package.json ./
COPY integrations ./integrations
USER node
VOLUME ["/data"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server/dist/index.js"]
