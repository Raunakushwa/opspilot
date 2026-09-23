"""Application settings, validated once at import of :func:`get_settings`."""

from functools import lru_cache
from typing import Literal

from pydantic import Field, HttpUrl, ValidationError
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Environment-driven configuration.

    Mirrors the Node services: invalid configuration fails at startup rather
    than on the first request, and values are never echoed in error messages.
    """

    model_config = SettingsConfigDict(env_file=None, extra="ignore", frozen=True)

    app_env: Literal["development", "test", "production"] = "development"
    log_level: Literal["debug", "info", "warning", "error"] = "info"
    # Format is explicit rather than derived from app_env: containers emit JSON.
    log_pretty: bool = False
    ai_service_host: str = "0.0.0.0"  # noqa: S104 - containers bind all interfaces
    ai_service_port: int = Field(default=8000, ge=1, le=65535)
    qdrant_url: HttpUrl = HttpUrl("http://localhost:6333")
    qdrant_api_key: str | None = None
    readiness_timeout_ms: int = Field(default=2000, gt=0)

    # Retrieval. "hashing"/"lexical" need no model download, which keeps tests
    # and CI offline; real deployments use fastembed models.
    embedding_provider: Literal["fastembed", "hashing"] = "fastembed"
    reranker_provider: Literal["cross-encoder", "lexical"] = "cross-encoder"

    # LLM. One adapter serves Groq, OpenAI-compatible endpoints and Ollama.
    llm_provider: Literal["openai-compatible", "fake"] = "openai-compatible"
    llm_base_url: str = "https://api.groq.com/openai/v1"
    llm_api_key: str | None = None
    llm_model: str = "llama-3.3-70b-versatile"
    llm_supports_json_schema: bool = True

    # Shared secret for calls from the worker. The AI service is internal and
    # must never be reachable without it.
    internal_api_token: str | None = None


class ConfigError(Exception):
    """Configuration is invalid; the message names fields but never their values."""

    def __init__(self, issues: list[str]) -> None:
        self.issues = issues
        super().__init__("Invalid configuration:\n  - " + "\n  - ".join(issues))


def load_settings() -> Settings:
    """Loads settings, converting Pydantic errors into value-free messages.

    ``ValidationError`` repeats the offending input, which for QDRANT_URL or an
    API key would print a credential into the crash log of every environment.
    """
    try:
        return Settings()
    except ValidationError as exc:
        issues = [
            f"{'.'.join(str(part) for part in error['loc']) or '(root)'}: {error['msg']}"
            for error in exc.errors()
        ]
        # `from None`: chaining would re-attach the original message, values and all.
        raise ConfigError(issues) from None


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return load_settings()
