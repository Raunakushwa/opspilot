"""Shared retrieval types. Every retrieved chunk carries enough provenance to
be cited and traced back to a document version."""

from pydantic import BaseModel, Field


class Chunk(BaseModel):
    """A retrievable passage."""

    chunk_id: str
    document_id: str
    document_version_id: str
    organization_id: str
    title: str
    document_type: str = "GENERAL"
    service_slug: str | None = None
    tags: list[str] = Field(default_factory=list)
    heading_path: str | None = None
    chunk_index: int = 0
    content: str


class ScoredChunk(BaseModel):
    chunk: Chunk
    score: float
    #: Which retrieval produced it, kept so hybrid behaviour can be inspected.
    source: str = "hybrid"


class SearchTiming(BaseModel):
    dense_ms: int = 0
    sparse_ms: int = 0
    fusion_ms: int = 0
    rerank_ms: int = 0

    @property
    def total_ms(self) -> int:
        return self.dense_ms + self.sparse_ms + self.fusion_ms + self.rerank_ms


class SearchResult(BaseModel):
    chunks: list[ScoredChunk]
    timing: SearchTiming = Field(default_factory=SearchTiming)
    candidates_considered: int = 0
