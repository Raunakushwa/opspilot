"""The agent's view of its tools.

Two kinds, deliberately: `search_documents` is served by this service (it owns
the vector index), everything else goes through the API's tool gateway, which
re-checks authorization on every call. The agent cannot reach tenant data any
other way.
"""

from typing import Any, Protocol

import httpx

from opspilot_ai.logging import get_logger
from opspilot_ai.retrieval.models import ScoredChunk
from opspilot_ai.service import RetrievalService, SearchRequest

from .ledger import ToolRecord

logger = get_logger(__name__)

PROGRESS_LABELS = {
    "search_documents": "Searching runbooks and postmortems",
    "search_incidents": "Searching incident history",
    "get_incident": "Reading the incident",
    "get_service": "Looking up the service",
    "get_deployments": "Checking deployment history",
    "get_logs": "Reading logs",
    "get_log_patterns": "Grouping error patterns",
    "get_metrics": "Inspecting metrics",
    "get_previous_postmortems": "Looking for past postmortems",
}

TOOL_DESCRIPTIONS = {
    "search_documents": (
        "Semantic + keyword search over runbooks, postmortems and architecture "
        "docs. Arguments: query (string)."
    ),
    "search_incidents": (
        "Full-text search over this organization's incidents, past and present. "
        "Arguments: query (string)."
    ),
    "get_incident": (
        "Fetch one incident with its affected services. Arguments: incident_id (uuid)."
    ),
    "get_service": "Fetch a service by slug. Arguments: service (slug).",
    "get_deployments": (
        "Recent deployments for a service, newest first. "
        "Arguments: service (slug), window_minutes (int)."
    ),
    "get_logs": (
        "Raw log lines for a service. "
        "Arguments: service (slug), window_minutes (int), query (optional string)."
    ),
    "get_log_patterns": (
        "Error and warning messages grouped with counts and first/last seen. "
        "Arguments: service (slug), window_minutes (int)."
    ),
    "get_metrics": (
        "Time series for one metric. "
        "Arguments: service (slug), metric (error_rate|latency_p95_ms), window_minutes (int)."
    ),
    "get_previous_postmortems": ("List postmortem documents. Arguments: query (optional string)."),
}
AVAILABLE_TOOLS = list(TOOL_DESCRIPTIONS)


class ToolRunner(Protocol):
    async def run(self, tool: str, arguments: dict[str, Any]) -> ToolRecord: ...


class GatewayToolRunner:
    """Calls the API's tool gateway with the run's delegation token."""

    def __init__(
        self,
        base_url: str,
        token: str,
        retrieval: RetrievalService,
        organization_id: str,
        timeout_s: float = 30.0,
    ) -> None:
        self._base_url = base_url.rstrip("/")
        self._token = token
        self._retrieval = retrieval
        self._organization_id = organization_id
        self._timeout = timeout_s
        self.retrieved_chunks: list[ScoredChunk] = []

    async def run(self, tool: str, arguments: dict[str, Any]) -> ToolRecord:
        if tool == "search_documents":
            return await self._search_documents(arguments)
        return await self._call_gateway(tool, arguments)

    async def _search_documents(self, arguments: dict[str, Any]) -> ToolRecord:
        query = str(arguments.get("query") or "").strip()
        if not query:
            return ToolRecord(
                tool_call_id="",
                tool="search_documents",
                arguments=arguments,
                ok=False,
                error="query is required",
            )
        result = await self._retrieval.search(
            SearchRequest(organization_id=self._organization_id, query=query, top_k=6)
        )
        # Chunks are their own ledger entries: a document citation points at the
        # passage that was read, not at the search that found it.
        self.retrieved_chunks.extend(result.chunks)
        return ToolRecord(
            tool_call_id=f"search:{query[:40]}",
            tool="search_documents",
            arguments=arguments,
            ok=True,
            result=[
                {
                    "chunk_id": scored.chunk.chunk_id,
                    "title": scored.chunk.title,
                    "heading": scored.chunk.heading_path,
                    "content": scored.chunk.content,
                    "score": round(scored.score, 3),
                }
                for scored in result.chunks
            ],
            latency_ms=result.timing.total_ms,
        )

    async def _call_gateway(self, tool: str, arguments: dict[str, Any]) -> ToolRecord:
        try:
            async with httpx.AsyncClient(timeout=self._timeout) as client:
                response = await client.post(
                    f"{self._base_url}/internal/tools/{tool}",
                    headers={"authorization": f"Bearer {self._token}"},
                    json={"args": arguments},
                )
        except httpx.HTTPError as exc:
            return ToolRecord(
                tool_call_id="", tool=tool, arguments=arguments, ok=False, error=str(exc)
            )

        if response.status_code >= 400:
            # A refusal is recorded, not hidden: the answer must be able to say
            # which sources it could not read.
            logger.warning("tool_call_rejected", tool=tool, status=response.status_code)
            return ToolRecord(
                tool_call_id="",
                tool=tool,
                arguments=arguments,
                ok=False,
                error=f"gateway returned {response.status_code}",
            )

        body = response.json()
        return ToolRecord(
            tool_call_id=str(body.get("toolCallId") or ""),
            tool=tool,
            arguments=arguments,
            ok=bool(body.get("ok")),
            result=body.get("result"),
            latency_ms=int(body.get("latencyMs") or 0),
        )
