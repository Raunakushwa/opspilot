"""Qdrant-backed search provider.

The organization filter is applied here, from the caller's verified context —
never from anything a model produced. A query without an organization is a
programming error, not a wildcard.
"""

import time
import uuid
from typing import Protocol

from qdrant_client import AsyncQdrantClient, models

from opspilot_ai.logging import get_logger

from .embeddings import Embedder
from .fusion import reciprocal_rank_fusion
from .models import Chunk, ScoredChunk, SearchResult, SearchTiming
from .rerank import Reranker

logger = get_logger(__name__)

COLLECTION = "opspilot_chunks"
DENSE_VECTOR = "dense"
SPARSE_VECTOR = "sparse"

#: Fixed namespace: a point id derived from (version, index) makes re-indexing
#: idempotent instead of duplicating chunks.
POINT_NAMESPACE = uuid.UUID("2b1d4f66-0e5a-4a3b-9a1e-6c2f0f1a7d33")


def point_id(document_version_id: str, chunk_index: int) -> str:
    return str(uuid.uuid5(POINT_NAMESPACE, f"{document_version_id}:{chunk_index}"))


class SearchProvider(Protocol):
    async def search_vector(
        self, query: str, organization_id: str, limit: int
    ) -> list[ScoredChunk]: ...

    async def search_keyword(
        self, query: str, organization_id: str, limit: int
    ) -> list[ScoredChunk]: ...

    async def search_hybrid(
        self, query: str, organization_id: str, *, candidates: int, top_k: int
    ) -> SearchResult: ...


class QdrantSearchProvider:
    def __init__(
        self,
        client: AsyncQdrantClient,
        embedder: Embedder,
        reranker: Reranker,
        collection: str = COLLECTION,
    ) -> None:
        self._client = client
        self._embedder = embedder
        self._reranker = reranker
        self._collection = collection

    async def ensure_collection(self) -> None:
        """Creates the collection and the tenant payload index if missing."""
        if not await self._client.collection_exists(self._collection):
            await self._client.create_collection(
                collection_name=self._collection,
                vectors_config={
                    DENSE_VECTOR: models.VectorParams(
                        size=self._embedder.dimensions, distance=models.Distance.COSINE
                    )
                },
                sparse_vectors_config={SPARSE_VECTOR: models.SparseVectorParams()},
            )
        # is_tenant lets Qdrant co-locate one organization's points, which keeps
        # filtered search fast as the number of organizations grows.
        await self._client.create_payload_index(
            collection_name=self._collection,
            field_name="organization_id",
            field_schema=models.KeywordIndexParams(
                type=models.KeywordIndexType.KEYWORD, is_tenant=True
            ),
        )

    async def upsert_chunks(self, chunks: list[Chunk]) -> int:
        if not chunks:
            return 0
        texts = [chunk.content for chunk in chunks]
        dense = self._embedder.embed_documents(texts)
        sparse = self._embedder.embed_documents_sparse(texts)

        points = [
            models.PointStruct(
                id=point_id(chunk.document_version_id, chunk.chunk_index),
                vector={
                    DENSE_VECTOR: dense_vector,
                    SPARSE_VECTOR: models.SparseVector(
                        indices=list(sparse_vector.keys()), values=list(sparse_vector.values())
                    ),
                },
                payload=chunk.model_dump(),
            )
            for chunk, dense_vector, sparse_vector in zip(chunks, dense, sparse, strict=True)
        ]
        await self._client.upsert(collection_name=self._collection, points=points, wait=True)
        return len(points)

    async def delete_document(self, organization_id: str, document_id: str) -> None:
        await self._client.delete(
            collection_name=self._collection,
            points_selector=models.FilterSelector(filter=_filter(organization_id, document_id)),
            wait=True,
        )

    async def delete_other_versions(
        self, organization_id: str, document_id: str, keep_version_id: str
    ) -> None:
        """Removes superseded versions once the new one is indexed.

        Ordering matters: deleting first would leave a window in which the
        document is unsearchable.
        """
        await self._client.delete(
            collection_name=self._collection,
            points_selector=models.FilterSelector(
                filter=models.Filter(
                    must=[
                        models.FieldCondition(
                            key="organization_id",
                            match=models.MatchValue(value=organization_id),
                        ),
                        models.FieldCondition(
                            key="document_id", match=models.MatchValue(value=document_id)
                        ),
                    ],
                    must_not=[
                        models.FieldCondition(
                            key="document_version_id",
                            match=models.MatchValue(value=keep_version_id),
                        )
                    ],
                )
            ),
            wait=True,
        )

    async def search_vector(
        self, query: str, organization_id: str, limit: int
    ) -> list[ScoredChunk]:
        response = await self._client.query_points(
            collection_name=self._collection,
            query=self._embedder.embed_query(query),
            using=DENSE_VECTOR,
            query_filter=_filter(organization_id),
            limit=limit,
            with_payload=True,
        )
        return _to_chunks(response.points, "dense")

    async def search_keyword(
        self, query: str, organization_id: str, limit: int
    ) -> list[ScoredChunk]:
        sparse = self._embedder.embed_query_sparse(query)
        if not sparse:
            return []
        response = await self._client.query_points(
            collection_name=self._collection,
            query=models.SparseVector(indices=list(sparse.keys()), values=list(sparse.values())),
            using=SPARSE_VECTOR,
            query_filter=_filter(organization_id),
            limit=limit,
            with_payload=True,
        )
        return _to_chunks(response.points, "sparse")

    async def search_hybrid(
        self, query: str, organization_id: str, *, candidates: int = 30, top_k: int = 8
    ) -> SearchResult:
        started = time.perf_counter()
        dense = await self.search_vector(query, organization_id, candidates)
        dense_ms = int((time.perf_counter() - started) * 1000)

        sparse_started = time.perf_counter()
        sparse = await self.search_keyword(query, organization_id, candidates)
        sparse_ms = int((time.perf_counter() - sparse_started) * 1000)

        fusion_started = time.perf_counter()
        merged = reciprocal_rank_fusion({"dense": dense, "sparse": sparse})
        fusion_ms = int((time.perf_counter() - fusion_started) * 1000)

        rerank_started = time.perf_counter()
        reranked = self._reranker.rerank(query, merged, top_k)
        rerank_ms = int((time.perf_counter() - rerank_started) * 1000)

        return SearchResult(
            chunks=reranked,
            candidates_considered=len(merged),
            timing=SearchTiming(
                dense_ms=dense_ms, sparse_ms=sparse_ms, fusion_ms=fusion_ms, rerank_ms=rerank_ms
            ),
        )


def _filter(organization_id: str, document_id: str | None = None) -> models.Filter:
    conditions: list[models.Condition] = [
        models.FieldCondition(key="organization_id", match=models.MatchValue(value=organization_id))
    ]
    if document_id:
        conditions.append(
            models.FieldCondition(key="document_id", match=models.MatchValue(value=document_id))
        )
    return models.Filter(must=conditions)


def _to_chunks(points: list[models.ScoredPoint], source: str) -> list[ScoredChunk]:
    results: list[ScoredChunk] = []
    for point in points:
        if not point.payload:
            continue
        results.append(
            ScoredChunk(
                chunk=Chunk.model_validate(point.payload), score=float(point.score), source=source
            )
        )
    return results
