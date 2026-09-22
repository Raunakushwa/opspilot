"""Production entry point: `uvicorn opspilot_ai.main:app`."""

from .app import create_app
from .clients.qdrant import create_qdrant_client, qdrant_check
from .config import get_settings
from .logging import configure_logging

settings = get_settings()
configure_logging(settings.log_level, json_output=settings.app_env != "development")

_qdrant = create_qdrant_client(settings)

app = create_app(
    settings=settings,
    checks=[qdrant_check(_qdrant)],
    on_shutdown=_qdrant.close,
)
