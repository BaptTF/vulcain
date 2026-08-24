FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json* ./
COPY server/package.json server/
COPY web/package.json web/
COPY pi-ext/package.json pi-ext/
RUN npm install --no-audit --no-fund
COPY . .
RUN npm run build


FROM node:22-slim AS runtime
WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends git bash ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*

ENV PI_CODING_AGENT_DIR=/data/.pi
ENV VULCAIN_HOME=/data/.vulcain
ENV VULCAIN_WORKSPACES=/data/workspaces
ENV VULCAIN_HOST=0.0.0.0
ENV PI_SKIP_VERSION_CHECK=1

RUN npm install -g --ignore-scripts @earendil-works/pi-coding-agent pi-acp \
  && npm cache clean --force

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/web/dist ./web/dist
COPY --from=build /app/pi-ext/dist ./pi-ext/dist
COPY --from=build /app/scripts ./scripts
COPY --from=build /app/package.json ./package.json

VOLUME ["/data/workspaces", "/data/.vulcain", "/data/.pi"]

EXPOSE 7331

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD curl -sf http://127.0.0.1:7331/api/meta || exit 1

CMD ["sh", "-c", "node scripts/bootstrap.mjs && node server/dist/index.js"]
