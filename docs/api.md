# API

REST over HTTP, JSON in and out. Errors are RFC 9457 `application/problem+json`
with a stable `code` and the `requestId` for correlation.

## Conventions

- **Tenancy in the path**: `/api/orgs/:orgId/...`. `EventSource` cannot send
  custom headers, so a header-based organization would break SSE (ADR-009).
- **A non-member gets 404, not 403** — "forbidden" would confirm the resource
  exists.
- **Optimistic concurrency**: reads return `ETag: "<version>"`; `PATCH`
  requires `If-Match`. Missing ⇒ `428`, stale ⇒ `412`.
- **Pagination**: opaque keyset cursors (`?limit=&cursor=`), never OFFSET.
- **Rate limiting**: Redis-backed; credential endpoints are keyed by IP _and_
  account.

## Endpoints

| Method       | Path                                         | Permission                                 |
| ------------ | -------------------------------------------- | ------------------------------------------ |
| POST         | `/api/auth/register` · `/login` · `/logout`  | —                                          |
| GET          | `/api/me`                                    | session                                    |
| GET/POST     | `/api/orgs`                                  | session                                    |
| GET/PATCH    | `/api/orgs/:org`                             | `organization:read` / `organization:write` |
| GET/POST     | `/api/orgs/:org/members`                     | `organization:read` / `member:manage`      |
| PATCH/DELETE | `/api/orgs/:org/members/:userId`             | `member:manage` (self-removal allowed)     |
| GET/POST     | `/api/orgs/:org/incidents`                   | `incident:read` / `incident:write`         |
| GET/PATCH    | `/api/orgs/:org/incidents/:id`               | `incident:read` / `incident:write`         |
| GET          | `/api/orgs/:org/incidents/:id/events`        | `incident:read`                            |
| POST         | `/api/orgs/:org/ai/investigations`           | `ai:investigate`                           |
| GET          | `/api/orgs/:org/ai/runs/:runId`              | `incident:read`                            |
| GET          | `/api/orgs/:org/ai/runs/:runId/stream` (SSE) | `incident:read`                            |
| GET          | `/api/orgs/:org/ai/proposals`                | `incident:read`                            |
| POST         | `/api/orgs/:org/ai/proposals/:id`            | per-action (`ai:approve:*`)                |
| GET          | `/api/orgs/:org/stream` (SSE)                | `incident:read`                            |
| GET          | `/api/orgs/:org/audit-logs`                  | `audit:read`                               |
| GET          | `/api/status` · `/healthz` · `/readyz`       | —                                          |

## Internal surfaces (never publicly routed)

| Service     | Path                                                                                    | Auth                                                  |
| ----------- | --------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| api `:4001` | `/internal/tools/:tool`                                                                 | delegation token, scoped to (user, organization, run) |
| ai-service  | `/internal/index/document-versions`, `/internal/search`, `/internal/investigations/run` | shared internal token                                 |

The tool gateway re-reads the user's membership on every call, so a revoked
role takes effect mid-investigation.
