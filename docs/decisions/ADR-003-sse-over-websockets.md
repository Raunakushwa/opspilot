# ADR-003: Server-Sent Events rather than WebSockets

- **Status**: Accepted
- **Date**: 2026-09-22

## Context

When one engineer changes an incident's status, everyone viewing it should see
the change without refreshing, and AI investigation progress should stream while
it runs. Almost all of this traffic is server → client; client → server traffic
is ordinary REST.

## Decision

Server-Sent Events, fanned out across API instances through Redis pub/sub.
Investigation progress is published to a Redis stream so a client that
reconnects can resume with `Last-Event-ID`.

## Alternatives considered

- **WebSockets.** A genuine bidirectional channel, needed for typing indicators
  or collaborative editing. We have neither. It costs a second protocol, its own
  auth handshake, and heavier load-balancer configuration.
- **Polling.** Simple, but either wasteful or slow, and it scales with users
  rather than with events.

## Consequences

- Automatic reconnection and event resumption come free with `EventSource`.
- `EventSource` cannot send custom headers, which is one of the reasons the
  tenant lives in the URL path (ADR-009) rather than a header.
- HTTP/2 is needed in production to avoid the per-origin connection limit, and
  the load balancer's idle timeout must exceed the heartbeat interval.
- Presence uses a heartbeat request rather than the socket itself.
