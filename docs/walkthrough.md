# Explaining OpsPilot

Everything you need to talk through this system: what it does, what it is made
of, what was deliberately left out, and exactly what happens when the demo
runs. Read this with [interview-notes.md](interview-notes.md) (the arguments
and the bugs) and the [ADRs](decisions/) (the decisions in full).

---

## 1. The sixty-second version

> OpsPilot is a multi-tenant incident management platform with an AI copilot.
> An engineer opens an incident and asks why a service is failing; the agent
> plans an investigation, reads deployments, logs, metrics and the
> organization's own runbooks and postmortems, and answers with citations to
> the things it actually read. If action is warranted it _proposes_ it — a
> human with the right role approves, and only then does anything execute,
> with an audit record.
>
> The interesting part is not the model call. It is that the agent has no
> write access at all, cannot cite a source it did not read, and cannot see
> another tenant's data — and each of those is enforced by code and by the
> database, not by a prompt.

If you only remember three things: **provenance is enforced in code**,
**the agent proposes and a human approves**, **tenant isolation has three
independent layers**.

---

## 2. What each service is and why it exists

| Service      | Language         | Responsibility                                                          | Why it is separate                                         |
| ------------ | ---------------- | ----------------------------------------------------------------------- | ---------------------------------------------------------- |
| `web`        | Next.js / React  | UI only, no business rules                                              | Different runtime and deploy cadence                       |
| `api`        | Node / Fastify   | The only writer of domain data; auth, RBAC, tenancy, SSE, tool gateway  | One authorization choke point                              |
| `worker`     | Node / BullMQ    | Background jobs, retries, dead letters, outbox relay                    | Keeps slow and unreliable work off the request path        |
| `ai-service` | Python / FastAPI | Chunking, embeddings, retrieval, reranking, LangGraph, LLM calls, evals | The ML ecosystem is a genuine reason for a second language |

Four processes, each with a concrete reason. **Not microservices for their own
sake** — the boundaries follow failure domains and runtimes. Be ready to say
that: "I could have built this as one Node process plus a Python sidecar; the
worker is separate because a slow embedding job must not block a request, and
the AI service is separate because LangGraph, Pydantic and the embedding
runtimes are Python."

---

## 3. Every technology, and why it is there

### Backend (Node)

| Choice                           | Why                                                                                                         | What I considered instead                                                 |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| **Fastify**                      | Fast, schema-first, good plugin model, clean hooks                                                          | Express — larger ecosystem, slower, weaker typing                         |
| **Drizzle**                      | SQL stays visible; RLS needs `SET LOCAL` per transaction, composite FKs, generated columns, partial indexes | Prisma — more mature, but fights every one of those (ADR-001)             |
| **PostgreSQL**                   | Relational domain, row-level security, full-text search, JSON where useful                                  | MySQL (no RLS), a document store (the domain _is_ relational)             |
| **Redis + BullMQ**               | Queues, pub/sub, rate limits, run streams in one dependency                                                 | SQS (nothing to run locally), Postgres-as-queue (Redis was needed anyway) |
| **argon2id** (`@node-rs/argon2`) | Memory-hard, the current recommendation                                                                     | bcrypt — fine, but weaker against GPU attack                              |
| **jose**                         | Signs the short-lived delegation tokens                                                                     | jsonwebtoken — older API, less strict                                     |
| **Zod**                          | One schema validates input _and_ produces the type                                                          | Hand-written validators, class-validator                                  |
| **UUIDv7**                       | Time-ordered, index-friendly, usable as a pagination cursor                                                 | UUIDv4 (scatters in the index), bigserial (leaks volume)                  |

### Frontend

| Choice                 | Why                                                                                      |
| ---------------------- | ---------------------------------------------------------------------------------------- |
| **Next.js App Router** | One origin serves the UI and proxies `/api`, so session cookies stay same-origin         |
| **TanStack Query**     | Server state with caching and invalidation; events invalidate queries instead of polling |
| **Zustand**            | One small piece of genuine client state (the active organization)                        |
| **Tailwind v4**        | Design tokens in CSS, no separate config file                                            |

### AI

| Choice                     | Why                                                           | Instead of                                                                                      |
| -------------------------- | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| **Qdrant**                 | Dense **and** sparse vectors, tenant payload index, filtering | pgvector — enough at this scale, but hybrid would span two engines (ADR-004)                    |
| **fastembed** (ONNX)       | CPU embeddings and reranking in a few hundred MB              | sentence-transformers — multi-GB torch image                                                    |
| **LangGraph**              | Explicit state, conditional routing, testable nodes           | A hand-rolled loop (fine, less auditable); a free-form ReAct agent (hard to prove what it read) |
| **Pydantic**               | Structured output that is validated, not parsed by hope       | Regex/JSON.parse over free text                                                                 |
| **OpenAI-compatible HTTP** | Groq, OpenAI, vLLM and Ollama all speak it                    | A vendor SDK per provider (ADR-006)                                                             |
| **structlog**              | JSON logs with a request id, matching the Node services       | stdlib logging                                                                                  |

### Infrastructure

Docker Compose (7 services, one command), GitHub Actions (4 parallel jobs
including a full-stack smoke test), Testcontainers (real Postgres/Redis/Qdrant
in tests — **no database mocks anywhere**), pnpm + Turborepo, uv for Python.

---

## 4. What is deliberately **not** used

This list is as interesting as the one above. Each is a decision, not an
oversight.

| Not used                              | Why not                                                                                                                               |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| **WebSockets**                        | Traffic is almost entirely server→client. SSE gives auto-reconnect and event replay over plain HTTP (ADR-003)                         |
| **Kafka**                             | A transactional outbox plus Redis covers the need; Kafka would be infrastructure without a problem                                    |
| **Prisma**                            | Row-level security, composite foreign keys and generated columns are exactly where it fights back (ADR-001)                           |
| **JWT for user sessions**             | Revocation. A stolen token stays valid until expiry unless you keep a deny-list — which is a session store with extra steps (ADR-008) |
| **LangChain chains**                  | The framework would own the request shape, which is where structured output and observability need control                            |
| **Vector-only RAG**                   | Measured: vector-only _misses_ a document that hybrid finds, for a near-exact token match (see [rag.md](rag.md))                      |
| **An LLM judging its own citations**  | The ledger check is code. Asking a model whether it told the truth is not a control                                                   |
| **Write tools for the agent**         | Every dangerous verb is a capability the API owns (ADR-007)                                                                           |
| **Auto-execution on high confidence** | Confidence is not permission                                                                                                          |
| **A separate notifications service**  | It would be a microservice with no independent reason to exist                                                                        |
| **Mocked databases in tests**         | Integration tests use real Postgres, Redis and Qdrant; the bugs that matter live in the wiring                                        |

---

## 5. What happens when you press "Investigate with AI"

Narrate this and you have described the whole system.

```
 1. Browser  POST /api/orgs/:org/ai/investigations
 2. api      session cookie → user; membership → role; requirePermission('ai:investigate')
 3. api      tx { INSERT ai_runs, incident_event, audit_log }  ← one transaction
 4. api      enqueue BullMQ job (jobId = run id, so a duplicate cannot double-charge)
 5. api      202 { runId, streamUrl }
 6. Browser  EventSource → GET /ai/runs/:id/stream   (membership checked before it opens)
 7. worker   picks up the job, marks the run RUNNING
 8. worker   mints a delegation token: (user, org, run), read-only, expires in minutes
 9. worker   POST ai-service /internal/investigations/run
10. agent    UnderstandIncident → PlanInvestigation (structured plan from the LLM)
11. agent    runs ONLY the planned tools, concurrently:
               · search_documents  → Qdrant hybrid search (dense + sparse → RRF → rerank)
               · get_deployments / get_log_patterns / get_metrics
                   → api :4001 tool gateway → re-reads membership → RLS-scoped SQL
12. agent    every call and chunk enters the provenance ledger with an id
13. agent    SynthesizeEvidence → structured InvestigationResult (Pydantic-validated)
14. agent    ReviewAnswer → enforce_provenance() deletes any citation not in the ledger,
               caps confidence, withdraws unsupported proposals
15. agent    progress events → Redis stream → api → SSE → the browser's panel
16. worker   tx { ai_runs result, ai_llm_calls, ai_tool_calls, proposals,
                  incident_event, audit_log, outbox_event }   ← one transaction
17. relay    outbox → Redis pub/sub → api → SSE → other tabs refresh
18. Human    clicks Approve → api checks the APPROVER's role against the ACTION's permission
19. api      re-resolves the target from current state (incident's service, deploy history)
20. api      executes as the approver → audit_log + incident_event
```

**The three sentences that matter:**

- Step 11: the agent reaches tenant data only through the gateway, which
  re-checks the user's _current_ role on every call.
- Step 14: a fabricated citation is deleted by code before any human sees it.
- Step 18–19: the model's arguments are not trusted; the target is re-derived
  from the database at approval time.

---

## 6. Where things live

```
apps/api/src/
  modules/{auth,organizations,incidents,ai}/   routes → service → repository
  platform/authorization.ts                    the 16×4 permission matrix
  platform/org-context.ts                      membership resolution, 404-not-403
  tool-gateway/                                the agent's only door to data
  realtime/hub.ts                              Redis subscribe → SSE fan-out
apps/ai-service/src/opspilot_ai/
  agent/graph.py        the LangGraph workflow
  agent/ledger.py       provenance
  agent/guardrails.py   enforcement + untrusted-data wrapping
  retrieval/            chunking, embeddings, fusion, rerank, Qdrant store
  llm/                  provider protocol, OpenAI-compatible adapter, fake
  eval/                 metrics and the evaluation runner
apps/worker/src/
  processors/{ingestion,investigation,outbox-relay}.ts
packages/database/
  migrations/*.sql      10 migrations, including the RLS policies
  src/tenant.ts         withTenant() — the per-transaction org setting
  src/seed/scenario.ts  the demo scenario as data
```

---

## 7. Ten questions you will be asked

1. **"Why not just use Claude/ChatGPT with MCP connectors?"** →
   [ADR-011](decisions/ADR-011-product-layer-vs-general-agent.md). The
   investigation is not the differentiator; shared state, org-level
   authorization, approval, audit and measurable quality are. And OpsPilot
   _is_ an MCP server, so a general agent can use it.
2. **"How do you stop the AI hallucinating a source?"** → It can't be stopped
   from _producing_ one; it is stopped from _reaching a human_. Every tool call
   and chunk gets an id; citations are filtered against that ledger in code;
   confidence is capped when support turns out to be invented.
3. **"How do you stop it doing something dangerous?"** → It has no write tools.
   It proposes; an authorized human approves; the API executes as that person
   and re-validates the arguments against current state.
4. **"How does multi-tenancy work?"** → Three layers: path scoping plus
   repository functions, Postgres RLS on every tenant table, and composite
   foreign keys. Forgetting the filter returns _no rows_, not someone else's.
5. **"Why SSE and not WebSockets?"** → Almost all traffic is server→client;
   mutations are REST. SSE reconnects itself and replays missed events.
6. **"What happens if Redis dies mid-write?"** → Nothing is lost. The event was
   committed to `outbox_events` in the same transaction; the relay retries.
   There is a test that unplugs Redis and asserts the event survives.
7. **"How do you know the retrieval is any good?"** → An eval dataset and
   deterministic metrics. Numbers, caveats and the hybrid-vs-vector comparison
   are in [rag.md](rag.md).
8. **"What would break at scale?"** → Honest answer in
   [interview-notes.md](interview-notes.md): logs and metrics belong in a
   purpose-built store, the polling relay should become logical replication,
   and retrieval and agent execution would split once their scaling profiles
   diverge. No load testing has been done, so nothing is claimed.
9. **"What was the hardest bug?"** → Pick from the twelve recorded in
   interview-notes.md. The best one: rate limiting that silently degraded to
   IP-only because the limiter ran before body parsing — one attacked account
   would have locked out a whole office.
10. **"What would you do differently?"** → pgvector instead of Qdrant at this
    scale; a shared contracts package earlier; and I would have tested against
    a real model sooner — four real defects only appeared when I did.

---

## 8. Be ready to say what is _not_ built

Saying this unprompted is worth more than hiding it:

- Notification delivery (email, webhooks) — designed, not built.
- Answer-quality evaluation (faithfulness, relevance) — needs a judge model.
- Terraform / AWS — the architecture is documented; nothing is deployed.
- An approved rollback is **recorded, not performed**; no deployment system is
  connected and the response says so.
- No load testing, so no throughput numbers.
- Retrieval scores come from eight questions over seven documents: real and
  reproducible, not a benchmark.
