# ADR-002: Redis and BullMQ with a transactional outbox

- **Status**: Accepted
- **Date**: 2026-09-22

## Context

Several things must happen when an incident changes: the row is updated, a
timeline event and audit record are written, connected clients are notified in
real time, and notifications are delivered. Doing the last two inside the
request would make writes slow and failure-prone.

Publishing after the commit is the obvious approach and is quietly wrong: if the
process dies between commit and publish, the event is lost forever and nobody
ever learns that the incident changed.

## Decision

Redis with BullMQ for queues, caching, rate limiting and pub/sub. Domain events
are written to an `outbox_events` table **in the same transaction** as the state
change; a relay in the worker publishes them to Redis and enqueues jobs.

## Alternatives considered

- **Publish after commit.** Simpler and lossy. Rejected: the dual-write problem
  is the whole point.
- **SQS/SNS.** Fine in AWS, but nothing to run locally, and BullMQ gives
  retries, backoff, rate limiting and a dead-letter path out of the box.
- **PostgreSQL as the queue (`SELECT ... FOR UPDATE SKIP LOCKED`).** One fewer
  dependency, but Redis is already needed for sessions, caching and rate limits.

## Consequences

- No event is lost on crash; the relay is at-least-once, so consumers are
  idempotent.
- Extra latency between commit and publish. `LISTEN/NOTIFY` wakes the relay so
  it is small, with polling as a fallback.
- Redis is never a source of truth. Everything in it can be rebuilt.
