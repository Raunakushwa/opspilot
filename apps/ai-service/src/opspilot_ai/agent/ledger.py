"""The provenance ledger.

Every tool call and every retrieved chunk is recorded here with an id. The
answer may only cite ids that appear in the ledger, and that rule is enforced
in code — not requested of the model in a prompt.

This is what backs the product promise that the assistant never claims to have
inspected something it did not.
"""

from dataclasses import dataclass, field
from typing import Any

from opspilot_ai.retrieval.models import ScoredChunk

from .models import Citation, SourceType


@dataclass
class ToolRecord:
    tool_call_id: str
    tool: str
    arguments: dict[str, Any]
    ok: bool
    result: Any = None
    error: str | None = None
    latency_ms: int = 0

    @property
    def usable(self) -> bool:
        """A failed or empty call is not evidence of anything."""
        if not self.ok:
            return False
        if self.result is None:
            return False
        return not (isinstance(self.result, list | dict) and len(self.result) == 0)


TOOL_SOURCE_TYPES: dict[str, SourceType] = {
    "search_incidents": SourceType.INCIDENT,
    "get_incident": SourceType.INCIDENT,
    "get_service": SourceType.SERVICE,
    "get_deployments": SourceType.DEPLOYMENT,
    "get_logs": SourceType.LOG,
    "get_log_patterns": SourceType.LOG,
    "get_metrics": SourceType.METRIC,
    "get_previous_postmortems": SourceType.DOCUMENT,
    "search_documents": SourceType.DOCUMENT,
}


@dataclass
class Ledger:
    tool_calls: list[ToolRecord] = field(default_factory=list)
    chunks: list[ScoredChunk] = field(default_factory=list)

    def record_tool(self, record: ToolRecord) -> None:
        self.tool_calls.append(record)

    def record_chunks(self, chunks: list[ScoredChunk]) -> None:
        self.chunks.extend(chunks)

    def known_ids(self) -> set[str]:
        """Ids an answer is allowed to cite."""
        return {record.tool_call_id for record in self.tool_calls if record.usable} | {
            chunk.chunk.chunk_id for chunk in self.chunks
        }

    def label_for(self, source_id: str) -> str | None:
        for chunk in self.chunks:
            if chunk.chunk.chunk_id == source_id:
                heading = chunk.chunk.heading_path
                return f"{chunk.chunk.title} > {heading}" if heading else chunk.chunk.title
        for record in self.tool_calls:
            if record.tool_call_id == source_id:
                return f"{record.tool}({_describe(record.arguments)})"
        return None

    def source_type_for(self, source_id: str) -> SourceType:
        for chunk in self.chunks:
            if chunk.chunk.chunk_id == source_id:
                return SourceType.DOCUMENT
        for record in self.tool_calls:
            if record.tool_call_id == source_id:
                return TOOL_SOURCE_TYPES.get(record.tool, SourceType.DOCUMENT)
        return SourceType.DOCUMENT

    def citations(self, source_ids: list[str]) -> list[Citation]:
        citations: list[Citation] = []
        for source_id in dict.fromkeys(source_ids):
            label = self.label_for(source_id)
            if label is None:
                continue
            citations.append(
                Citation(
                    source_id=source_id, label=label, source_type=self.source_type_for(source_id)
                )
            )
        return citations

    def failed_tools(self) -> list[str]:
        return [record.tool for record in self.tool_calls if not record.ok]

    def empty_tools(self) -> list[str]:
        return [record.tool for record in self.tool_calls if record.ok and not record.usable]


def _describe(arguments: dict[str, Any]) -> str:
    return ", ".join(f"{key}={value}" for key, value in list(arguments.items())[:3])
