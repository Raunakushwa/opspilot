# ADR-011: A product layer, not just an agent with tools

- **Status**: Accepted
- **Date**: 2026-09-23

## Context

A general-purpose coding agent connected to Datadog, GitHub and PagerDuty over
MCP can already answer "why is payment-service failing?" reasonably well. If
that is true, building an incident platform with an AI copilot needs a reason.

The honest assessment: **the investigation itself is not the differentiator.**
OpsPilot calls a model too. What a chat session cannot provide is everything
around the model.

## Decision

Build the product layer, and treat general agents as a complement rather than a
competitor: OpsPilot uses a model provider internally (ADR-006) and will expose
its own read tools as an **MCP server**, so an engineer in a general agent can
ask OpsPilot a question and get a permission-checked, cited answer.

## What the product layer provides that a chat session does not

| Chat session with tools                         | OpsPilot                                                                                               |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| The investigation lives in one person's history | It is attached to the incident: shared, timelined, part of the postmortem                              |
| Runs with that person's credentials             | Organization-level authorization, tenant isolation, least-privilege read tools                         |
| Can call a connected write tool directly        | Write actions are proposals approved by an authorized human and audited (ADR-007)                      |
| Starts cold, or from pasted context             | Retrieves the organization's runbooks, postmortems and past incidents; resolved incidents feed back in |
| Nobody measures whether answers are right       | An evaluation set with fixed questions catches regressions when the prompt or model changes            |
| Runs when a human asks                          | Can start when an alert fires                                                                          |
| Free-form text                                  | Structured, cited output other systems consume                                                         |
| No per-team cost visibility                     | Cost, latency and tool usage tracked per organization, with budgets                                    |

## Alternatives considered

- **Ship a set of MCP tools and nothing else.** Much less work. It leaves every
  organization to solve approval, audit, tenancy and evaluation themselves —
  which is the part that is actually hard.
- **Build only the incident tracker, no AI.** A crowded market with no reason to
  choose it.

## Consequences

- Effort concentrates where the leverage is: authorization, human approval,
  provenance and evaluation — not on out-reasoning the model.
- The MCP server becomes a deliverable rather than an afterthought.
- We state this trade-off openly: for a single engineer asking ad-hoc questions,
  a general agent with connectors is often enough. The value here is governance,
  shared state and repeatability for a team.
