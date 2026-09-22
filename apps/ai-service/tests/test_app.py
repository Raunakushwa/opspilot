import asyncio
import re
from collections.abc import AsyncIterator

import httpx
import pytest
from fastapi import HTTPException

from opspilot_ai.app import create_app
from opspilot_ai.config import Settings
from opspilot_ai.health import DependencyCheck

UUID_PATTERN = re.compile(r"^[0-9a-f-]{36}$")


async def _ok() -> None:
    return None


async def _fails() -> None:
    raise RuntimeError("connect ECONNREFUSED 10.0.0.9:6333")


async def _hangs() -> None:
    await asyncio.sleep(10)


def healthy(name: str) -> DependencyCheck:
    return DependencyCheck(name=name, check=_ok)


def failing(name: str) -> DependencyCheck:
    return DependencyCheck(name=name, check=_fails)


def hanging(name: str) -> DependencyCheck:
    return DependencyCheck(name=name, check=_hangs)


async def client_for(
    settings: Settings, checks: list[DependencyCheck] | None = None
) -> AsyncIterator[httpx.AsyncClient]:
    app = create_app(settings=settings, checks=checks or [])
    transport = httpx.ASGITransport(app=app, raise_app_exceptions=False)
    async with httpx.AsyncClient(transport=transport, base_url="http://ai-service") as client:
        yield client


@pytest.fixture
async def client(settings: Settings) -> AsyncIterator[httpx.AsyncClient]:
    async for value in client_for(settings):
        yield value


async def test_liveness_ignores_dependencies(settings: Settings) -> None:
    async for client in client_for(settings, [failing("qdrant")]):
        response = await client.get("/healthz")

        assert response.status_code == 200
        assert response.json() == {"status": "ok"}


async def test_readiness_ok_when_dependencies_answer(settings: Settings) -> None:
    async for client in client_for(settings, [healthy("qdrant")]):
        response = await client.get("/readyz")

        assert response.status_code == 200
        assert response.json()["checks"]["qdrant"]["status"] == "ok"


async def test_readiness_hides_failure_details(settings: Settings) -> None:
    async for client in client_for(settings, [healthy("qdrant"), failing("llm")]):
        response = await client.get("/readyz")

        assert response.status_code == 503
        assert response.json()["status"] == "unavailable"
        assert "ECONNREFUSED" not in response.text


async def test_readiness_times_out_a_hanging_dependency(settings: Settings) -> None:
    async for client in client_for(settings, [hanging("qdrant")]):
        response = await client.get("/readyz")

        assert response.status_code == 503
        assert response.json()["checks"]["qdrant"]["status"] == "unavailable"


async def test_generates_a_request_id(client: httpx.AsyncClient) -> None:
    response = await client.get("/healthz")

    assert UUID_PATTERN.match(response.headers["x-request-id"])


async def test_propagates_a_safe_caller_request_id(client: httpx.AsyncClient) -> None:
    response = await client.get("/healthz", headers={"x-request-id": "api-9f3b.2"})

    assert response.headers["x-request-id"] == "api-9f3b.2"


async def test_replaces_a_malformed_caller_request_id(client: httpx.AsyncClient) -> None:
    response = await client.get("/healthz", headers={"x-request-id": 'bad id "injected"'})

    assert UUID_PATTERN.match(response.headers["x-request-id"])


async def test_unknown_route_returns_problem_json(client: httpx.AsyncClient) -> None:
    response = await client.get("/nope")

    assert response.status_code == 404
    assert response.headers["content-type"].startswith("application/problem+json")
    body = response.json()
    assert body["status"] == 404
    assert body["requestId"] == response.headers["x-request-id"]


async def test_validation_failure_lists_field_paths(settings: Settings) -> None:
    app = create_app(settings=settings, checks=[])

    @app.get("/things")
    async def _things(limit: int) -> dict[str, int]:
        return {"limit": limit}

    transport = httpx.ASGITransport(app=app, raise_app_exceptions=False)
    async with httpx.AsyncClient(transport=transport, base_url="http://ai-service") as client:
        response = await client.get("/things", params={"limit": "many"})

    assert response.status_code == 422
    body = response.json()
    assert body["code"] == "validation_failed"
    assert body["errors"][0]["path"].endswith("limit")


async def test_internal_errors_are_not_leaked(settings: Settings) -> None:
    app = create_app(settings=settings, checks=[])

    @app.get("/boom")
    async def _boom() -> None:
        raise RuntimeError("qdrant api key sk-live-123 rejected")

    transport = httpx.ASGITransport(app=app, raise_app_exceptions=False)
    async with httpx.AsyncClient(transport=transport, base_url="http://ai-service") as client:
        response = await client.get("/boom")

    assert response.status_code == 500
    assert response.json()["code"] == "internal_error"
    assert "sk-live-123" not in response.text


async def test_http_exceptions_keep_their_status(settings: Settings) -> None:
    app = create_app(settings=settings, checks=[])

    @app.get("/forbidden")
    async def _forbidden() -> None:
        raise HTTPException(status_code=403, detail="Tool not permitted for this organization")

    transport = httpx.ASGITransport(app=app, raise_app_exceptions=False)
    async with httpx.AsyncClient(transport=transport, base_url="http://ai-service") as client:
        response = await client.get("/forbidden")

    assert response.status_code == 403
    assert response.json()["title"] == "Tool not permitted for this organization"
