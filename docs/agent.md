# The investigation agent

The copilot's job is to reach a defensible conclusion about an incident and to
be honest about how it got there. Most of the design below exists to make
dishonesty structurally impossible rather than merely discouraged.

## The graph

```
START → UnderstandIncident → PlanInvestigation ─┬─▶ get_deployments   ─┐
                                                ├─▶ get_log_patterns  │  (only the
                                                ├─▶ get_metrics       │   planned
                                                ├─▶ search_documents  │   steps, run
                                                └─▶ search_incidents ─┘   concurrently)
                                                          ▼
                                                 SynthesizeEvidence
                                                          ▼
                                                    ReviewAnswer → END
```

Implemented with LangGraph and explicit state (ADR-005). The planner emits a
structured plan, and conditional routing runs only those steps, so a question
about a runbook does not also query metrics and logs. Independent reads run
concurrently — an investigation that takes a minute because it queried four
sources in series is a worse product.

## The provenance ledger

Every tool call and every retrieved chunk is recorded with an id. The answer
may only cite ids from that run, and **the check is code, not a request in a
prompt**:

| If the model…                                 | …then                                                  |
| --------------------------------------------- | ------------------------------------------------------ |
| cites a source that does not exist            | the evidence is deleted and never rendered             |
| leans a cause on deleted evidence             | the reference is stripped from the cause               |
| proposes an action with no surviving evidence | the proposal is withdrawn before any human sees it     |
| claims high confidence on invented support    | confidence is capped (≤0.5, or ≤0.2 with nothing left) |
| a tool failed or returned nothing             | it appears in `not_inspected`                          |

The last row is the product promise: the assistant states what it could not
read instead of quietly omitting it, and the UI renders that list as
prominently as the rest of the answer.

## Structured output

Critical logic never reads free-form text. The agent returns a Pydantic
`InvestigationResult` (summary, confidence, probable causes, evidence,
recommended actions, proposed actions, citations, not-inspected). Invalid
output is repaired once from the validation errors, then becomes a typed
failure the graph handles — never an exception escaping mid-investigation.

## Degradation

| Failure                                  | Behaviour                                               |
| ---------------------------------------- | ------------------------------------------------------- |
| Planner returns invalid JSON             | fall back to the standard first moves; record the error |
| Planner invents a tool name              | that step is dropped, the rest still run                |
| A tool is refused (role revoked mid-run) | recorded as not inspected; the answer says so           |
| Synthesis returns invalid JSON           | return the gathered evidence with confidence 0          |
| Review fails                             | keep the deterministic provenance result                |

## Guardrails

- **The agent has no write tools at all.** Dangerous verbs are capabilities the
  API owns; the agent can only propose (ADR-007).
- **Retrieved text is untrusted data**, wrapped in delimited blocks that cannot
  be escaped — a document trying to close the block early is neutralised — and
  the system prompt states such content is evidence, never instructions.
- **Tool arguments come from a language model**, so they are schema-validated
  and never coerced; windows and limits are capped.
- **Authorization is re-derived per tool call** from the user's current
  membership, so a role revoked mid-investigation takes effect at once.

## Prompts and telemetry

Prompts are versioned (`PROMPT_VERSION`) and recorded with every run alongside
the model, token counts, per-tool latency and an estimated cost. Cost comes
from a versioned price table and is labelled an estimate; an unknown model
costs zero rather than a guessed number that would look authoritative.

## What is deliberately absent

- **No automatic execution**, however confident the answer.
- **No chain-of-thought in the UI**: progress events are fixed, templated
  labels ("Checking deployment history"), not the model's private reasoning.
- **No silent retry of an expensive run**: investigations retry once, because
  they cost money and are not idempotent from a user's point of view.
