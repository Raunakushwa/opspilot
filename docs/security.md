# Security

What is implemented today, and what each later phase adds. Nothing here claims
a control that does not exist.

## Implemented (Phase 1)

| Control                                                                                                                                  | Where                                         |
| ---------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| Configuration validated at startup; messages name variables but never echo values (connection strings carry credentials)                 | all three services                            |
| Secrets only via environment/`.env`; `.env` is git-ignored, `.env.example` holds placeholders                                            | repo                                          |
| Application database role cannot create/alter tables, bypass row-level security, or read migration history                               | `packages/database`, verified in tests and CI |
| Database passwords never appear in migrations; the login role is provisioned separately                                                  | `migrate` job                                 |
| Role names validated against a strict identifier pattern; DDL built by PostgreSQL's `format('%I','%L')` rather than string concatenation | `provisionAppUser`                            |
| Security headers (Helmet), CORS allowlist with credentials                                                                               | `apps/api`                                    |
| Authorization and cookie headers redacted from logs                                                                                      | `apps/api`                                    |
| Caller-supplied request IDs accepted only if they match `^[\w.-]{1,128}$` — log-injection safe                                           | api and ai-service                            |
| Internal errors return only a request ID; details go to logs                                                                             | api and ai-service                            |
| Readiness endpoints report status without leaking failure detail                                                                         | all services                                  |
| Containers run as non-root with signal forwarding                                                                                        | `infra/docker`                                |
| Dependency install scripts blocked by default; each exception reviewed                                                                   | `pnpm-workspace.yaml`                         |
| Package versions younger than 24h refused (`minimumReleaseAge`) — most malicious npm releases are caught within hours                    | `pnpm-workspace.yaml`                         |
| Secret scanning on commit (gitleaks) and Dependabot updates                                                                              | tooling, `.github`                            |

## Phase 2 — authentication and authorization

argon2id password hashing; opaque session tokens stored hashed, delivered in
`httpOnly; Secure; SameSite=Lax` cookies (ADR-008); CSRF defence via same-site
cookies plus a custom-header requirement; rate limiting on authentication
endpoints keyed by IP **and** account; RBAC enforced server-side in a policy
layer with an exhaustive test matrix; row-level security policies (ADR-009).

## Phase 3+ — audit and data integrity

Append-only `audit_logs` (privileges plus a trigger rejecting `UPDATE`/`DELETE`);
optimistic concurrency so a stale write fails rather than overwrites;
cross-tenant references made unstorable by composite foreign keys.

## Phase 7+ — AI-specific controls

- **Least privilege for tools**: the agent reads through the API's Tool Gateway
  with a short-lived delegation token scoped to (user, organization, run); the
  gateway re-loads current membership, so a revoked role takes effect mid-run.
- **No write capability in the agent** (ADR-007): dangerous actions are
  proposals approved by an authorized human and executed by the API as the
  approver, with an audit record.
- **Retrieved documents are untrusted data**, wrapped in delimited blocks; the
  system prompt states they carry no instructions, and tool results can never
  introduce tool names outside the planner's allowlist.
- **Provenance enforcement**: citations are validated in code against the run's
  ledger; unknown references are stripped and flagged.
- **Cache keys include tenant and user context**, so nothing tenant-specific is
  ever served across a boundary.

## Known gaps

- No authentication exists yet, so the API is currently unauthenticated by
  design; it is not exposed anywhere public.
- Rate limiting is designed but not implemented.
- Dependency and container image scanning in CI is planned, not present.
- No commit-time secret scanning yet (e.g. gitleaks in a pre-commit hook or a
  CI job); `.env` being git-ignored is the only current protection.
