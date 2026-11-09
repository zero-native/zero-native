# zn-updates image. Build from the zero-native repo root (the server shares code with tools/ota):
#   docker build -f server/Dockerfile -t zn-updates .
# Only the files below go into the image (server/Dockerfile.dockerignore keeps the context small).
FROM oven/bun:1.3.2-slim

WORKDIR /app

# The server's dependencies at the top, so server/ and tools/ both find them.
COPY server/package.json ./package.json
RUN bun install --production

COPY tools/bundle-info.ts ./tools/bundle-info.ts
COPY tools/ota ./tools/ota
COPY tools/updates ./tools/updates
COPY server/src ./server/src
COPY server/web ./server/web
COPY server/tsconfig.json ./server/tsconfig.json

ENV NODE_ENV=production
ENV PORT=3000
ENV CACHE_DIR=/tmp/zn-updates-cache
EXPOSE 3000
USER bun
CMD ["bun", "run", "server/src/index.ts"]
