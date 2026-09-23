"""Hybrid retrieval against a real Qdrant instance.

The deterministic hashing embedder is used deliberately: these tests assert
pipeline behaviour (tenant filtering, idempotency, fusion, reranking), not the
quality of a particular embedding model.
"""

from collections.abc import AsyncIterator

import pytest
import pytest_asyncio
from qdrant_client import AsyncQdrantClient
from testcontainers.core.container import DockerContainer
from testcontainers.core.waiting_utils import wait_for_logs

from opspilot_ai.retrieval.embeddings import HashingEmbedder
from opspilot_ai.retrieval.rerank import LexicalReranker
from opspilot_ai.retrieval.store import QdrantSearchProvider, point_id
from opspilot_ai.service import IndexRequest, RetrievalService, SearchRequest

ACME = "org-acme"
GLOBEX = "org-globex"

RUNBOOK = """# Rolling back payment-service

## When to roll back
Roll back when the error rate exceeds 2% for five minutes and a deploy went out
in the preceding 30 minutes.

## Procedure
Run the rollback command with the previous version, then watch the error rate
for five minutes.
"""

POSTMORTEM = """# Postmortem: connection pool exhaustion

payment-service returned 5xx after a deploy reduced the database connection
pool. Requests queued for a connection and exceeded the acquisition timeout.
"""

UNRELATED = """# Notification templates

Template rendering caches are warmed on startup. Nothing here concerns
payments or databases.
"""

pytestmark = pytest.mark.integration


@pytest_asyncio.fixture(scope="module")
async def service() -> AsyncIterator[RetrievalService]:
    container = DockerContainer("qdrant/qdrant:v1.19.1").with_exposed_ports(6333)
    container.start()
    try:
        wait_for_logs(container, "Qdrant HTTP listening", timeout=90)
        url = f"http://{container.get_container_host_ip()}:{container.get_exposed_port(6333)}"
        client = AsyncQdrantClient(url=url)
        provider = QdrantSearchProvider(client, HashingEmbedder(), LexicalReranker())
        await provider.ensure_collection()
        retrieval = RetrievalService(provider)

        for organization, documents in (
            (
                ACME,
                [
                    ("runbook", "Rolling back payment-service", RUNBOOK, "RUNBOOK"),
                    (
                        "postmortem",
                        "Postmortem: connection pool exhaustion",
                        POSTMORTEM,
                        "POSTMORTEM",
                    ),
                    ("notifications", "Notification templates", UNRELATED, "GENERAL"),
                ],
            ),
            (GLOBEX, [("globex-runbook", "Globex payment rollback", RUNBOOK, "RUNBOOK")]),
        ):
            for doc_id, title, content, doc_type in documents:
                await retrieval.index_document_version(
                    IndexRequest(
                        organization_id=organization,
                        document_id=doc_id,
                        document_version_id=f"{doc_id}-v1",
                        title=title,
                        content=content,
                        document_type=doc_type,
                        service_slug="payment-service",
                    )
                )
        yield retrieval
        await client.close()
    finally:
        container.stop()


async def test_hybrid_search_finds_the_relevant_runbook(service: RetrievalService) -> None:
    result = await service.search(
        SearchRequest(organization_id=ACME, query="how do I roll back payment-service")
    )

    assert result.chunks
    assert "Rolling back payment-service" in result.chunks[0].chunk.title


async def test_results_never_cross_the_tenant_boundary(service: RetrievalService) -> None:
    # Globex indexed the same text; Acme must never see it.
    result = await service.search(
        SearchRequest(organization_id=ACME, query="payment rollback procedure", top_k=20)
    )

    assert result.chunks
    assert all(chunk.chunk.organization_id == ACME for chunk in result.chunks)
    assert all("Globex" not in chunk.chunk.title for chunk in result.chunks)


async def test_an_organization_with_no_documents_gets_nothing(service: RetrievalService) -> None:
    result = await service.search(
        SearchRequest(organization_id="org-empty", query="payment rollback")
    )

    assert result.chunks == []


async def test_hybrid_reports_both_retrievers_and_their_timings(
    service: RetrievalService,
) -> None:
    result = await service.search(
        SearchRequest(organization_id=ACME, query="connection pool timeout after deploy")
    )

    sources = {chunk.source for chunk in result.chunks}
    assert result.candidates_considered > 0
    assert result.timing.dense_ms >= 0
    assert result.timing.sparse_ms >= 0
    # Reranking is a separate stage and is measured separately.
    assert result.timing.rerank_ms >= 0
    assert sources


async def test_vector_and_keyword_modes_can_be_used_alone(service: RetrievalService) -> None:
    vector = await service.search(
        SearchRequest(organization_id=ACME, query="database pool exhaustion", mode="vector")
    )
    keyword = await service.search(
        SearchRequest(organization_id=ACME, query="database pool exhaustion", mode="keyword")
    )

    assert vector.chunks
    assert all(c.source == "dense" for c in vector.chunks)
    assert keyword.chunks
    assert all(c.source == "sparse" for c in keyword.chunks)


async def test_reindexing_the_same_version_is_idempotent(service: RetrievalService) -> None:
    before = await service.search(SearchRequest(organization_id=ACME, query="rollback", top_k=50))

    await service.index_document_version(
        IndexRequest(
            organization_id=ACME,
            document_id="runbook",
            document_version_id="runbook-v1",
            title="Rolling back payment-service",
            content=RUNBOOK,
            document_type="RUNBOOK",
        )
    )
    after = await service.search(SearchRequest(organization_id=ACME, query="rollback", top_k=50))

    assert len(after.chunks) == len(before.chunks)


async def test_a_new_version_replaces_the_old_one(service: RetrievalService) -> None:
    await service.index_document_version(
        IndexRequest(
            organization_id=ACME,
            document_id="runbook",
            document_version_id="runbook-v2",
            title="Rolling back payment-service",
            content="# Rolling back payment-service\n\nUse opsctl rollback with the canary flag.",
            document_type="RUNBOOK",
        )
    )

    result = await service.search(
        SearchRequest(organization_id=ACME, query="rollback canary flag", top_k=50)
    )

    versions = {chunk.chunk.document_version_id for chunk in result.chunks}
    assert "runbook-v1" not in versions
    assert "runbook-v2" in versions


def test_point_ids_are_deterministic() -> None:
    assert point_id("version-a", 3) == point_id("version-a", 3)
    assert point_id("version-a", 3) != point_id("version-a", 4)
