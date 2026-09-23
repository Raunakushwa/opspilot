"""Retrieval service: chunk, index and search.

The worker sends document text here; this service never reads the database
itself, which is what keeps domain data behind the API's authorization.
"""

import time

from pydantic import BaseModel, Field

from .logging import get_logger
from .retrieval.chunking import chunk_markdown
from .retrieval.models import Chunk, SearchResult
from .retrieval.store import QdrantSearchProvider

logger = get_logger(__name__)


class IndexRequest(BaseModel):
    organization_id: str
    document_id: str
    document_version_id: str
    title: str
    content: str
    document_type: str = "GENERAL"
    service_slug: str | None = None
    tags: list[str] = Field(default_factory=list)


class IndexResponse(BaseModel):
    chunks_indexed: int
    took_ms: int


class SearchRequest(BaseModel):
    organization_id: str
    query: str = Field(min_length=1, max_length=2000)
    candidates: int = Field(default=30, ge=1, le=200)
    top_k: int = Field(default=8, ge=1, le=50)
    mode: str = Field(default="hybrid", pattern="^(hybrid|vector|keyword)$")


class RetrievalService:
    def __init__(self, provider: QdrantSearchProvider) -> None:
        self._provider = provider

    async def index_document_version(self, request: IndexRequest) -> IndexResponse:
        started = time.perf_counter()
        pieces = chunk_markdown(request.content)
        chunks = [
            Chunk(
                chunk_id=f"{request.document_version_id}:{piece.index}",
                document_id=request.document_id,
                document_version_id=request.document_version_id,
                organization_id=request.organization_id,
                title=request.title,
                document_type=request.document_type,
                service_slug=request.service_slug,
                tags=request.tags,
                heading_path=piece.heading_path,
                chunk_index=piece.index,
                content=piece.content,
            )
            for piece in pieces
        ]

        indexed = await self._provider.upsert_chunks(chunks)
        # Only after the new version is searchable: deleting first would leave a
        # window where the document cannot be found at all.
        await self._provider.delete_other_versions(
            request.organization_id, request.document_id, request.document_version_id
        )

        took_ms = int((time.perf_counter() - started) * 1000)
        logger.info(
            "document_indexed",
            document_id=request.document_id,
            version_id=request.document_version_id,
            chunks=indexed,
            took_ms=took_ms,
        )
        return IndexResponse(chunks_indexed=indexed, took_ms=took_ms)

    async def search(self, request: SearchRequest) -> SearchResult:
        if request.mode == "vector":
            chunks = await self._provider.search_vector(
                request.query, request.organization_id, request.top_k
            )
            return SearchResult(chunks=chunks, candidates_considered=len(chunks))
        if request.mode == "keyword":
            chunks = await self._provider.search_keyword(
                request.query, request.organization_id, request.top_k
            )
            return SearchResult(chunks=chunks, candidates_considered=len(chunks))
        return await self._provider.search_hybrid(
            request.query,
            request.organization_id,
            candidates=request.candidates,
            top_k=request.top_k,
        )
