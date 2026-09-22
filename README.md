# OpsPilot

[![CI](https://github.com/Raunakushwa/opspilot/actions/workflows/ci.yml/badge.svg)](https://github.com/Raunakushwa/opspilot/actions/workflows/ci.yml)

Multi-tenant incident management and engineering collaboration platform with an
AI incident copilot: hybrid-search RAG over runbooks and postmortems, a LangGraph
investigation agent that cites its evidence, and human approval for every write action.

> **Status:** Phase 1 (repository foundation) in progress. Nothing below the
> "Repository layout" section is implemented yet — see [Roadmap](#roadmap).

## Architecture at a glance

```
web (Next.js) ──REST+SSE──▶ api (Fastify) ──▶ PostgreSQL (source of truth, RLS)
                               │  ▲               Redis (queues, pub/sub, cache)
                               │  └── internal Tool Gateway ◀─┐
                               ▼                              │ read tools (delegation token)
                          worker (BullMQ) ──▶ ai-service (FastAPI + LangGraph) ──▶ Qdrant, LLM
```

- The **api** is the only authorization authority and the only writer of domain data.
- The **ai-service** has no database credentials; the agent reads through the api's
  Tool Gateway and can only _propose_ write actions, which a human approves.
- Every domain change writes state, timeline event, audit log and an outbox event in
  one transaction; the worker relays the outbox to real-time clients and notifications.

Full design: [docs/architecture.md](docs/architecture.md). Every significant
choice is recorded as an [ADR](docs/decisions/) — including
[why this exists at all](docs/decisions/ADR-011-product-layer-vs-general-agent.md)
when a general-purpose agent can already read logs.

## Repository layout

```
apps/        web · api · worker · ai-service
packages/    config (lint/ts/prettier presets) · contracts · shared · database · ui
infra/       docker · terraform
docs/        architecture, ADRs, interview notes
eval/        RAG evaluation datasets
```

## Quick start

```bash
make setup                 # install dependencies, create .env from the template
docker compose up --build  # or: make dev
```

Then open <http://localhost:3000>. The stack is `web`, `api`, `worker`,
`ai-service`, `postgres`, `redis` and `qdrant`, plus a one-shot `migrate`
job that applies migrations and provisions the application database role
before the API and worker start.

If a port is already taken, override it in `.env`
(`POSTGRES_HOST_PORT`, `API_HOST_PORT`, …).

Run `make help` for the full list of targets.

## Prerequisites

- Node.js 24 (`.nvmrc`) and pnpm 11
- Python 3.12+ and [uv](https://docs.astral.sh/uv/)
- Docker with Compose v2

## Common commands

| Command             | What it does                   |
| ------------------- | ------------------------------ |
| `pnpm install`      | Install workspace dependencies |
| `pnpm lint`         | ESLint across all packages     |
| `pnpm typecheck`    | TypeScript project checks      |
| `pnpm test`         | Unit tests                     |
| `pnpm format:check` | Prettier check                 |

Equivalent `make` targets exist for each (`make lint`, `make test`, …).

## Troubleshooting

**Integration tests fail with `Log stream ended and message "/.*Started.*/" was not received`.**
Testcontainers' cleanup container (Ryuk) cannot reach the Docker socket, which is
common on SELinux hosts. Run with `TESTCONTAINERS_RYUK_PRIVILEGED=true`. Prefer this
over `TESTCONTAINERS_RYUK_DISABLED=true`, which leaks containers when a test run is killed.

## Roadmap

1. Foundation — monorepo, Docker Compose, Postgres, Redis, CI ← _current_
2. Auth, organizations, RBAC, schema
3. Incidents, comments, timeline, audit log
4. **Thin vertical slice** of the demo scenario end to end (investigate → cite → propose rollback → approve → audit)
5. Real-time, notifications, workers
6. Knowledge base ingestion, hybrid search, reranking, RAG evaluation
7. Full LangGraph workflow, guardrails, observability, cost tracking
8. MCP server, hardening, Terraform/AWS, deployment

## Documentation

| Document                                      | Contents                                                 |
| --------------------------------------------- | -------------------------------------------------------- |
| [architecture.md](docs/architecture.md)       | Topology, service boundaries, invariants, current status |
| [database.md](docs/database.md)               | Privilege model, migrations, schema and index strategy   |
| [deployment.md](docs/deployment.md)           | Local stack, images, CI, AWS target                      |
| [security.md](docs/security.md)               | Implemented controls, phase plan, known gaps             |
| [interview-notes.md](docs/interview-notes.md) | Trade-offs, failure modes, what is not claimed           |
| [decisions/](docs/decisions/)                 | Architecture Decision Records                            |

## License

[MIT](LICENSE)
