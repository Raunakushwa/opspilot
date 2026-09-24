"""Investigation progress, published to a Redis stream.

A stream rather than pub/sub: a client that connects late or reconnects can
replay from where it stopped, which is what makes the UI survive a refresh in
the middle of a two-minute investigation.
"""

import json
from typing import Any, Protocol

import redis.asyncio as redis

from .logging import get_logger

logger = get_logger(__name__)

#: Events outlive the run only long enough to be read by a reconnecting client.
STREAM_TTL_SECONDS = 3600


def stream_key(run_id: str) -> str:
    return f"opspilot:run:{run_id}:events"


class ProgressPublisher(Protocol):
    async def publish(self, run_id: str, event: str, payload: dict[str, Any]) -> None: ...


class RedisProgressPublisher:
    def __init__(self, client: redis.Redis) -> None:
        self._client = client

    async def publish(self, run_id: str, event: str, payload: dict[str, Any]) -> None:
        key = stream_key(run_id)
        try:
            await self._client.xadd(
                key, {"event": event, "payload": json.dumps(payload, default=str)}
            )
            await self._client.expire(key, STREAM_TTL_SECONDS)
        except Exception as exc:  # progress is best-effort
            # Losing a progress event must never fail the investigation itself.
            # "event" is structlog's own key, so the name is qualified here.
            logger.warning("progress_publish_failed", error=str(exc), progress_event=event)


class NullProgressPublisher:
    async def publish(self, run_id: str, event: str, payload: dict[str, Any]) -> None:
        return None
