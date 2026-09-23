"""One adapter for every OpenAI-compatible endpoint.

Groq, OpenAI, vLLM and local Ollama all speak this protocol, so they differ
only by base URL, model name and which features they support (ADR-006).
"""

import json
import time
from collections.abc import AsyncIterator
from typing import Any

import httpx
from pydantic import BaseModel, ValidationError

from opspilot_ai.logging import get_logger

from .base import (
    LLMRequest,
    LLMResponse,
    MalformedOutputError,
    Message,
    StructuredResponse,
    Usage,
)

logger = get_logger(__name__)

REPAIR_INSTRUCTION = (
    "Your previous reply was not valid JSON for the required schema. "
    "Reply with JSON only — no prose, no code fences. Errors: {errors}"
)


class OpenAICompatibleProvider:
    """Chat-completions client with schema-validated structured output."""

    def __init__(
        self,
        *,
        base_url: str,
        api_key: str | None,
        model: str,
        name: str = "openai-compatible",
        supports_json_schema: bool = True,
        timeout_s: float = 60.0,
        max_repairs: int = 1,
    ) -> None:
        self.name = name
        self.model = model
        self._base_url = base_url.rstrip("/")
        self._api_key = api_key
        self._supports_json_schema = supports_json_schema
        self._timeout = timeout_s
        self._max_repairs = max_repairs

    def _headers(self) -> dict[str, str]:
        headers = {"content-type": "application/json"}
        if self._api_key:
            headers["authorization"] = f"Bearer {self._api_key}"
        return headers

    @staticmethod
    def _payload(request: LLMRequest, **extra: Any) -> dict[str, Any]:
        return {
            "messages": [{"role": m.role, "content": m.content} for m in request.messages],
            "temperature": request.temperature,
            "max_tokens": request.max_tokens,
            **({"stop": request.stop} if request.stop else {}),
            **extra,
        }

    async def _post(self, payload: dict[str, Any]) -> dict[str, Any]:
        async with httpx.AsyncClient(timeout=self._timeout) as client:
            response = await client.post(
                f"{self._base_url}/chat/completions",
                headers=self._headers(),
                json={"model": self.model, **payload},
            )
            response.raise_for_status()
            body: dict[str, Any] = response.json()
            return body

    @staticmethod
    def _text(body: dict[str, Any]) -> str:
        choices = body.get("choices") or [{}]
        message = choices[0].get("message") or {}
        return str(message.get("content") or "")

    @staticmethod
    def _usage(body: dict[str, Any]) -> Usage:
        usage = body.get("usage") or {}
        return Usage(
            input_tokens=int(usage.get("prompt_tokens") or 0),
            output_tokens=int(usage.get("completion_tokens") or 0),
        )

    async def generate(self, request: LLMRequest) -> LLMResponse:
        started = time.perf_counter()
        body = await self._post(self._payload(request))
        return LLMResponse(
            text=self._text(body),
            model=self.model,
            usage=self._usage(body),
            latency_ms=int((time.perf_counter() - started) * 1000),
        )

    async def generate_structured[T: BaseModel](
        self, request: LLMRequest, schema: type[T]
    ) -> StructuredResponse[T]:
        started = time.perf_counter()
        schema_json = schema.model_json_schema()
        extra: dict[str, Any] = (
            {
                "response_format": {
                    "type": "json_schema",
                    "json_schema": {"name": schema.__name__, "schema": schema_json, "strict": True},
                }
            }
            if self._supports_json_schema
            else {"response_format": {"type": "json_object"}}
        )

        messages = list(request.messages)
        usage = Usage()
        raw = ""
        for attempt in range(self._max_repairs + 1):
            body = await self._post(
                self._payload(
                    LLMRequest(
                        messages=messages,
                        temperature=request.temperature,
                        max_tokens=request.max_tokens,
                    ),
                    **extra,
                )
            )
            raw = _strip_code_fence(self._text(body))
            call_usage = self._usage(body)
            usage = Usage(
                input_tokens=usage.input_tokens + call_usage.input_tokens,
                output_tokens=usage.output_tokens + call_usage.output_tokens,
            )
            try:
                value = schema.model_validate_json(raw)
            except ValidationError as exc:
                if attempt >= self._max_repairs:
                    # A typed failure the caller can handle; never an exception
                    # that escapes as a 500 mid-investigation.
                    raise MalformedOutputError(str(exc), raw) from None
                logger.warning("structured_output_repair", attempt=attempt + 1)
                messages = [
                    *messages,
                    Message(role="assistant", content=raw),
                    Message(
                        role="user",
                        content=REPAIR_INSTRUCTION.format(errors=_short_errors(exc)),
                    ),
                ]
                continue
            return StructuredResponse(
                value=value,
                model=self.model,
                usage=usage,
                latency_ms=int((time.perf_counter() - started) * 1000),
                repairs=attempt,
            )
        raise MalformedOutputError("exhausted repairs", raw)

    async def stream(self, request: LLMRequest) -> AsyncIterator[str]:
        async with (
            httpx.AsyncClient(timeout=self._timeout) as client,
            client.stream(
                "POST",
                f"{self._base_url}/chat/completions",
                headers=self._headers(),
                json={"model": self.model, **self._payload(request, stream=True)},
            ) as response,
        ):
            response.raise_for_status()
            async for line in response.aiter_lines():
                if not line.startswith("data: "):
                    continue
                data = line.removeprefix("data: ").strip()
                if data == "[DONE]":
                    return
                try:
                    chunk = json.loads(data)
                except json.JSONDecodeError:
                    continue
                delta = (chunk.get("choices") or [{}])[0].get("delta") or {}
                content = delta.get("content")
                if content:
                    yield str(content)


def _strip_code_fence(text: str) -> str:
    """Some models wrap JSON in ```json fences despite being told not to."""
    stripped = text.strip()
    if stripped.startswith("```"):
        stripped = stripped.split("\n", 1)[-1]
        if stripped.endswith("```"):
            stripped = stripped[:-3]
    return stripped.strip()


def _short_errors(exc: ValidationError) -> str:
    return "; ".join(
        f"{'.'.join(str(p) for p in error['loc'])}: {error['msg']}" for error in exc.errors()[:5]
    )
