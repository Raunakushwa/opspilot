"""Retrieval metrics.

All computed from the ranking alone — no model judges these, so the numbers
are reproducible and comparable across runs. Generation quality (faithfulness,
answer relevance) needs a judge model and is reported separately, never mixed
into these.
"""

import math
from dataclasses import dataclass


@dataclass(frozen=True)
class CaseScore:
    case_id: str
    recall_at_k: float
    precision_at_k: float
    reciprocal_rank: float
    ndcg: float
    found: list[str]
    missing: list[str]


def recall_at_k(retrieved: list[str], expected: list[str], k: int) -> float:
    """Share of expected documents that appear in the top k."""
    if not expected:
        return 1.0
    top = set(retrieved[:k])
    return len([title for title in expected if title in top]) / len(expected)


def precision_at_k(retrieved: list[str], expected: list[str], k: int) -> float:
    """Share of the top k that was wanted. Low precision means noisy context."""
    if k == 0 or not retrieved:
        return 0.0
    top = retrieved[:k]
    wanted = set(expected)
    return len([title for title in top if title in wanted]) / len(top)


def reciprocal_rank(retrieved: list[str], expected: list[str]) -> float:
    """1/rank of the first wanted document; 0 if none was retrieved."""
    wanted = set(expected)
    for index, title in enumerate(retrieved, start=1):
        if title in wanted:
            return 1.0 / index
    return 0.0


def ndcg_at_k(retrieved: list[str], expected: list[str], k: int) -> float:
    """Rewards putting wanted documents near the top, not merely including them."""
    wanted = set(expected)
    gain = sum(
        1.0 / math.log2(index + 1)
        for index, title in enumerate(retrieved[:k], start=1)
        if title in wanted
    )
    ideal = sum(1.0 / math.log2(index + 1) for index in range(1, min(len(expected), k) + 1))
    return gain / ideal if ideal else 0.0


def score_case(case_id: str, retrieved: list[str], expected: list[str], k: int) -> CaseScore:
    top = retrieved[:k]
    return CaseScore(
        case_id=case_id,
        recall_at_k=recall_at_k(retrieved, expected, k),
        precision_at_k=precision_at_k(retrieved, expected, k),
        reciprocal_rank=reciprocal_rank(retrieved, expected),
        ndcg=ndcg_at_k(retrieved, expected, k),
        found=[title for title in expected if title in set(top)],
        missing=[title for title in expected if title not in set(top)],
    )


def aggregate(scores: list[CaseScore]) -> dict[str, float]:
    if not scores:
        return {"recall_at_k": 0.0, "precision_at_k": 0.0, "mrr": 0.0, "ndcg": 0.0}
    count = len(scores)
    return {
        "recall_at_k": round(sum(s.recall_at_k for s in scores) / count, 4),
        "precision_at_k": round(sum(s.precision_at_k for s in scores) / count, 4),
        "mrr": round(sum(s.reciprocal_rank for s in scores) / count, 4),
        "ndcg": round(sum(s.ndcg for s in scores) / count, 4),
    }
