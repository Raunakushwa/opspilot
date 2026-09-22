# Deployment

## Local

```bash
make setup                 # install dependencies, create .env
docker compose up --build  # or: make dev
```

Seven services plus a one-shot `migrate` job:

| Service    | Port | Notes                                                                                                          |
| ---------- | ---- | -------------------------------------------------------------------------------------------------------------- |
| web        | 3000 | Next.js standalone build; proxies `/api` to the API                                                            |
| api        | 4000 | waits for PostgreSQL, Redis and a successful `migrate`                                                         |
| worker     | 4100 | waits for Redis and `migrate`                                                                                  |
| ai-service | 8000 | waits for Qdrant                                                                                               |
| postgres   | 5432 | healthchecked                                                                                                  |
| redis      | 6379 | healthchecked, append-only enabled                                                                             |
| qdrant     | 6333 | no healthcheck — the image has no shell or HTTP client, so the AI service's `/readyz` reports its availability |

Host ports are configurable (`POSTGRES_HOST_PORT`, `API_HOST_PORT`, …) because a
developer may already run PostgreSQL locally. Required secrets use `${VAR:?}`,
so a missing value fails immediately with a readable message.

Optional profiles: `--profile ollama` for a local model provider.

### Image construction

`turbo prune --docker` isolates each app's workspace subset so a change in
`apps/web` does not invalidate the API image cache. Manifests are installed
before sources, so dependency layers survive code changes. Runtime stages
re-install production dependencies only, run as non-root users and use
`dumb-init` so `SIGTERM` reaches the process and graceful shutdown runs.

**`API_ORIGIN` is a build-time value for the web image**: Next bakes rewrite
destinations into the build. Turborepo's filtered task environment must declare
it (`turbo.json` → `tasks.build.env`), otherwise the build silently falls back
to the default origin and only fails at runtime.

## CI

`.github/workflows/ci.yml` runs four jobs in parallel: Node (format, lint,
typecheck, unit, build), Python (ruff, mypy --strict, pytest), integration
(Testcontainers against real PostgreSQL and Redis), and a full-stack smoke test
that builds every image, starts the Compose stack, probes each service including
the web→api proxy, and asserts the application database role has neither
`SUPERUSER` nor `BYPASSRLS`.

## AWS (planned, Phase 8)

| Component                    | Service                                                             |
| ---------------------------- | ------------------------------------------------------------------- |
| web, api, worker, ai-service | ECS Fargate, one task definition each                               |
| PostgreSQL                   | RDS, Multi-AZ; the application connects as a non-owner role         |
| Redis                        | ElastiCache (Valkey-compatible)                                     |
| Qdrant                       | ECS task with persistent storage, or Qdrant Cloud                   |
| Routing                      | ALB: `/` → web, `/api/*` → api; HTTP/2 for SSE                      |
| Secrets                      | Secrets Manager, injected as task secrets — never baked into images |
| Images                       | ECR, built in CI                                                    |
| Observability                | CloudWatch logs and metrics; JSON logs already carry request IDs    |
| Infrastructure as code       | Terraform under `infra/terraform`                                   |

For the portfolio demo the running deployment is a single small VM with Docker
Compose and a scheduled seed reset. The Terraform is written and validated with
`terraform plan` rather than kept permanently running, because a managed stack
costs real money to leave up. This document will say plainly which of the two is
live at any time.
