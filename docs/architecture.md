# Architecture

OpsPilot is a multi-tenant incident management platform with an AI copilot that
investigates incidents, cites its evidence, and proposes remediation that a
human approves before anything is executed.

This document describes the architecture and marks what exists today. The
system runs end to end: sign in, open an incident, investigate it with the
agent, approve a proposed action, and watch the timeline and audit log update
in real time.

## 1. System topology

```
                           Browser
                              │  HTTPS, single origin
                              │  "/"      → web
                              │  "/api/*" → api   (Next rewrite locally,
                              ▼                    ALB path routing in AWS)
 ┌─────────────────┐   REST + SSE    ┌───────────────────────────────────────┐
 │ web  (Next.js)  │ ──────────────▶ │ api  (Node, Fastify)                  │
 │ App Router,     │                 │  :4000 public  REST, SSE, auth, RBAC  │
 │ TanStack Query  │                 │  :4001 internal Tool Gateway (planned)│
 └─────────────────┘                 └───┬──────────────┬──────────────▲─────┘
                          SQL (RLS-scoped)│              │ enqueue,     │ read tools
                                         ▼              ▼ cache, rate  │ (delegation JWT)
                                ┌──────────────┐  ┌────────────────┐   │
                                │ PostgreSQL   │  │ Redis          │   │
                                │ source of    │  │ BullMQ queues  │   │
                                │ truth +      │  │ pub/sub fanout │   │
                                │ outbox       │  │ run streams    │   │
                                └──────▲───────┘  │ rate limits    │   │
                                       │          └──▲──────┬──────┘   │
                                       │  persist    │      │ jobs     │
                                       │  results    │      ▼          │
                                ┌──────┴─────────────┴───────────┐     │
                                │ worker (Node, BullMQ)          │     │
                                │  outbox relay, notifications,  │     │
                                │  ingestion/AI job orchestration│     │
                                └──────────────┬─────────────────┘     │
                                               │ internal HTTP         │
                                               ▼                       │
                                ┌───────────────────────────────┐      │
                                │ ai-service (Python, FastAPI)  │──────┘
                                │  LangGraph agent, RAG,        │
                                │  chunk/embed/rerank, evals    │── progress ─▶ Redis stream
                                └──────┬──────────────┬─────────┘
                                       ▼              ▼
                                   Qdrant        LLM provider
```

## 2. Services

| Service        | Responsibility                                                                                                                       | Why it is its own process                                                                                                                                                        |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **web**        | UI and session-aware routing. No business rules.                                                                                     | Different runtime and deploy cadence.                                                                                                                                            |
| **api**        | The only owner of domain writes, authentication, authorization and tenant isolation. Serves REST, SSE and the internal Tool Gateway. | Single authorization choke point. Stateless: sessions and pub/sub live in Redis.                                                                                                 |
| **worker**     | Background jobs, retries, dead-letter handling, outbox relay.                                                                        | Keeps slow or unreliable work off the request path and scales separately.                                                                                                        |
| **ai-service** | Chunking, embeddings, retrieval, reranking, LangGraph, LLM calls, evaluations.                                                       | The ML ecosystem (Pydantic, LangGraph, RAGAS, embedding runtimes) is a genuine reason for a second language. Stateless, and holds **no database credentials for domain tables**. |

Four deployables, each with a concrete justification. No further splitting is
planned; service boundaries follow failure domains and runtimes, not features.

## 3. Invariants

These are the rules the rest of the design depends on.

1. **The API is the only authorization authority.** The agent reads data through
   the API's Tool Gateway using a short-lived delegation token scoped to
   (user, organization, run). It cannot write domain data at all.
2. **PostgreSQL is the source of truth.** Qdrant and Redis are rebuildable:
   losing the vector index means re-indexing from `document_versions`.
3. **State change, timeline event, audit record and outbox event commit in one
   transaction.** A relay then publishes to Redis (real-time) and BullMQ
   (notifications), so an event cannot be lost between commit and publish.
4. **Tenant isolation has three layers:** repository functions require an
   organization id; PostgreSQL row-level security scopes every tenant table;
   composite foreign keys `(org_id, id)` make a cross-tenant reference
   impossible to store.
5. **Provenance ledger.** Every tool call and retrieved chunk gets an id. Every
   citation in an answer must reference an id from that run's ledger, checked in
   code rather than trusted from the model. Sources that were not inspected are
   reported as not inspected.

## 4. What exists today

| Capability                                                                                     | Where                                 | Status              |
| ---------------------------------------------------------------------------------------------- | ------------------------------------- | ------------------- |
| Fastify API: config validation, request ids, problem+json, security headers, graceful shutdown | `apps/api`                            | built               |
| Authentication: argon2id, opaque sessions, rate limiting keyed by IP and account               | `apps/api`                            | built               |
| Organizations, membership, 16-permission RBAC matrix                                           | `apps/api`                            | built               |
| Tenant isolation: path scoping, row-level security, composite foreign keys                     | `packages/database`                   | built               |
| Incidents, timeline events, append-only audit log, transactional outbox                        | `apps/api`                            | built               |
| Real-time: outbox relay → Redis → SSE fan-out → UI refresh                                     | `apps/worker`, `apps/api`, `apps/web` | built               |
| Knowledge base: versioned documents, chunking, dense + sparse indexing                         | `apps/ai-service`, `apps/worker`      | built               |
| Hybrid retrieval with RRF fusion and cross-encoder reranking                                   | `apps/ai-service`                     | built               |
| LLM provider abstraction (OpenAI-compatible + deterministic fake)                              | `apps/ai-service`                     | built               |
| LangGraph investigation agent with enforced provenance                                         | `apps/ai-service`                     | built               |
| Tool gateway: eight read-only tools, scoped delegation tokens                                  | `apps/api`                            | built               |
| Human approval: proposals, per-action permissions, execution, audit                            | `apps/api`                            | built               |
| Web: login, incident list and detail, AI panel, approvals, audit log                           | `apps/web`                            | built               |
| Retrieval evaluation harness with reproducible metrics                                         | `apps/ai-service`, `eval/`            | built               |
| MCP server exposing the read tools to general agents                                           | `apps/mcp`                            | built               |
| Docker Compose stack, seeded demo, CI (4 jobs)                                                 | repo                                  | built               |
| Notifications (email/webhook delivery)                                                         | —                                     | designed, not built |
| Generation-quality evaluation (judge model)                                                    | —                                     | designed, not built |
| Terraform / AWS deployment                                                                     | —                                     | designed, not built |

## 5. Request paths

### Domain mutation (planned, Phase 3)

```
PATCH /api/orgs/:org/incidents/:id   (If-Match: "7")
  api ─ tx{ UPDATE incidents ... version=8 WHERE version=7
            INSERT incident_events, audit_logs, outbox_events } ─ commit
  worker/outbox-relay
      ├─ PUBLISH redis org:{org}:incident:{id} → SSE fan-out to every connected client
      └─ BullMQ SEND_NOTIFICATION → in-app / email / webhook
```

Optimistic concurrency uses a `version` column with `If-Match`; a stale write
gets `412` rather than silently overwriting a colleague's change.

### AI investigation (planned, Phase 4+)

```
POST /api/orgs/:org/ai/investigations → 202 {runId, streamUrl}
  api: authorize, create ai_runs row, audit, enqueue
GET  .../ai/runs/:runId/stream (SSE, resumable via Last-Event-ID)
worker: mint delegation token → ai-service /internal/runs/{id}/execute
ai-service: LangGraph run, progress events → Redis stream, tool calls → api :4001
worker: persist result, telemetry, tool calls, action proposals, audit — one transaction
```

Running investigations through the worker means they survive client
disconnects, a second engineer can watch the same run, and worker concurrency
caps LLM spend.

## 6. Cross-cutting conventions

- **Errors**: RFC 9457 `application/problem+json` with a stable `code` and the
  `requestId`. Unexpected errors expose only the request ID; details go to logs.
- **Request IDs**: accepted from the caller when they match `^[\w.-]{1,128}$`
  (log-injection safe), otherwise generated. Echoed in responses and attached to
  every log line in all three services, so one investigation is traceable end to end.
- **Health**: liveness never touches dependencies, so a database outage does not
  restart every container. Readiness checks dependencies with a timeout and
  reports status without leaking failure detail.
- **Configuration**: validated at startup; error messages name variables but
  never echo values, because connection strings carry credentials.
- **Logging**: JSON by default. `LOG_PRETTY` is an explicit setting rather than
  derived from the environment name.

## 7. Data architecture

PostgreSQL holds every tenant-owned entity. The schema, index choices and the
privilege model are documented in [database.md](database.md).

Two database principals:

- the **migrator** owns every table (owners bypass row-level security, so the
  application must never connect as this role);
- **`app_rw`** is a no-login role holding data privileges only. The application's
  login user is a member of it and is created by infrastructure, which keeps
  passwords out of migrations.

## 8. Deployment

Local development is Docker Compose ([deployment.md](deployment.md)). The AWS
target is ECS Fargate for the four services, RDS for PostgreSQL, ElastiCache for
Redis, Qdrant on ECS with persistent storage, an ALB doing the `/` vs `/api`
split, Secrets Manager for credentials, and Terraform for all of it.

## 9. Decisions

Every significant choice is recorded as an ADR in
[decisions/](decisions/). Start with
[ADR-011](decisions/ADR-011-product-layer-vs-general-agent.md) for why this
system exists at all when a general-purpose agent can already read logs.
