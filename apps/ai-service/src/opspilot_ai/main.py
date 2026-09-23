"""Production entry point: `uvicorn opspilot_ai.main:app`."""

from .app import create_app
from .clients.qdrant import create_qdrant_client, qdrant_check
from .config import get_settings
from .logging import configure_logging, get_logger
from .retrieval.embeddings import create_embedder
from .retrieval.rerank import create_reranker
from .retrieval.store import QdrantSearchProvider
from .service import RetrievalService

settings = get_settings()
configure_logging(settings.log_level, json_output=not settings.log_pretty)

logger = get_logger(__name__)

if settings.internal_api_token is None and settings.app_env == "production":
    # Fail loudly rather than serve an unauthenticated internal API.
    raise RuntimeError("INTERNAL_API_TOKEN is required when APP_ENV=production")

_qdrant = create_qdrant_client(settings)
_provider = QdrantSearchProvider(
    _qdrant,
    create_embedder(settings.embedding_provider),
    create_reranker(settings.reranker_provider),
)


async def _prepare() -> None:
    await _provider.ensure_collection()


app = create_app(
    settings=settings,
    checks=[qdrant_check(_qdrant)],
    on_shutdown=_qdrant.close,
    retrieval=RetrievalService(_provider),
    on_startup=_prepare,
)
