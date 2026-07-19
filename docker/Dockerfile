# Multi-stage build. better-sqlite3 needs a compiler at install time; the final
# image carries only the built JS and production node_modules.
# Build context is the repo root (see docker/docker-compose.yml), so gateway
# sources are copied from gateway/.
FROM node:24-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY gateway/package.json gateway/package-lock.json* ./
RUN npm install
COPY gateway/tsconfig.json ./
COPY gateway/src ./src
RUN npm run build

FROM node:24-bookworm-slim AS deps
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY gateway/package.json gateway/package-lock.json* ./
RUN npm install --omit=dev

FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY gateway/package.json ./
# Buffer/subscriptions live here; mount a volume to persist across restarts.
RUN mkdir -p /app/data
ENV DB_PATH=/app/data/gateway.db
EXPOSE 8090
CMD ["node", "dist/index.js"]
