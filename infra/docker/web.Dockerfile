# Next.js standalone output: the runtime image carries only the server bundle
# and its traced dependencies.
ARG NODE_VERSION=24.13.0

FROM node:${NODE_VERSION}-alpine AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN npm install --global pnpm@11.9.0
WORKDIR /repo

FROM base AS pruner
COPY . .
RUN pnpm dlx turbo@2.11.2 prune "@opspilot/web" --docker

FROM base AS builder
# Next bakes rewrite destinations into the build, so the API origin is a
# build-time argument here. In production the load balancer routes /api instead.
ARG API_ORIGIN=http://api:4000
ENV API_ORIGIN=${API_ORIGIN}
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=pruner /repo/out/json/ .
RUN pnpm install --frozen-lockfile
COPY --from=pruner /repo/out/full/ .
RUN pnpm turbo run build --filter="@opspilot/web"

FROM node:${NODE_VERSION}-alpine AS runtime
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
RUN apk add --no-cache dumb-init
WORKDIR /app
COPY --from=builder --chown=node:node /repo/apps/web/.next/standalone ./
COPY --from=builder --chown=node:node /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=builder --chown=node:node /repo/apps/web/public ./apps/web/public
USER node
ENV PORT=3000 HOSTNAME=0.0.0.0
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "apps/web/server.js"]
