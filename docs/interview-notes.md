# Interview notes

Trade-offs, failure modes and things that went wrong. Kept as the project is
built, so the reasoning is recorded while it is fresh rather than reconstructed
afterwards.

## The question to answer first

**"Why build this when a general agent with MCP connectors can already read our
logs?"** — see [ADR-011](decisions/ADR-011-product-layer-vs-general-agent.md).
Short version: the investigation is not the differentiator; shared state,
organization-level authorization, approval, audit, retrieval over the
organization's own history, and measurable answer quality are. For one engineer
asking ad-hoc questions, a general agent is often enough, and saying so is more
convincing than pretending otherwise.

## Decisions I expect to be challenged

| Challenge                                         | Answer                                                                                                                                                                                                                       |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "Why not pgvector instead of a second datastore?" | At this scale it would be enough, and I say so in ADR-004. Qdrant buys native sparse+dense hybrid with tenant-filtered search, and keeps retrieval load off the OLTP database.                                               |
| "Why sessions instead of JWT?"                    | Revocation. A stolen access token stays valid until expiry unless you keep a deny-list — which is a session store with extra steps (ADR-008). JWTs are still used where they fit: short-lived service-to-service delegation. |
| "Why a Python service at all?"                    | LangGraph, Pydantic, RAGAS and embedding runtimes. It is stateless and has no database credentials for domain tables, so the boundary is narrow and justified.                                                               |
| "Isn't the outbox over-engineering?"              | It is the difference between "the incident changed and nobody was told" being impossible versus merely unlikely. It is ~40 lines in the worker.                                                                              |
| "Why can't the agent just roll back?"             | Because a confident paragraph, a poisoned runbook or an injected document would be enough to trigger it. Proposals as data (ADR-007) keep every dangerous verb owned by the API and executed as the approver.                |

## Failure modes I have thought about

- **Cross-tenant leak from a forgotten `WHERE`** — three layers (ADR-009); the
  forgotten filter returns no rows rather than someone else's.
- **Lost real-time event on crash between commit and publish** — transactional
  outbox (ADR-002).
- **Duplicate side effects from at-least-once delivery** — idempotent job IDs;
  deterministic Qdrant point IDs derived from document version and chunk index.
- **Prompt injection via a retrieved runbook** — retrieved text is data, the
  agent has no write tools, and citations are validated against the run ledger.
- **Runaway model cost** — investigations run through the worker, so concurrency
  bounds spend; per-organization budgets and token tracking are planned.
- **A migration blocking production** — `lock_timeout` makes it fail instead of
  queueing behind a long query while blocking the table.

## Things that actually broke during Phase 1

Worth telling, because they are the kind of bug that does not show up in a demo.

1. **Every API request deadlocked.** An `onRequest` hook did
   `await reply.header(...)`. Fastify's reply is _thenable_ and settles only
   once the response is sent, so each request waited on itself. All 15 HTTP
   tests timed out; confirmed in Fastify's source.
2. **The web image proxied to the wrong host.** Turborepo runs tasks with a
   filtered environment, so `API_ORIGIN` was dropped during `next build` and
   Next silently used its default. It built cleanly and failed only at runtime.
   Same class of bug had already appeared with `TESTCONTAINERS_*` in the
   database package.
3. **The API crash-looped in Docker** because pretty log formatting was derived
   from `NODE_ENV`, and the pretty-printer is a dev dependency absent from the
   runtime image. Log _format_ is now an explicit setting.
4. **`pnpm prune --prod` removed workspace symlinks**, not just dev
   dependencies, leaving a runtime tree that could not resolve its own packages.
5. **Pydantic leaked a secret into a crash log.** `ValidationError` repeats the
   offending input, so a malformed `QDRANT_URL` would print credentials at
   startup in every environment. Caught by a test written specifically to assert
   that no value appears in a configuration error.
6. **DO blocks cannot take bind parameters**, so the first role-provisioning
   implementation failed. PostgreSQL now builds the statement with
   `format('%I','%L')` — quoting is the database's job.

## Testing philosophy

- Unit tests use injected fakes; integration tests use real PostgreSQL and Redis
  through Testcontainers. There are no mocks of the database.
- Where a test protects a subtle mechanism, the mechanism was removed to confirm
  the test fails: without the migration advisory lock, concurrent runners failed
  3/3 runs; without dead-letter recording, exactly the three dead-letter tests
  failed. A test that has never failed has not been shown to work.
- CI ends with a full-stack smoke test, because the failures that reach
  production are usually wiring failures, not logic failures.

## What I would do differently at 100× scale

- Partition `log_entries` and `metric_points` by time, and move them out of
  PostgreSQL to a purpose-built store behind the existing adapters (ADR-010).
- Replace the polling relay with logical replication (or a CDC pipeline) if
  outbox latency ever matters.
- Split the AI service into "retrieval" and "agent execution" once their scaling
  profiles diverge — retrieval is memory-bound, agent runs are latency-bound.
- Move session lookup to a signed token with a short TTL plus a revocation
  channel, if session lookups ever became the bottleneck — measured, not assumed.

## What is not claimed

No load testing has been done, so no throughput or latency numbers are quoted.
No RAG benchmark numbers exist until the evaluation harness runs (Phase 6), and
they will be reported with the model, dataset and commit that produced them.
The logs, metrics and deployments the copilot inspects are seeded tables, not a
live observability stack (ADR-010).
