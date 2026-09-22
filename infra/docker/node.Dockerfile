# Shared image for the Node services (api, worker).
# `turbo prune` isolates one app plus its workspace dependencies, so a change in
# apps/web does not invalidate the api image cache.
ARG NODE_VERSION=24.13.0
# APP is the workspace package name suffix (api, worker, database); PKG_DIR is
# where it lives, so the same file builds apps and package-based one-shot jobs.
ARG APP
ARG PKG_DIR=apps/${APP}
# Entry point differs per service (api: server.js, worker: main.js).
ARG ENTRY=dist/server.js

FROM node:${NODE_VERSION}-alpine AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN npm install --global pnpm@11.9.0
WORKDIR /repo

FROM base AS pruner
ARG APP
COPY . .
RUN pnpm dlx turbo@2.11.2 prune "@opspilot/${APP}" --docker

FROM base AS builder
ARG APP
# Lockfile + manifests first: dependency layers survive source-only changes.
COPY --from=pruner /repo/out/json/ .
RUN pnpm install --frozen-lockfile
COPY --from=pruner /repo/out/full/ .
RUN pnpm turbo run build --filter="@opspilot/${APP}"
# Re-link production dependencies only. `pnpm prune` removes the workspace
# symlinks along with the dev dependencies, so a second install is used instead.
RUN CI=true pnpm install --frozen-lockfile --prod --ignore-scripts

FROM node:${NODE_VERSION}-alpine AS runtime
ARG APP
ENV NODE_ENV=production
# dumb-init reaps zombies and forwards SIGTERM, which the graceful shutdown needs.
RUN apk add --no-cache dumb-init
WORKDIR /repo
COPY --from=builder --chown=node:node /repo .
USER node
ARG PKG_DIR
WORKDIR /repo/${PKG_DIR}
ARG ENTRY
ENV ENTRY=${ENTRY}
ENTRYPOINT ["dumb-init", "--"]
CMD ["sh", "-c", "exec node $ENTRY"]
