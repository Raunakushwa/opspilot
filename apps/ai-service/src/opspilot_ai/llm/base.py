"""Provider-agnostic LLM interface.

Model choice changes for reasons unrelated to the application — price,
latency, availability, or a requirement to run locally — so the rest of the
service depends on this protocol rather than on any vendor SDK (ADR-006).
"""

from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from typing import Literal, Protocol, TypeVar

from pydantic import BaseModel

Role = Literal["system", "user", "assistant"]

TModel = TypeVar("TModel", bound=BaseModel)


@dataclass(frozen=True)
class Message:
    role: Role
    content: str


@dataclass(frozen=True)
class LLMRequest:
    messages: list[Message]
    temperature: float = 0.1
    max_tokens: int = 2048
    stop: list[str] = field(default_factory=list)


@dataclass(frozen=True)
class Usage:
    input_tokens: int = 0
    output_tokens: int = 0


@dataclass(frozen=True)
class LLMResponse:
    text: str
    model: str
    usage: Usage
    latency_ms: int


@dataclass(frozen=True)
class StructuredResponse[T: BaseModel]:
    value: T
    model: str
    usage: Usage
    latency_ms: int
    #: Retries needed to get valid output; >0 means the first answer was invalid.
    repairs: int = 0


class MalformedOutputError(Exception):
    """The model could not produce output matching the schema, even after repair."""

    def __init__(self, detail: str, raw: str) -> None:
        super().__init__(detail)
        self.raw = raw


class LLMProvider(Protocol):
    """Every provider implements this; nothing else may be imported by callers."""

    name: str
    model: str

    async def generate(self, request: LLMRequest) -> LLMResponse: ...

    async def generate_structured[T: BaseModel](
        self, request: LLMRequest, schema: type[T]
    ) -> StructuredResponse[T]: ...

    def stream(self, request: LLMRequest) -> AsyncIterator[str]: ...
