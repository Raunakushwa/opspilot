"""Qdrant access. The vector index is rebuildable from PostgreSQL, so this
client is never a source of truth."""

from qdrant_client import AsyncQdrantClient

from opspilot_ai.config import Settings
from opspilot_ai.health import DependencyCheck


def create_qdrant_client(settings: Settings) -> AsyncQdrantClient:
    return AsyncQdrantClient(
        url=str(settings.qdrant_url),
        api_key=settings.qdrant_api_key,
        timeout=int(settings.readiness_timeout_ms / 1000) or 1,
    )


def qdrant_check(client: AsyncQdrantClient) -> DependencyCheck:
    async def check() -> None:
        # Lists collections rather than pinging: it also proves the API key works.
        await client.get_collections()

    return DependencyCheck(name="qdrant", check=check)
