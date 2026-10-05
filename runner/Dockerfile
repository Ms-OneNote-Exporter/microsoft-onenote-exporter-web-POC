# Runner image: the sidecar plus the three unmodified @msout packages.
#
# Built from the monorepo root (see compose.yaml) so the workspace and its
# lockfile are available. Nothing from the @msout packages is patched or copied:
# they are installed from npm at the exact versions in runner/package.json, which
# is what makes "we did not modify them" checkable rather than a promise.
FROM node:24.21.0-bookworm-slim

# ca-certificates for TLS to Microsoft; tini is NOT installed because compose
# runs the container with `init: true`, which gives us a real PID 1 that reaps
# Chromium's zombies.
#
# zip is deliberately absent: the artifact is streamed by archiver, so there is
# no second copy of a multi-gigabyte notebook on disk.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /srv

# Dependency manifests first, so editing source does not invalidate the expensive
# npm layer. The lockfile is committed, so `npm ci` fails loudly rather than
# quietly resolving different versions inside the image than on the host.
COPY package.json package-lock.json ./
COPY shared/package.json ./shared/
COPY runner/package.json ./runner/
COPY app/package.json ./app/

# Dev dependencies are needed *here*: this is a build stage, and the TypeScript
# and Vite that produce dist/ are devDependencies. They are pruned below, once
# the compiled output exists.
RUN npm ci

# Chromium's shared libraries (fonts, shared objects). Needs root for apt.
RUN npx playwright install-deps chromium

COPY shared/ ./shared/
COPY runner/ ./runner/

# Build the shared package and the runner from source. tsconfig emits to dist/,
# and the sidecar runs `node runner/dist/index.js`.
RUN npm run build -w @msout-poc/shared && npm run build -w @msout-poc/runner

# The build tools are no longer needed and are not small. Pruning here rather
# than copying node_modules from a host keeps the image to what it runs on.
RUN npm prune --omit=dev

# Browser binaries installed as the unprivileged `node` user, so the cache lives
# in that user's HOME and stays writable after privileges are dropped. Baked into
# the image rather than downloaded at boot: a container that needs to reach the
# internet to start is a container that fails in exactly the situation you need
# it.
USER node
ENV PLAYWRIGHT_BROWSERS_PATH=/home/node/.cache/ms-playwright
RUN npx playwright install chromium

# The data root is a bind mount from the host. Pre-creating it as node-owned means
# a session directory can be created on first use even if compose created the
# mount point as root.
USER root
RUN mkdir -p /data && chown node:node /data
USER node

# The sidecar is the process that receives passwords and holds auth.json. It binds
# a port for the app to call, and compose never publishes it to the host.
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# The Chromium renderer sandbox is NOT disabled. It requires unprivileged user
# namespaces on the host:
#   sysctl kernel.unprivileged_userns_clone=1
#   sysctl kernel.apparmor_restrict_unprivileged_userns=0
# PLANNING/PLAN-v3(POC).md §18. CHROMIUM_NO_SANDBOX exists for a host that
# cannot provide them, and setting it weakens isolation - never the default.
CMD ["node", "runner/dist/index.js"]