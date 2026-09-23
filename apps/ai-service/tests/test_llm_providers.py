import pytest
from pydantic import BaseModel

from opspilot_ai.llm.base import LLMRequest, MalformedOutputError, Message
from opspilot_ai.llm.fake import FakeLLMProvider


class Answer(BaseModel):
    summary: str
    confidence: float


def request(text: str = "why is payment-service failing?") -> LLMRequest:
    return LLMRequest(messages=[Message(role="user", content=text)])


async def test_fake_provider_returns_scripted_text() -> None:
    provider = FakeLLMProvider(["a plain answer"])

    response = await provider.generate(request())

    assert response.text == "a plain answer"
    assert response.usage.output_tokens > 0


async def test_structured_output_is_validated_against_the_schema() -> None:
    provider = FakeLLMProvider(
        [FakeLLMProvider.json_response({"summary": "pool", "confidence": 0.8})]
    )

    result = await provider.generate_structured(request(), Answer)

    assert result.value.summary == "pool"
    assert result.value.confidence == 0.8


async def test_malformed_structured_output_raises_a_typed_error() -> None:
    # The graph handles this; it must never escape as an unhandled exception.
    provider = FakeLLMProvider(["not json at all"])

    with pytest.raises(MalformedOutputError):
        await provider.generate_structured(request(), Answer)


async def test_output_missing_a_required_field_is_rejected() -> None:
    provider = FakeLLMProvider([FakeLLMProvider.json_response({"summary": "no confidence"})])

    with pytest.raises(MalformedOutputError):
        await provider.generate_structured(request(), Answer)


async def test_streaming_yields_the_whole_answer() -> None:
    provider = FakeLLMProvider(["searching incident history now"])

    chunks = [chunk async for chunk in provider.stream(request())]

    assert "".join(chunks).strip() == "searching incident history now"
