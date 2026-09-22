# ADR-007: Write actions are proposals, executed by the API

- **Status**: Accepted
- **Date**: 2026-09-22

## Context

The copilot should be able to suggest "roll back deployment 41f2c9" and, with
approval, have it happen. Rolling back a payment service is exactly the kind of
action that must never follow from a confident-sounding paragraph, a poisoned
runbook, or a prompt-injected document.

## Decision

The agent has **no write tools at all**. It emits `ProposedAction` records
(type, arguments, rationale, evidence references) which are persisted with an
expiry. A human with the required role approves; the API then re-validates the
arguments against current state and executes the action **as the approver**,
writing an audit record and a timeline event.

## Alternatives considered

- **LangGraph `interrupt()` with a persisted checkpointer.** The idiomatic
  human-in-the-loop pattern: the graph pauses and resumes after approval.
  Rejected for now because it requires the AI service to hold checkpoint state
  and, more importantly, leaves write capability inside the agent's tool set.
- **Write tools guarded by a permission check inside the agent.** The check
  would live in the least trustworthy part of the system.

## Consequences

- Authorization happens once, at execution time, with the approver's identity —
  not the (possibly broader) permissions of whoever started the investigation.
- A proposal can be re-validated: "is that still the latest deployment?"
- The agent does not automatically continue after approval. A follow-up run can
  summarise the outcome; we accept the extra step.
- Every dangerous verb is a capability the API owns, so the blast radius of a
  prompt injection is a proposal nobody approves.
