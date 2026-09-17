# SUP runs as a single long-lived process: one Fastify listener serves the REST
# API, the websocket hub and the built web client on one port. That is why it
# belongs on a container host (Railway, Render, Fly.io, a VM) rather than on a
# serverless platform — a function cannot hold the websocket open, and the
# event log's gap-free sequence depends on there being exactly one writer.

# ---- build ------------------------------------------------------------------
FROM node:22-bookworm-slim AS build
WORKDIR /app

# better-sqlite3 falls back to compiling from source when no prebuild matches
# the platform, so the toolchain has to exist in the build stage.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

# Manifests first: dependency installation is then cached independently of
# source edits, which is most of the build time.
COPY package.json package-lock.json .npmrc ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/
RUN npm ci

COPY . .
RUN npm run build && npm prune --omit=dev

# ---- runtime ----------------------------------------------------------------
# Same base as the build stage so the compiled native module stays ABI-correct.
FROM node:22-bookworm-slim AS runtime
WORKDIR /app/packages/server

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4000 \
    DATA_DIR=/data \
    SERVE_STATIC_DIR=/app/packages/web/dist

COPY --from=build /app/node_modules /app/node_modules
COPY --from=build /app/package.json /app/package.json
COPY --from=build /app/packages/shared/package.json /app/packages/shared/package.json
COPY --from=build /app/packages/shared/dist /app/packages/shared/dist
COPY --from=build /app/packages/server/package.json /app/packages/server/package.json
COPY --from=build /app/packages/server/dist /app/packages/server/dist
COPY --from=build /app/packages/web/dist /app/packages/web/dist

# SQLite needs a writable, persistent path. Mount a volume here — without one
# the database is recreated empty every time the container is replaced.
RUN mkdir -p /data && chown -R node:node /data
VOLUME ["/data"]

USER node
EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
