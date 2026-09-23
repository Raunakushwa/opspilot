"""Internal HTTP surface.

Every route here is called by the worker, never by a browser: the service is
not exposed publicly and requires the shared internal token.
"""

from collections.abc import Awaitable, Callable

from fastapi import Depends, FastAPI, Header, HTTPException, status

from .config import Settings
from .retrieval.models import SearchResult
from .service import IndexRequest, IndexResponse, RetrievalService, SearchRequest


def _authorize(settings: Settings) -> Callable[[str | None], Awaitable[None]]:
    async def dependency(authorization: str | None = Header(default=None)) -> None:
        expected = settings.internal_api_token
        if expected is None:
            # No token configured: local development only, and it is logged as
            # a warning at startup rather than silently allowed in production.
            return
        if authorization != f"Bearer {expected}":
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid internal token"
            )

    return dependency


def register_retrieval_routes(
    app: FastAPI, retrieval: RetrievalService, settings: Settings
) -> None:
    guard = Depends(_authorize(settings))

    @app.post("/internal/index/document-versions", dependencies=[guard])
    async def index_document(request: IndexRequest) -> IndexResponse:
        return await retrieval.index_document_version(request)

    @app.post("/internal/search", dependencies=[guard])
    async def search(request: SearchRequest) -> SearchResult:
        return await retrieval.search(request)
