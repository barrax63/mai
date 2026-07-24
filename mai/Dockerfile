# syntax=docker/dockerfile:1

FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN --mount=type=cache,target=/root/.npm \
    if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app

# OCI Image Specification Labels
LABEL org.opencontainers.image.title="mai" \
      org.opencontainers.image.description="Mai - Discord cat-persona bot" \
      org.opencontainers.image.authors="barrax63 <barrax63@users.noreply.github.com>" \
      org.opencontainers.image.url="https://github.com/barrax63/mai" \
      org.opencontainers.image.source="https://github.com/barrax63/mai" \
      org.opencontainers.image.documentation="https://github.com/barrax63/mai/blob/main/README.md" \
      org.opencontainers.image.base.name="node:22-alpine"

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY scripts ./scripts

# Run as the unprivileged node user; works with read_only rootfs + cap_drop ALL.
USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/index.js"]
