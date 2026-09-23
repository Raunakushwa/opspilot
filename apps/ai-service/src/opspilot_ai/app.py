"""FastAPI application factory.

Dependencies are injected so tests can exercise the real HTTP stack without a
Qdrant instance.
"""

import re
import uuid
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request, Response

from .config import Settings, get_settings
from .errors import register_error_handlers
from .health import DependencyCheck, run_readiness
from .logging import get_logger, request_id_var
from .routes import register_retrieval_routes
from .service import RetrievalService

REQUEST_ID_HEADER = "x-request-id"
# Same rule as the Node API: accept a caller ID only if it is short and log-safe.
SAFE_REQUEST_ID = re.compile(r"^[\w.-]{1,128}$")

logger = get_logger(__name__)


def create_app(
    settings: Settings | None = None,
    checks: list[DependencyCheck] | None = None,
    on_shutdown: Callable[[], Awaitable[None]] | None = None,
    retrieval: RetrievalService | None = None,
    on_startup: Callable[[], Awaitable[None]] | None = None,
) -> FastAPI:
    resolved = settings or get_settings()
    dependency_checks = checks if checks is not None else []

    @asynccontextmanager
    async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
        if on_startup is not None:
            await on_startup()
        logger.info("ai_service_started", env=resolved.app_env)
        yield
        if on_shutdown is not None:
            await on_shutdown()

    app = FastAPI(
        title="OpsPilot AI Service",
        version="0.0.0",
        lifespan=lifespan,
        # Internal service: no public docs surface by default.
        docs_url="/internal/docs" if resolved.app_env != "production" else None,
        redoc_url=None,
    )

    @app.middleware("http")
    async def request_context(
        request: Request, call_next: Callable[[Request], Awaitable[Response]]
    ) -> Response:
        incoming = request.headers.get(REQUEST_ID_HEADER)
        request_id = incoming if incoming and SAFE_REQUEST_ID.match(incoming) else str(uuid.uuid4())
        token = request_id_var.set(request_id)
        try:
            response = await call_next(request)
        finally:
            request_id_var.reset(token)
        response.headers[REQUEST_ID_HEADER] = request_id
        return response

    register_error_handlers(app)

    @app.get("/healthz")
    async def healthz() -> dict[str, str]:
        """Liveness: process is up. Never touches dependencies."""
        return {"status": "ok"}

    if retrieval is not None:
        register_retrieval_routes(app, retrieval, resolved)

    @app.get("/readyz")
    async def readyz(response: Response) -> dict[str, object]:
        """Readiness: this instance can reach everything it needs."""
        report = await run_readiness(dependency_checks, resolved.readiness_timeout_ms)
        response.status_code = 200 if report.status == "ok" else 503
        return report.model_dump()

    return app
