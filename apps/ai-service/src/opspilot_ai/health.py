"""Liveness and readiness, mirroring the contract used by the Node services."""

import asyncio
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Literal

from pydantic import BaseModel

from .logging import get_logger

logger = get_logger(__name__)

CheckStatus = Literal["ok", "unavailable"]


@dataclass(frozen=True)
class DependencyCheck:
    """A downstream dependency this service needs in order to do useful work."""

    name: str
    check: Callable[[], Awaitable[None]]


class CheckResult(BaseModel):
    status: CheckStatus
    latency_ms: int


class ReadinessReport(BaseModel):
    status: CheckStatus
    checks: dict[str, CheckResult]


async def _run_check(dependency: DependencyCheck, timeout_ms: int) -> CheckResult:
    started = time.perf_counter()
    try:
        async with asyncio.timeout(timeout_ms / 1000):
            await dependency.check()
        status: CheckStatus = "ok"
    except Exception as exc:  # any failure means "not ready"
        # Details belong in the log, not in a response anyone can reach.
        logger.warning("readiness_check_failed", dependency=dependency.name, error=str(exc))
        status = "unavailable"
    return CheckResult(status=status, latency_ms=round((time.perf_counter() - started) * 1000))


async def run_readiness(checks: list[DependencyCheck], timeout_ms: int) -> ReadinessReport:
    results = await asyncio.gather(*(_run_check(check, timeout_ms) for check in checks))
    by_name = {check.name: result for check, result in zip(checks, results, strict=True)}
    overall: CheckStatus = (
        "ok" if all(result.status == "ok" for result in by_name.values()) else "unavailable"
    )
    return ReadinessReport(status=overall, checks=by_name)
