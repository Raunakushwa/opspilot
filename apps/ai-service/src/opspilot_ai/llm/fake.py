"""Deterministic provider for tests, CI and offline development.

Keeping this behind the same protocol means the agent, guardrails and
citation checks are exercised without a paid, non-deterministic dependency.
"""

import json
import time
from collections.abc import AsyncIterator, Callable

from pydantic import BaseModel, ValidationError

from .base import (
    LLMRequest,
    LLMResponse,
    MalformedOutputError,
    StructuredResponse,
    Usage,
)


class FakeLLMProvider:
    """Replays scripted answers, or derives one from a callable."""

    name = "fake"

    def __init__(
        self,
        responses: list[str] | None = None,
        *,
        model: str = "fake-1",
        handler: Callable[[LLMRequest], str] | None = None,
    ) -> None:
        self.model = model
        self._responses = list(responses or [])
        self._handler = handler
        self.calls: list[LLMRequest] = []

    def _next(self, request: LLMRequest) -> str:
        self.calls.append(request)
        if self._handler is not None:
            return self._handler(request)
        if not self._responses:
            return "no scripted response"
        return self._responses.pop(0)

    async def generate(self, request: LLMRequest) -> LLMResponse:
        text = self._next(request)
        return LLMResponse(
            text=text,
            model=self.model,
            usage=Usage(input_tokens=len(str(request.messages)) // 4, output_tokens=len(text) // 4),
            latency_ms=0,
        )

    async def generate_structured[T: BaseModel](
        self, request: LLMRequest, schema: type[T]
    ) -> StructuredResponse[T]:
        started = time.perf_counter()
        raw = self._next(request)
        try:
            value = schema.model_validate_json(raw)
        except ValidationError as exc:
            raise MalformedOutputError(str(exc), raw) from None
        return StructuredResponse(
            value=value,
            model=self.model,
            usage=Usage(output_tokens=len(raw) // 4),
            latency_ms=int((time.perf_counter() - started) * 1000),
        )

    async def stream(self, request: LLMRequest) -> AsyncIterator[str]:
        for word in self._next(request).split(" "):
            yield word + " "

    @staticmethod
    def json_response(payload: object) -> str:
        return json.dumps(payload)
