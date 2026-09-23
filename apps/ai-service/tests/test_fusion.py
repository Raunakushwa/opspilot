from opspilot_ai.retrieval.fusion import reciprocal_rank_fusion
from opspilot_ai.retrieval.models import Chunk, ScoredChunk


def chunk(chunk_id: str) -> Chunk:
    return Chunk(
        chunk_id=chunk_id,
        document_id="doc",
        document_version_id="version",
        organization_id="org",
        title="Doc",
        content=chunk_id,
    )


def scored(chunk_id: str, score: float) -> ScoredChunk:
    return ScoredChunk(chunk=chunk(chunk_id), score=score)


def test_ranks_by_position_not_by_incomparable_scores() -> None:
    # Cosine similarity and BM25 live on different scales; only rank is sound.
    dense = [scored("a", 0.91), scored("b", 0.90)]
    sparse = [scored("b", 14.2), scored("c", 11.0)]

    merged = reciprocal_rank_fusion({"dense": dense, "sparse": sparse})

    assert merged[0].chunk.chunk_id == "b"


def test_agreement_between_retrievers_wins() -> None:
    dense = [scored("x", 0.5), scored("y", 0.4)]
    sparse = [scored("y", 9.0), scored("z", 8.0)]

    merged = reciprocal_rank_fusion({"dense": dense, "sparse": sparse})

    assert merged[0].chunk.chunk_id == "y"
    assert merged[0].source == "dense+sparse"


def test_records_which_retriever_found_each_chunk() -> None:
    merged = reciprocal_rank_fusion({"dense": [scored("only-dense", 1.0)], "sparse": []})

    assert merged[0].source == "dense"


def test_deduplicates_and_respects_the_limit() -> None:
    dense = [scored(str(i), 1.0) for i in range(10)]
    sparse = [scored(str(i), 1.0) for i in range(5, 15)]

    merged = reciprocal_rank_fusion({"dense": dense, "sparse": sparse}, limit=8)

    assert len(merged) == 8
    assert len({item.chunk.chunk_id for item in merged}) == 8


def test_empty_input_is_not_an_error() -> None:
    assert reciprocal_rank_fusion({"dense": [], "sparse": []}) == []
