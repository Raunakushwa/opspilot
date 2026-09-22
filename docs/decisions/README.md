# Architecture Decision Records

Each record states the context, the decision, the alternatives that were
seriously considered, and the consequences — including the ones we dislike.

| ADR                                                | Decision                                         | Status   |
| -------------------------------------------------- | ------------------------------------------------ | -------- |
| [001](ADR-001-postgresql-and-drizzle.md)           | PostgreSQL with Drizzle ORM                      | Accepted |
| [002](ADR-002-redis-bullmq-and-outbox.md)          | Redis + BullMQ with a transactional outbox       | Accepted |
| [003](ADR-003-sse-over-websockets.md)              | SSE rather than WebSockets                       | Accepted |
| [004](ADR-004-qdrant-for-retrieval.md)             | Qdrant for vector and sparse retrieval           | Accepted |
| [005](ADR-005-langgraph-agent.md)                  | LangGraph with a planner-routed graph            | Accepted |
| [006](ADR-006-llm-provider-abstraction.md)         | One OpenAI-compatible provider plus a fake       | Accepted |
| [007](ADR-007-human-approval-proposals-as-data.md) | Write actions are proposals, executed by the API | Accepted |
| [008](ADR-008-opaque-sessions.md)                  | Opaque server-side sessions rather than JWT      | Accepted |
| [009](ADR-009-tenant-isolation.md)                 | Path-scoped tenancy with row-level security      | Accepted |
| [010](ADR-010-seeded-telemetry-adapters.md)        | Seeded logs/metrics/deployments behind adapters  | Accepted |
| [011](ADR-011-product-layer-vs-general-agent.md)   | A product layer, not just an agent with tools    | Accepted |

Template: [ADR-000-template.md](ADR-000-template.md)
