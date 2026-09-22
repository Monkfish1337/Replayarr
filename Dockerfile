# syntax=docker/dockerfile:1.6
# No npm dependencies, so there is no build stage: the runtime is Node and
# the source.
FROM node:24-alpine

# tini reaps zombies and forwards SIGTERM so the worker stops cleanly.
RUN apk add --no-cache tini wget

WORKDIR /app
COPY package.json server.js ./
COPY src ./src
COPY public ./public

# /config holds the SQLite database. It is owned by the image's node user
# (uid 1000), which a fresh named volume inherits.
RUN mkdir -p /config && chown node:node /config
VOLUME ["/config"]

USER node

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4173 \
    REPLAYARR_DB=/config/replayarr.db

EXPOSE 4173

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://127.0.0.1:4173/health >/dev/null || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server.js"]
