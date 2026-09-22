# ADR-001: PostgreSQL with Drizzle ORM

- **Status**: Accepted
- **Date**: 2026-09-22

## Context

OpsPilot stores tenant-owned relational data (organizations, incidents,
documents, deployments, audit logs) with strong integrity requirements:
cross-tenant references must be impossible, audit history must be immutable,
and the incident list must stay fast under common filters.

Tenant isolation is to be enforced in the database as well as the application
(ADR-009), which requires row-level security, per-transaction session settings,
composite foreign keys, generated `tsvector` columns and partial indexes.

## Decision

PostgreSQL as the source of truth, accessed through Drizzle ORM with
hand-written SQL migrations.

## Alternatives considered

- **Prisma.** More mature ecosystem and better-known. But row-level security
  needs `SET LOCAL` inside every transaction, and composite foreign keys,
  generated columns and partial indexes are awkward or unsupported. We would
  spend the project fighting the ORM at exactly the points that matter.
- **MySQL.** No row-level security, weaker JSON and full-text support.
- **A document database.** The domain is relational — incidents reference
  services, deployments, users and documents. Foreign keys are the feature.

## Consequences

- SQL stays visible and reviewable; migrations are plain `.sql` files, which is
  what makes ADR-009's policies and the role model expressible at all.
- Drizzle's ecosystem is smaller than Prisma's; some tooling we write ourselves.
- The migration runner is ours: an advisory lock serialises concurrent runners
  and `lock_timeout` stops a migration from blocking live traffic.
