"""The investigation workflow.

START → UnderstandIncident → PlanInvestigation → (only the planned tools)
      → SynthesizeEvidence → ReviewAnswer → END

The planner decides which tools run, so a question about a runbook does not
drag metrics and logs along with it (ADR-005). Review is mostly deterministic:
the ledger check is code, and the model is only asked whether the reasoning
holds together.
"""

import asyncio
import json
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any, TypedDict

from langgraph.graph import END, START, StateGraph
from pydantic import BaseModel, Field

from opspilot_ai.llm.base import LLMProvider, LLMRequest, MalformedOutputError, Message, Usage
from opspilot_ai.logging import get_logger

from .guardrails import enforce_provenance, wrap_untrusted
from .ledger import Ledger, ToolRecord
from .models import InvestigationPlan, InvestigationResult
from .prompts import PLANNER, PROMPT_VERSION, REVIEW, SYNTHESIS, SYSTEM
from .tools import AVAILABLE_TOOLS, PROGRESS_LABELS, TOOL_DESCRIPTIONS, ToolRunner

logger = get_logger(__name__)

ProgressEmitter = Callable[[str, dict[str, Any]], Awaitable[None]]


class ReviewVerdict(BaseModel):
    sufficient: bool = True
    problems: list[str] = Field(default_factory=list)
    suggested_confidence: float | None = None


@dataclass
class InvestigationContext:
    run_id: str
    organization_id: str
    user_id: str
    incident: dict[str, Any]
    question: str
    llm: LLMProvider
    runner: ToolRunner
    emit: ProgressEmitter
    ledger: Ledger = field(default_factory=Ledger)
    usage: list[Usage] = field(default_factory=list)


class InvestigationState(TypedDict, total=False):
    """Explicit state, so every node's contribution is visible and testable."""

    plan: InvestigationPlan
    tool_records: list[ToolRecord]
    draft: InvestigationResult
    review: ReviewVerdict
    result: InvestigationResult
    errors: list[str]
    iteration: int


def _incident_summary(incident: dict[str, Any]) -> str:
    services = ", ".join(s.get("slug", "") for s in incident.get("services", [])) or "unknown"
    return (
        f"INC-{incident.get('number', '?')}: {incident.get('title', '')}\n"
        f"severity={incident.get('severity')} status={incident.get('status')} "
        f"services={services}\n"
        f"description: {incident.get('description') or '(none)'}"
    )


def _incident_age_minutes(incident: dict[str, Any]) -> int:
    created = incident.get("createdAt") or incident.get("created_at")
    if not isinstance(created, str):
        return 180
    try:
        from datetime import UTC, datetime

        started = datetime.fromisoformat(created.replace("Z", "+00:00"))
        return max(15, int((datetime.now(UTC) - started).total_seconds() // 60))
    except ValueError:
        return 180


def build_investigation_graph(context: InvestigationContext) -> Any:
    async def understand(state: InvestigationState) -> InvestigationState:
        del state  # the incident is supplied in context, not in graph state
        await context.emit("step.started", {"step": "understand", "label": "Reading the incident"})
        # The incident is already in context; recording it as a tool result keeps
        # the ledger complete, so the answer can cite the incident itself.
        context.ledger.record_tool(
            ToolRecord(
                tool_call_id=f"incident:{context.incident.get('id', '')}",
                tool="get_incident",
                arguments={"incident_id": context.incident.get("id", "")},
                ok=True,
                result=context.incident,
            )
        )
        return {"iteration": 0, "errors": []}

    async def plan(state: InvestigationState) -> InvestigationState:
        await context.emit("step.started", {"step": "plan", "label": "Planning the investigation"})
        tools_text = "\n".join(f"- {name}: {TOOL_DESCRIPTIONS[name]}" for name in AVAILABLE_TOOLS)
        request = LLMRequest(
            messages=[
                Message(role="system", content=SYSTEM),
                Message(
                    role="user",
                    content=PLANNER.format(
                        tools=tools_text,
                        incident=wrap_untrusted(_incident_summary(context.incident)),
                        question=context.question,
                        age_minutes=_incident_age_minutes(context.incident),
                    ),
                ),
            ]
        )
        try:
            response = await context.llm.generate_structured(request, InvestigationPlan)
        except MalformedOutputError as exc:
            logger.warning("planner_failed", error=str(exc))
            # A failed planner must not end the investigation: fall back to the
            # standard first moves rather than returning nothing.
            return {
                "plan": _fallback_plan(context),
                "errors": [*state.get("errors", []), "planner produced invalid output"],
            }

        context.usage.append(response.usage)
        steps = [step for step in response.value.steps if step.tool in AVAILABLE_TOOLS]
        dropped = len(response.value.steps) - len(steps)
        if dropped:
            logger.warning("planner_hallucinated_tools", dropped=dropped)
        plan_value = InvestigationPlan(
            steps=steps or _fallback_plan(context).steps, rationale=response.value.rationale
        )
        await context.emit(
            "plan.created",
            {
                "steps": [
                    {"tool": step.tool, "label": PROGRESS_LABELS.get(step.tool, step.tool)}
                    for step in plan_value.steps
                ],
                "rationale": plan_value.rationale,
            },
        )
        return {"plan": plan_value}

    async def gather(state: InvestigationState) -> InvestigationState:
        planned = state.get("plan", InvestigationPlan()).steps
        records: list[ToolRecord] = []

        async def run_step(step: Any) -> ToolRecord:
            await context.emit(
                "step.started",
                {"step": step.tool, "label": PROGRESS_LABELS.get(step.tool, step.tool)},
            )
            record = await context.runner.run(step.tool, dict(step.arguments))
            await context.emit(
                "tool.completed",
                {
                    "tool": record.tool,
                    "ok": record.ok,
                    "usable": record.usable,
                    "latencyMs": record.latency_ms,
                },
            )
            return record

        # Independent reads run concurrently: an investigation that takes a
        # minute because it queried four sources in series is a worse product.
        for record in await asyncio.gather(*(run_step(step) for step in planned)):
            context.ledger.record_tool(record)
            records.append(record)

        chunks = getattr(context.runner, "retrieved_chunks", [])
        if chunks:
            context.ledger.record_chunks(list(chunks))
        return {"tool_records": records}

    async def synthesize(state: InvestigationState) -> InvestigationState:
        await context.emit(
            "step.started", {"step": "synthesize", "label": "Analysing the evidence"}
        )
        evidence_text = _render_evidence(context.ledger)
        not_inspected = _render_not_inspected(context.ledger)

        request = LLMRequest(
            messages=[
                Message(role="system", content=SYSTEM),
                Message(
                    role="user",
                    content=SYNTHESIS.format(
                        question=context.question,
                        incident=wrap_untrusted(_incident_summary(context.incident)),
                        evidence=evidence_text,
                        not_inspected=not_inspected,
                    ),
                ),
            ],
            max_tokens=3000,
        )
        try:
            response = await context.llm.generate_structured(request, InvestigationResult)
        except MalformedOutputError as exc:
            logger.error("synthesis_failed", error=str(exc))
            return {
                "draft": InvestigationResult(
                    summary=(
                        "The investigation gathered evidence but could not produce a "
                        "structured conclusion. The evidence is listed below for review."
                    ),
                    confidence=0.0,
                ),
                "errors": [*state.get("errors", []), "synthesis produced invalid output"],
            }
        context.usage.append(response.usage)
        return {"draft": response.value}

    async def review(state: InvestigationState) -> InvestigationState:
        await context.emit("step.started", {"step": "review", "label": "Checking the answer"})
        draft = state.get("draft") or InvestigationResult(
            summary="No draft produced.", confidence=0.0
        )

        # Deterministic first: citations are checked against the ledger in code,
        # never by asking the model whether it told the truth.
        cleaned, removed = enforce_provenance(draft, context.ledger)

        verdict = ReviewVerdict()
        if cleaned.evidence:
            try:
                response = await context.llm.generate_structured(
                    LLMRequest(
                        messages=[
                            Message(role="system", content=SYSTEM),
                            Message(
                                role="user",
                                content=REVIEW.format(
                                    draft=cleaned.model_dump_json(indent=2),
                                    known_ids="\n".join(sorted(context.ledger.known_ids())),
                                ),
                            ),
                        ]
                    ),
                    ReviewVerdict,
                )
                verdict = response.value
                context.usage.append(response.usage)
            except MalformedOutputError:
                logger.warning("review_failed_open")

        if verdict.suggested_confidence is not None:
            cleaned = cleaned.model_copy(
                update={
                    "confidence": round(min(cleaned.confidence, verdict.suggested_confidence), 2)
                }
            )

        await context.emit(
            "review.completed",
            {
                "removed": len(removed),
                "problems": verdict.problems[:5],
                "confidence": cleaned.confidence,
            },
        )
        return {"result": cleaned, "review": verdict}

    graph = StateGraph(InvestigationState)
    graph.add_node("understand", understand)
    graph.add_node("plan", plan)
    graph.add_node("gather", gather)
    graph.add_node("synthesize", synthesize)
    graph.add_node("review", review)

    graph.add_edge(START, "understand")
    graph.add_edge("understand", "plan")
    graph.add_edge("plan", "gather")
    graph.add_edge("gather", "synthesize")
    graph.add_edge("synthesize", "review")
    graph.add_edge("review", END)
    return graph.compile()


def _fallback_plan(context: InvestigationContext) -> InvestigationPlan:
    services = context.incident.get("services") or []
    slug = services[0].get("slug") if services else None
    age = _incident_age_minutes(context.incident)
    if not slug:
        return InvestigationPlan(
            steps=[], rationale="No affected service recorded; nothing to inspect."
        )
    from .models import PlanStep

    return InvestigationPlan(
        rationale="Planner unavailable; using the standard first moves.",
        steps=[
            PlanStep(
                tool="get_deployments", arguments={"service": slug, "window_minutes": age + 120}
            ),
            PlanStep(
                tool="get_log_patterns", arguments={"service": slug, "window_minutes": age + 60}
            ),
            PlanStep(
                tool="get_metrics",
                arguments={"service": slug, "metric": "error_rate", "window_minutes": age + 120},
            ),
            PlanStep(tool="search_documents", arguments={"query": context.question}),
        ],
    )


def _render_evidence(ledger: Ledger) -> str:
    blocks: list[str] = []
    for record in ledger.tool_calls:
        if not record.usable:
            continue
        payload = json.dumps(record.result, default=str)[:4000]
        blocks.append(
            f"[source_id: {record.tool_call_id}] ({record.tool})\n{wrap_untrusted(payload)}"
        )
    for scored in ledger.chunks:
        heading = scored.chunk.heading_path or scored.chunk.title
        blocks.append(
            f"[source_id: {scored.chunk.chunk_id}] (document: {scored.chunk.title} > {heading})\n"
            f"{wrap_untrusted(scored.chunk.content[:2000])}"
        )
    return "\n\n".join(blocks) if blocks else "(no evidence was gathered)"


def _render_not_inspected(ledger: Ledger) -> str:
    unavailable = [*ledger.failed_tools(), *ledger.empty_tools()]
    if not unavailable:
        return ""
    return (
        "Sources that returned nothing or could not be read (say so in "
        f"not_inspected): {', '.join(sorted(set(unavailable)))}"
    )


async def run_investigation(
    context: InvestigationContext,
) -> tuple[InvestigationResult, dict[str, Any]]:
    """Runs the graph and returns the answer plus telemetry."""
    started = time.perf_counter()
    graph = build_investigation_graph(context)
    state: InvestigationState = await graph.ainvoke({})

    result = state.get("result") or InvestigationResult(
        summary="The investigation did not produce a result.", confidence=0.0
    )
    telemetry = {
        "promptVersion": PROMPT_VERSION,
        "model": context.llm.model,
        "provider": context.llm.name,
        "inputTokens": sum(usage.input_tokens for usage in context.usage),
        "outputTokens": sum(usage.output_tokens for usage in context.usage),
        "llmCalls": len(context.usage),
        "toolCalls": [
            {
                "tool": record.tool,
                "toolCallId": record.tool_call_id,
                "ok": record.ok,
                "latencyMs": record.latency_ms,
                "arguments": record.arguments,
            }
            for record in context.ledger.tool_calls
        ],
        "latencyMs": int((time.perf_counter() - started) * 1000),
        "errors": state.get("errors", []),
    }
    return result, telemetry
