"""Running an investigation on behalf of the worker."""

import time
from typing import Any

from pydantic import BaseModel, Field

from .agent.graph import InvestigationContext, run_investigation
from .agent.models import InvestigationResult
from .agent.tools import GatewayToolRunner
from .config import Settings
from .llm.base import LLMProvider
from .logging import get_logger
from .progress import ProgressPublisher
from .service import RetrievalService

logger = get_logger(__name__)


class RunInvestigationRequest(BaseModel):
    run_id: str
    organization_id: str
    user_id: str
    question: str = Field(min_length=3, max_length=1000)
    incident: dict[str, Any]
    #: Short-lived delegation token minted by the API for this run.
    delegation_token: str


class RunInvestigationResponse(BaseModel):
    result: InvestigationResult
    telemetry: dict[str, Any]


class InvestigationRunner:
    def __init__(
        self,
        settings: Settings,
        llm: LLMProvider,
        retrieval: RetrievalService,
        progress: ProgressPublisher,
    ) -> None:
        self._settings = settings
        self._llm = llm
        self._retrieval = retrieval
        self._progress = progress

    async def run(self, request: RunInvestigationRequest) -> RunInvestigationResponse:
        started = time.perf_counter()

        async def emit(event: str, payload: dict[str, Any]) -> None:
            await self._progress.publish(request.run_id, event, payload)

        runner = GatewayToolRunner(
            base_url=self._settings.tool_gateway_url,
            token=request.delegation_token,
            retrieval=self._retrieval,
            organization_id=request.organization_id,
        )

        await emit("run.started", {"question": request.question})
        context = InvestigationContext(
            run_id=request.run_id,
            organization_id=request.organization_id,
            user_id=request.user_id,
            incident=request.incident,
            question=request.question,
            llm=self._llm,
            runner=runner,
            emit=emit,
        )

        try:
            result, telemetry = await run_investigation(context)
        except Exception as exc:
            logger.exception("investigation_failed", run_id=request.run_id)
            await emit("run.failed", {"error": "The investigation could not be completed"})
            raise exc

        await emit(
            "run.completed",
            {
                "confidence": result.confidence,
                "summary": result.summary,
                "citations": len(result.citations),
            },
        )
        telemetry["totalMs"] = int((time.perf_counter() - started) * 1000)
        logger.info(
            "investigation_completed",
            run_id=request.run_id,
            confidence=result.confidence,
            tool_calls=len(telemetry.get("toolCalls", [])),
            total_ms=telemetry["totalMs"],
        )
        return RunInvestigationResponse(result=result, telemetry=telemetry)
