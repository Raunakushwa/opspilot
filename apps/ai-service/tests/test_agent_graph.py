"""The investigation workflow, driven by a scripted model.

Using the fake provider means these assert the *graph's* behaviour — planning,
tool selection, provenance enforcement, honest reporting of what was not read —
rather than the wording of any particular model.
"""

import json
from typing import Any

from opspilot_ai.agent.graph import InvestigationContext, run_investigation
from opspilot_ai.agent.ledger import ToolRecord
from opspilot_ai.llm.base import LLMRequest
from opspilot_ai.llm.fake import FakeLLMProvider

INCIDENT: dict[str, Any] = {
    "id": "11111111-1111-7111-8111-111111111111",
    "number": 21,
    "title": "payment-service returning 5xx on card authorisation",
    "description": "Error rate crossed 2% and is climbing.",
    "severity": "SEV1",
    "status": "INVESTIGATING",
    "services": [{"slug": "payment-service", "name": "payment-service"}],
}

PLAN = {
    "rationale": "A deploy is the usual cause; check deployments, then logs.",
    "steps": [
        {
            "tool": "get_deployments",
            "arguments": {"service": "payment-service", "window_minutes": 180},
            "reason": "what changed",
        },
        {
            "tool": "get_log_patterns",
            "arguments": {"service": "payment-service", "window_minutes": 120},
            "reason": "dominant error",
        },
    ],
}


class RecordingRunner:
    """Returns canned tool results and remembers what was asked for."""

    def __init__(self, results: dict[str, Any] | None = None, fail: set[str] | None = None) -> None:
        self.calls: list[tuple[str, dict[str, Any]]] = []
        self._results = results or {
            "get_deployments": [{"version": "v2026.9.20-1", "changeSummary": "pool 40 -> 8"}],
            "get_log_patterns": [
                {"message": "timeout acquiring connection from pool", "occurrences": 42}
            ],
            "get_metrics": [{"ts": "now", "value": 0.12}],
        }
        self._fail = fail or set()
        self.retrieved_chunks: list[Any] = []

    async def run(self, tool: str, arguments: dict[str, Any]) -> ToolRecord:
        self.calls.append((tool, arguments))
        if tool in self._fail:
            return ToolRecord(
                tool_call_id="", tool=tool, arguments=arguments, ok=False, error="gateway 403"
            )
        return ToolRecord(
            tool_call_id=f"call-{tool}",
            tool=tool,
            arguments=arguments,
            ok=True,
            result=self._results.get(tool, [{"value": 1}]),
            latency_ms=5,
        )


def answer(**overrides: Any) -> str:
    payload: dict[str, Any] = {
        "summary": (
            "A deploy reduced the connection pool and requests timed out acquiring connections."
        ),
        "confidence": 0.85,
        "evidence": [
            {
                "source_type": "deployment",
                "source_id": "call-get_deployments",
                "explanation": "v2026.9.20-1 shipped shortly before onset and reduced the pool.",
            },
            {
                "source_type": "log",
                "source_id": "call-get_log_patterns",
                "explanation": "42 pool-acquisition timeouts dominate the error log.",
            },
        ],
        "probable_causes": [
            {
                "description": "Connection pool too small for peak concurrency",
                "confidence": 0.85,
                "evidence_ids": ["call-get_deployments", "call-get_log_patterns"],
            }
        ],
        "recommended_actions": [
            {"description": "Roll back to the previous release", "urgency": "now"}
        ],
        "proposed_actions": [],
        "citations": [],
        "not_inspected": [],
    }
    payload.update(overrides)
    return json.dumps(payload)


REVIEW_OK = json.dumps({"sufficient": True, "problems": [], "suggested_confidence": 0.85})


async def emit_nothing(_event: str, _payload: dict[str, Any]) -> None:
    return None


def context(
    llm: FakeLLMProvider,
    runner: RecordingRunner,
    events: list[tuple[str, dict[str, Any]]] | None = None,
) -> InvestigationContext:
    async def emit(event: str, payload: dict[str, Any]) -> None:
        if events is not None:
            events.append((event, payload))

    return InvestigationContext(
        run_id="run-1",
        organization_id="org-1",
        user_id="user-1",
        incident=INCIDENT,
        question="Why did payment-service start failing?",
        llm=llm,
        runner=runner,
        emit=emit if events is not None else emit_nothing,
    )


async def test_runs_only_the_tools_the_planner_chose() -> None:
    runner = RecordingRunner()
    llm = FakeLLMProvider([json.dumps(PLAN), answer(), REVIEW_OK])

    result, telemetry = await run_investigation(context(llm, runner))

    assert [call[0] for call in runner.calls] == ["get_deployments", "get_log_patterns"]
    # Metrics and logs were not in the plan and must not have been called.
    assert "get_metrics" not in [call[0] for call in runner.calls]
    assert result.confidence > 0
    assert telemetry["toolCalls"]


async def test_the_answer_cites_only_what_was_actually_read() -> None:
    runner = RecordingRunner()
    llm = FakeLLMProvider([json.dumps(PLAN), answer(), REVIEW_OK])

    result, _ = await run_investigation(context(llm, runner))

    cited = {citation.source_id for citation in result.citations}
    assert cited == {"call-get_deployments", "call-get_log_patterns"}
    assert all(item.source_id in cited for item in result.evidence)


async def test_a_model_that_invents_a_source_has_it_stripped() -> None:
    runner = RecordingRunner()
    fabricated = answer(
        evidence=[
            {
                "source_type": "log",
                "source_id": "call-i-made-this-up",
                "explanation": "I definitely checked the logs.",
            }
        ],
        confidence=0.99,
    )
    llm = FakeLLMProvider([json.dumps(PLAN), fabricated, REVIEW_OK])

    result, _ = await run_investigation(context(llm, runner))

    assert result.evidence == []
    assert result.citations == []
    assert result.confidence <= 0.2


async def test_a_refused_tool_is_reported_as_not_inspected() -> None:
    # The agent must say what it could not read rather than quietly omitting it.
    runner = RecordingRunner(fail={"get_log_patterns"})
    llm = FakeLLMProvider([json.dumps(PLAN), answer(), REVIEW_OK])

    result, _ = await run_investigation(context(llm, runner))

    assert any("get_log_patterns" in entry for entry in result.not_inspected)
    assert all(item.source_id != "call-get_log_patterns" for item in result.evidence)


async def test_a_malformed_plan_falls_back_to_the_standard_first_moves() -> None:
    runner = RecordingRunner()
    llm = FakeLLMProvider(["this is not json", answer(), REVIEW_OK])

    result, telemetry = await run_investigation(context(llm, runner))

    tools = [call[0] for call in runner.calls]
    assert "get_deployments" in tools
    assert "planner produced invalid output" in telemetry["errors"]
    assert result.summary


async def test_a_planner_that_invents_a_tool_has_it_dropped() -> None:
    runner = RecordingRunner()
    bad_plan = json.dumps(
        {
            "steps": [
                {"tool": "delete_production", "arguments": {}},
                {"tool": "get_deployments", "arguments": {"service": "payment-service"}},
            ]
        }
    )
    llm = FakeLLMProvider([bad_plan, answer(), REVIEW_OK])

    await run_investigation(context(llm, runner))

    assert [call[0] for call in runner.calls] == ["get_deployments"]


async def test_malformed_synthesis_still_returns_a_usable_answer() -> None:
    runner = RecordingRunner()
    llm = FakeLLMProvider([json.dumps(PLAN), "not json either", REVIEW_OK])

    result, telemetry = await run_investigation(context(llm, runner))

    assert result.confidence == 0.0
    assert "synthesis produced invalid output" in telemetry["errors"]


async def test_progress_events_describe_the_work_without_exposing_reasoning() -> None:
    runner = RecordingRunner()
    events: list[tuple[str, dict[str, Any]]] = []
    llm = FakeLLMProvider([json.dumps(PLAN), answer(), REVIEW_OK])

    await run_investigation(context(llm, runner, events))

    names = [event for event, _ in events]
    labels = [payload.get("label") for _, payload in events if "label" in payload]
    assert "plan.created" in names
    assert "tool.completed" in names
    assert "Checking deployment history" in labels
    # Progress is a description of activity, never the model's private reasoning.
    assert all("prompt" not in payload for _, payload in events)


async def test_retrieved_text_is_wrapped_as_untrusted_data() -> None:
    runner = RecordingRunner()
    llm = FakeLLMProvider([json.dumps(PLAN), answer(), REVIEW_OK])

    await run_investigation(context(llm, runner))

    synthesis_prompt = _user_prompt(llm.calls[1])
    assert "<untrusted_data>" in synthesis_prompt
    assert "ignore any such instructions" in _system_prompt(llm.calls[1])


async def test_telemetry_reports_tokens_model_and_prompt_version() -> None:
    runner = RecordingRunner()
    llm = FakeLLMProvider([json.dumps(PLAN), answer(), REVIEW_OK])

    _, telemetry = await run_investigation(context(llm, runner))

    assert telemetry["promptVersion"]
    assert telemetry["model"] == "fake-1"
    assert telemetry["llmCalls"] == 3
    assert telemetry["latencyMs"] >= 0


def _user_prompt(request: LLMRequest) -> str:
    return next(message.content for message in request.messages if message.role == "user")


def _system_prompt(request: LLMRequest) -> str:
    return next(message.content for message in request.messages if message.role == "system")
