# The registry: Node 24 and its built-in modules only. There is no npm install.
FROM node:24.18.1-alpine3.24@sha256:f70403e87646dc51b45295f4b8b70cdad0b63d2297c4c9899119b03f7af7a6b3

# qrencode draws the invite QR code in the terminal for ./t3x invite.
RUN apk add --no-cache libqrencode-tools \
 && mkdir /data \
 && chown node:node /data

WORKDIR /app
COPY --chown=root:root server.mjs db.mjs proof.mjs invites.mjs subdomain.mjs ratelimit.mjs plugin.mjs ask.mjs healthcheck.mjs cli.mjs ./

USER node
VOLUME /data
ENV T3X_DB_PATH=/data/registry.db
CMD ["node", "/app/server.mjs"]
