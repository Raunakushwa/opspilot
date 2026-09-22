import pytest

from opspilot_ai.config import Settings
from opspilot_ai.logging import configure_logging

configure_logging("error")


@pytest.fixture
def settings() -> Settings:
    return Settings(app_env="test", readiness_timeout_ms=100)
