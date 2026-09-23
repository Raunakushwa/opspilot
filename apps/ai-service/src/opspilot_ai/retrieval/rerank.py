"""Reranking.

Retrieval optimises for recall over thirty candidates; reranking optimises for
precision over eight. Keeping them separate is what lets either be changed
without touching the other (ADR-004).
"""

from typing import Protocol

from opspilot_ai.logging import get_logger

from .embeddings import tokenize
from .models import ScoredChunk

logger = get_logger(__name__)


class Reranker(Protocol):
    def rerank(
        self, query: str, candidates: list[ScoredChunk], top_n: int
    ) -> list[ScoredChunk]: ...


class LexicalReranker:
    """Deterministic overlap scoring: no model, used in tests and offline runs."""

    def rerank(self, query: str, candidates: list[ScoredChunk], top_n: int) -> list[ScoredChunk]:
        terms = set(tokenize(query))
        if not terms:
            return candidates[:top_n]

        scored: list[ScoredChunk] = []
        for candidate in candidates:
            tokens = tokenize(candidate.chunk.content)
            if not tokens:
                continue
            overlap = sum(1 for token in tokens if token in terms)
            # Coverage of the query matters more than raw hit count, otherwise
            # long chunks win merely by being long.
            coverage = len(terms.intersection(tokens)) / len(terms)
            score = coverage * 0.8 + min(overlap / max(len(tokens), 1), 1.0) * 0.2
            scored.append(ScoredChunk(chunk=candidate.chunk, score=score, source=candidate.source))

        scored.sort(key=lambda item: item.score, reverse=True)
        return scored[:top_n]


class CrossEncoderReranker:
    """Cross-encoder reranking via fastembed."""

    def __init__(self, model: str = "Xenova/ms-marco-MiniLM-L-6-v2") -> None:
        from fastembed.rerank.cross_encoder import TextCrossEncoder

        self._model = TextCrossEncoder(model_name=model)
        logger.info("reranker_loaded", model=model)

    def rerank(self, query: str, candidates: list[ScoredChunk], top_n: int) -> list[ScoredChunk]:
        if not candidates:
            return []
        scores = list(self._model.rerank(query, [c.chunk.content for c in candidates]))
        ranked = [
            ScoredChunk(chunk=candidate.chunk, score=float(score), source=candidate.source)
            for candidate, score in zip(candidates, scores, strict=True)
        ]
        ranked.sort(key=lambda item: item.score, reverse=True)
        return ranked[:top_n]


def create_reranker(provider: str) -> Reranker:
    if provider == "cross-encoder":
        return CrossEncoderReranker()
    return LexicalReranker()
