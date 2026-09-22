# ADR-008: Opaque server-side sessions rather than JWT

- **Status**: Accepted
- **Date**: 2026-09-22

## Context

Users sign in to an organization; roles can change or be revoked; an
administrator must be able to end a session immediately. The browser talks to a
single origin (the UI proxies `/api`), so cookies are same-site.

## Decision

Opaque session tokens: random, stored hashed in PostgreSQL, cached in Redis,
delivered in an `httpOnly; Secure; SameSite=Lax` cookie. Passwords are hashed
with argon2id. CSRF is addressed by same-site cookies plus a custom-header
requirement on state-changing requests.

Short-lived JWTs are still used for **service-to-service delegation** (the tool
gateway token), where the audience and lifetime are controlled by us.

## Alternatives considered

- **JWT access token + rotating refresh token with reuse detection.** The
  conventional answer, and genuinely better when an identity provider must issue
  tokens for many services. Its cost is that revocation is approximate: a stolen
  access token stays valid until it expires, so a deny-list ends up being built
  anyway — a session store with extra steps.
- **A hosted auth provider.** Less to build, but authentication and RBAC are
  precisely the parts worth demonstrating here, and it adds a hard dependency to
  local development.

## Consequences

- Revocation is immediate and auditable; role changes take effect on the next
  request because membership is loaded per request.
- Every request does a session lookup — Redis-cached, so the API stays stateless
  in the sense that matters: any instance can serve any request.
- Cookie-based auth requires care with cross-origin requests; the single-origin
  setup keeps that surface small.
