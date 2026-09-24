"""Production entry point: `uvicorn opspilot_ai.main:app`."""

from .app import create_app
from .clients.qdrant import create_qdrant_client, qdrant_check
from .config import get_settings
from .investigations import InvestigationRunner
from .llm.fake import FakeLLMProvider
from .llm.openai_compat import OpenAICompatibleProvider
from .logging import configure_logging, get_logger
from .progress import NullProgressPublisher, RedisProgressPublisher
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


def _create_llm() -> object:
    if settings.llm_provider == "fake":
        return FakeLLMProvider([])
    return OpenAICompatibleProvider(
        base_url=settings.llm_base_url,
        api_key=settings.llm_api_key,
        model=settings.llm_model,
        name="openai-compatible",
        supports_json_schema=settings.llm_supports_json_schema,
        strict_json_schema=settings.llm_strict_json_schema,
    )


def _create_progress() -> RedisProgressPublisher | NullProgressPublisher:
    try:
        import redis.asyncio as redis

        client: redis.Redis = redis.from_url(settings.redis_url)  # type: ignore[no-untyped-call]
        return RedisProgressPublisher(client)
    except Exception:  # pragma: no cover - configuration problem
        logger.warning("progress_disabled", reason="redis unavailable")
        return NullProgressPublisher()


_retrieval = RetrievalService(_provider)
_investigations = InvestigationRunner(
    settings=settings,
    llm=_create_llm(),  # type: ignore[arg-type]
    retrieval=_retrieval,
    progress=_create_progress(),
)


async def _prepare() -> None:
    await _provider.ensure_collection()


app = create_app(
    settings=settings,
    checks=[qdrant_check(_qdrant)],
    on_shutdown=_qdrant.close,
    retrieval=_retrieval,
    investigations=_investigations,
    on_startup=_prepare,
)
