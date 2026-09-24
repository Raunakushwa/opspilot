# OpsPilot

[![CI](https://github.com/Raunakushwa/opspilot/actions/workflows/ci.yml/badge.svg)](https://github.com/Raunakushwa/opspilot/actions/workflows/ci.yml)

Multi-tenant incident management and engineering collaboration platform with an
AI incident copilot: hybrid-search RAG over runbooks and postmortems, a LangGraph
investigation agent that cites its evidence, and human approval for every write action.

**It runs end to end:** sign in, open the seeded incident, investigate it with
the agent, watch progress stream in, approve a proposed action, and see the
timeline and audit log update live.

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

Open <http://localhost:3000> and sign in as **`ada@acme.test`** with
**`demo-password-1234`**.

The stack is `web`, `api`, `worker`, `ai-service`, `postgres`, `redis` and
`qdrant`, plus a one-shot `migrate` job that applies migrations, provisions the
application database role and seeds a demo organization before anything else
starts. If a port is taken, override it in `.env` (`POSTGRES_HOST_PORT`,
`API_HOST_PORT`, …). `make help` lists every target.

### Seeing a real investigation

The agent needs a model. Without a key it still runs — queueing, delegation,
tool calls, streaming, persistence and audit all work — but it cannot produce a
diagnosis, and the panel says so with zero confidence.

```bash
# Groq has a free tier; any OpenAI-compatible endpoint or local Ollama works.
echo 'LLM_API_KEY=your-key-here' >> .env
sed -i 's/^LLM_PROVIDER=.*/LLM_PROVIDER=openai-compatible/' .env
docker compose up -d ai-service
```

Then open **INC-21 — payment-service returning 5xx on card authorisation** and
press **Investigate with AI**.

### The demo scenario

The seed is designed to be solvable from evidence rather than from a story:

| Evidence                                            | What it shows                                             |
| --------------------------------------------------- | --------------------------------------------------------- |
| Deployment `v2026.9.20-1`, six minutes before onset | reduced the database connection pool from 40 to 8 per pod |
| `error_rate` metric                                 | flat at 0.2%, then climbing to 12% after that deploy      |
| Log pattern                                         | `timeout acquiring connection from pool (pool=8/8 busy)`  |
| Postmortem INC-88                                   | the same failure mode, three months earlier               |
| Runbook                                             | the rollback procedure for payment-service                |

A good investigation connects the deploy to the error pattern, cites the
postmortem, and proposes a rollback — which an **admin** must approve before
anything is recorded as executed.

### Demo accounts

All use `demo-password-1234`:

| Account           | Role     | Can                                                   |
| ----------------- | -------- | ----------------------------------------------------- |
| `ada@acme.test`   | OWNER    | everything, including approving a rollback            |
| `ravi@acme.test`  | ADMIN    | approve operational actions, read the audit log       |
| `grace@acme.test` | ENGINEER | investigate, edit incidents, approve low-risk actions |
| `noor@acme.test`  | VIEWER   | read only                                             |

Signing in as `grace@` and trying to approve a rollback is the fastest way to
see the authorization model do something.

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

## What is built

Authentication and RBAC · multi-tenant isolation in three layers · incidents
with timeline and append-only audit · transactional outbox and real-time SSE ·
versioned knowledge base with hybrid retrieval and reranking · a LangGraph
agent whose citations are enforced in code · human approval for every write ·
a retrieval evaluation harness · an MCP server · Docker Compose, seeded demo
and CI.

**Not built yet:** notification delivery (email/webhooks), generation-quality
evaluation with a judge model, and Terraform/AWS deployment. The
[security](docs/security.md) and [interview notes](docs/interview-notes.md)
pages list the gaps and what is deliberately not claimed.

## Using OpsPilot from another agent

`apps/mcp` exposes the read tools over MCP, so a general-purpose agent can ask
OpsPilot about incidents and get a permission-checked, cited answer:

```json
{
  "mcpServers": {
    "opspilot": {
      "command": "node",
      "args": ["apps/mcp/dist/server.js"],
      "env": {
        "OPSPILOT_URL": "http://localhost:4000",
        "OPSPILOT_EMAIL": "ada@acme.test",
        "OPSPILOT_PASSWORD": "demo-password-1234"
      }
    }
  }
}
```

It signs in as a real user, so it can never see more than that person can.

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
