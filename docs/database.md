# Database

PostgreSQL is the source of truth. Everything in Redis and Qdrant can be
rebuilt from it.

## Privilege model (implemented)

Two kinds of principal, because PostgreSQL table owners **bypass row-level
security** — so the application must not own its tables.

| Principal               | Created by                       | Capabilities                                                                                                        |
| ----------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| migrator (schema owner) | infrastructure                   | DDL; owns every table                                                                                               |
| `app_rw` (NOLOGIN)      | migration `0000`                 | `SELECT/INSERT/UPDATE/DELETE` on tables created by later migrations, via default privileges. No DDL, no `BYPASSRLS` |
| application login user  | infrastructure, `IN ROLE app_rw` | inherits `app_rw` only                                                                                              |

Migrations cannot create the login user: they would have to contain a password.
The `migrate` container therefore runs two steps — apply migrations, then
provision the login role from environment/secret values. In AWS that second step
is Terraform reading from Secrets Manager.

Verified by integration tests and re-checked by CI in the running stack: the
application role is not a superuser, cannot bypass RLS, cannot create or alter
tables, and cannot read the migration history.

## Migrations (implemented)

Hand-written SQL under `packages/database/migrations`, applied by a runner that:

- takes a **session advisory lock**, so several containers starting at once do
  not race (without it, concurrent runners fail on `pg_namespace_nspname_index`
  — demonstrated by a test);
- sets **`lock_timeout`**, so a migration that cannot acquire its table lock
  fails fast instead of queueing and blocking every query behind it.

## Schema conventions (Phase 2)

- **IDs**: UUIDv7 generated in the application — time-ordered, index-friendly,
  usable as keyset cursors. Incidents additionally have a per-organization
  human number (`INC-142`).
- **Tenancy**: every tenant table has `org_id NOT NULL`, `UNIQUE (org_id, id)`,
  and composite foreign keys `(org_id, …_id)` so a cross-tenant reference cannot
  be stored. Row-level security policies compare `org_id` to a per-transaction
  setting.
- **Concurrency**: `version` columns on concurrently edited rows; `If-Match` on
  PATCH, `412` on a stale write.
- **Time**: `timestamptz` everywhere.
- **Audit**: `audit_logs` is append-only — the application role is granted
  `INSERT`/`SELECT` only, and a trigger rejects `UPDATE`/`DELETE`.

## Planned tables

```
IDENTITY      organizations · users · memberships · sessions · teams · team_members · projects · services
INCIDENTS     incidents · incident_services · incident_events · incident_comments · comment_mentions
              incident_subscriptions · incident_documents · incident_deployments
KNOWLEDGE     documents · document_versions · document_chunks
TELEMETRY     deployments · metric_points · log_entries            (seeded; see ADR-010)
NOTIFY        notifications · notification_preferences · notification_deliveries
AI            ai_conversations · ai_runs · ai_llm_calls · ai_tool_calls · ai_action_proposals
              eval_datasets · eval_cases · eval_runs · eval_case_results
PLATFORM      audit_logs · outbox_events · job_failures
```

## Index strategy (Phase 2)

Indexes follow measured access patterns rather than column lists. Planned:

| Index                                                                           | Query it serves                                                  |
| ------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `incidents (org_id, status, created_at DESC)`                                   | the incident list, the most frequent query                       |
| `incidents (org_id, severity, created_at DESC)`                                 | severity filter and dashboard                                    |
| `incidents (org_id, assigned_to) WHERE status NOT IN ('RESOLVED','CLOSED')`     | "my open incidents" — partial, so it stays small                 |
| `incidents USING GIN (search_tsv)`                                              | incident search and the `search_incidents` tool                  |
| `incident_events (incident_id, created_at)`                                     | timeline                                                         |
| `deployments (org_id, service_id, started_at DESC)`                             | "what changed before the failures started?"                      |
| `log_entries (org_id, service_id, ts DESC)` + `BRIN (ts)` + `GIN (message_tsv)` | time-windowed log search; BRIN is cheap on append-only time data |
| `documents USING GIN (tags)`                                                    | tag filtering                                                    |
| `audit_logs (org_id, created_at DESC)`                                          | audit view                                                       |
| `outbox_events (id) WHERE published_at IS NULL`                                 | relay scan                                                       |

No standalone `org_id` indexes: each composite above already leads with it.
