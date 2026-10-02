# App image: the Fastify server plus the built React bundle.
#
# This container never holds a password in a parsed field. It proxies the
# browser's credential bytes to the runner untouched, which is a property of the
# code (no JSON parser on that route) rather than of this Dockerfile - but it is
# also why the app has no dependency that would tempt someone to add one.
FROM node:24.21.0-bookworm-slim

# ca-certificates only. The app makes outbound requests to the runner over plain
# HTTP on the compose network; it needs no TLS stack of its own.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /srv

# Manifests first so editing source does not invalidate the npm layer. The
# lockfile is committed, so `npm ci` fails rather than resolving something else
# inside the image than on the host.
COPY package.json package-lock.json ./
COPY shared/package.json ./shared/
COPY runner/package.json ./runner/
COPY app/package.json ./app/

# --omit=dev: the image runs compiled output. Playwright and the @msout packages
# come along as transitive dependencies of the runner workspace, because npm
# hoists workspaces into one tree; only the runner ever requires them.
RUN npm ci --omit=dev

COPY shared/ ./shared/
COPY app/ ./app/

# shared first: the app's TypeScript build consumes its emitted types.
RUN npm run build -w @msout-poc/shared \
 && npm run build:server -w @msout-poc/app \
 && npm run build:web -w @msout-poc/app

# The data root is a bind mount from the host; pre-creating it as node-owned lets
# a session directory be created on first use even when compose created the mount
# point as root.
RUN mkdir -p /data && chown node:node /data
USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "app/dist/server/index.js"]