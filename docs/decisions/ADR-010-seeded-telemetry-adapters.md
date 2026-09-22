# ADR-010: Seeded logs, metrics and deployments behind adapters

- **Status**: Accepted
- **Date**: 2026-09-22

## Context

The copilot inspects logs, metrics and deployment history. Running Prometheus,
Loki and a deployment system locally would add three dependencies to
`docker compose up` and still produce no interesting incidents to investigate.

## Decision

Logs, metrics and deployments are ordinary PostgreSQL tables populated by a
deterministic seed that contains a designed incident scenario. They are read
through `LogSource`, `MetricSource` and `DeploySource` interfaces.

## Alternatives considered

- **Real observability stack locally.** Honest, heavy, and the demo would depend
  on generating traffic to have anything to look at.
- **Mocking inside the AI service.** Faster, but then the tool layer, the
  authorization checks and the tenant filters would not be exercised at all.

## Consequences

- The demo and the evaluations are reproducible: the same question yields the
  same retrieved evidence.
- A Prometheus or CloudWatch adapter can be added without touching the agent.
- We must not overclaim: the tools query seeded tables, and the documentation
  says so plainly.
