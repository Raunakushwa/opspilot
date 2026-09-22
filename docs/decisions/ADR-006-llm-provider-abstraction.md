# ADR-006: One OpenAI-compatible provider plus a fake

- **Status**: Accepted
- **Date**: 2026-09-22

## Context

Model choice changes for reasons unrelated to the application: price, latency,
availability, or running fully local. Tests and CI must not depend on a paid,
non-deterministic service.

## Decision

An `LLMProvider` protocol (`generate`, `generate_structured`, `stream`) with:

- `OpenAICompatibleProvider` — one implementation covering Groq, OpenAI-compatible
  endpoints and local Ollama by configuration (base URL, model, capabilities);
- `FakeLLMProvider` — scripted and deterministic, used by unit tests, CI and E2E.

A model registry maps _roles_ (planner, synthesizer, judge) to provider, model
and price, so a role can move to another model without code changes.

## Alternatives considered

- **A vendor SDK per provider.** More faithful to each API, but three of our
  four targets speak the same wire protocol, so it is mostly duplication.
- **A framework abstraction (e.g. LangChain chat models).** Convenient, but it
  owns the request shape, which is where structured output and observability
  need control.

## Consequences

- Structured output uses native JSON-schema mode where available, otherwise JSON
  mode plus validation and a single repair retry; persistent failure is a typed
  error the graph handles, not an exception that escapes.
- CI is deterministic and free.
- A provider with a genuinely different API (not OpenAI-compatible) needs a new
  adapter — which is what the protocol is for.
