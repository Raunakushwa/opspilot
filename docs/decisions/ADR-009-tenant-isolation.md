# ADR-009: Path-scoped tenancy with row-level security

- **Status**: Accepted
- **Date**: 2026-09-22

## Context

Every tenant-owned row belongs to an organization, and a user may belong to
several. The failure we care about is not a clever attack; it is an engineer
writing a query that forgets `WHERE organization_id = $1` and shipping a silent
cross-tenant leak.

## Decision

Three independent layers:

1. **URL path scoping** — `/api/orgs/:orgId/...`. Membership and role are
   resolved from the path on every request.
2. **Row-level security** — every tenant table has a policy comparing `org_id`
   to a per-transaction setting. The application connects as a role that is not
   the table owner, because owners bypass RLS.
3. **Composite foreign keys** — `(org_id, id)` references make storing a
   cross-tenant reference impossible rather than merely unlikely.

## Alternatives considered

- **An `X-Organization-Id` header.** Invisible in URLs, but `EventSource`
  cannot send custom headers (ADR-003), and a path is easier to log, cache and
  reason about.
- **Application-level filtering only.** One forgotten clause becomes a breach.
- **A database (or schema) per tenant.** Excellent isolation, painful
  migrations, and it does not match a product where users switch organizations.

## Consequences

- A forgotten filter returns _no rows_ instead of someone else's rows.
- Every request runs inside a transaction so the session setting applies; this
  is a real cost we accept.
- Migrations run as the owner; the runtime role holds data privileges only and
  is provisioned by infrastructure, keeping passwords out of migrations.
- Tests assert the boundary directly: the application role has neither
  `SUPERUSER` nor `BYPASSRLS`, and CI re-checks that in the running stack.
