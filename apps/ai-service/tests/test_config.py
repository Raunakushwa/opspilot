import pytest

from opspilot_ai.config import ConfigError, Settings, load_settings


def test_defaults_are_local_development_friendly() -> None:
    settings = Settings()

    assert settings.app_env == "development"
    assert settings.ai_service_port == 8000
    assert str(settings.qdrant_url).startswith("http://localhost:6333")


def test_reads_values_from_the_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("APP_ENV", "production")
    monkeypatch.setenv("QDRANT_URL", "https://qdrant.internal:6333")
    monkeypatch.setenv("AI_SERVICE_PORT", "9001")

    settings = Settings()

    assert settings.app_env == "production"
    assert settings.ai_service_port == 9001
    assert str(settings.qdrant_url) == "https://qdrant.internal:6333/"


@pytest.mark.parametrize(
    ("variable", "value"),
    [("AI_SERVICE_PORT", "0"), ("APP_ENV", "staging"), ("QDRANT_URL", "not-a-url")],
)
def test_rejects_invalid_values(monkeypatch: pytest.MonkeyPatch, variable: str, value: str) -> None:
    monkeypatch.setenv(variable, value)

    with pytest.raises(ConfigError):
        load_settings()


def test_error_message_does_not_echo_secret_values(monkeypatch: pytest.MonkeyPatch) -> None:
    secret = "sk-super-secret-value"
    monkeypatch.setenv("QDRANT_URL", secret)

    with pytest.raises(ConfigError) as excinfo:
        load_settings()

    assert secret not in str(excinfo.value)
    assert excinfo.value.issues == [
        "qdrant_url: Input should be a valid URL, relative URL without a base"
    ]
