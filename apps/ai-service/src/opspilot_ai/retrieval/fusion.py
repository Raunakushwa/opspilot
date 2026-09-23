"""Reciprocal Rank Fusion.

Fusion is done here rather than inside Qdrant so the merge is explicit,
testable and measurable — retrieval quality work needs to see why a chunk
ranked where it did (ADR-004).
"""

from .models import ScoredChunk

#: Standard RRF constant. It damps the influence of the top rank so a single
#: retriever cannot dominate the merged list.
RRF_K = 60


def reciprocal_rank_fusion(
    ranked_lists: dict[str, list[ScoredChunk]], *, k: int = RRF_K, limit: int | None = None
) -> list[ScoredChunk]:
    """Merges ranked lists by rank, not by score.

    Scores from different retrievers are not comparable (cosine similarity and
    BM25 live on different scales), so rank is the only sound signal.
    """
    scores: dict[str, float] = {}
    best: dict[str, ScoredChunk] = {}
    sources: dict[str, set[str]] = {}

    for source, results in ranked_lists.items():
        for rank, scored in enumerate(results):
            chunk_id = scored.chunk.chunk_id
            scores[chunk_id] = scores.get(chunk_id, 0.0) + 1.0 / (k + rank + 1)
            sources.setdefault(chunk_id, set()).add(source)
            if chunk_id not in best:
                best[chunk_id] = scored

    merged = [
        ScoredChunk(
            chunk=best[chunk_id].chunk,
            score=score,
            source="+".join(sorted(sources[chunk_id])),
        )
        for chunk_id, score in scores.items()
    ]
    merged.sort(key=lambda item: item.score, reverse=True)
    return merged[:limit] if limit else merged
