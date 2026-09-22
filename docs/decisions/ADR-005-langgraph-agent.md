# ADR-005: LangGraph with a planner-routed graph

- **Status**: Accepted
- **Date**: 2026-09-22

## Context

An investigation is a sequence of steps with explicit state: understand the
incident, decide what to inspect, gather evidence, synthesise, check the answer.
It must be auditable — we have to be able to say exactly which sources were
consulted — and it must not call every tool on every question.

## Decision

LangGraph with explicit `InvestigationState` and conditional edges. A planner
node emits a structured plan; only the planned inspection nodes run. Skipped
sources are recorded in state as _not inspected_ and reported as such.

## Alternatives considered

- **A hand-rolled loop.** Fewer dependencies, and for the first slice it would
  work. Rejected because the state machine, conditional routing and per-node
  testing are exactly what we want to demonstrate and maintain.
- **A free-form ReAct agent.** Flexible and hard to audit: it decides what to do
  next inside the model, which makes "prove what it inspected" difficult.
- **A fixed linear pipeline.** Predictable but wasteful: it would query metrics
  and logs for a question that only needs a runbook.

## Consequences

- Every node is testable in isolation with a fake LLM provider.
- The answer can state what it did _not_ check, which is the honest behaviour
  the product requires.
- A reflection edge back to planning is bounded (max one extra iteration) to cap
  latency and cost.
