# ============================================================================
# Dockerfile — agents (multi-agent AI orchestration platform)
# Multi-stage build: compile TypeScript, then run in slim image
# ============================================================================

# ---------------------------------------------------------------------------
# Stage 1: Build (TypeScript → JavaScript)
# ---------------------------------------------------------------------------
FROM node:20-bookworm-slim AS builder
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY agents ./agents
RUN npm run build

# ---------------------------------------------------------------------------
# Stage 2: Production image
# ---------------------------------------------------------------------------
FROM node:20-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*

RUN addgroup --system agents \
    && adduser --system --ingroup agents agents

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=builder /app/dist ./dist
COPY src/db/migrations ./src/db/migrations
COPY personas ./personas
COPY config ./config

USER agents

ENV NODE_ENV=production
EXPOSE 9000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD curl -f http://localhost:9000/health || exit 1

CMD ["node", "dist/src/index.js"]
