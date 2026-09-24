"""Retrieval metrics. Deterministic by design: no model judges these, so a
score change means a retrieval change."""

from opspilot_ai.eval.metrics import (
    aggregate,
    ndcg_at_k,
    precision_at_k,
    recall_at_k,
    reciprocal_rank,
    score_case,
)

EXPECTED = ["Runbook: rolling back payment-service"]


def test_recall_counts_expected_documents_found_in_top_k() -> None:
    assert recall_at_k(["Runbook: rolling back payment-service", "Other"], EXPECTED, 8) == 1.0
    assert recall_at_k(["Other", "Another"], EXPECTED, 8) == 0.0


def test_recall_ignores_documents_ranked_below_k() -> None:
    # Retrieved, but outside the window the LLM actually sees.
    retrieved = ["A", "B", "C", "Runbook: rolling back payment-service"]

    assert recall_at_k(retrieved, EXPECTED, 3) == 0.0
    assert recall_at_k(retrieved, EXPECTED, 4) == 1.0


def test_precision_measures_how_noisy_the_context_is() -> None:
    assert precision_at_k(["Runbook: rolling back payment-service"], EXPECTED, 1) == 1.0
    assert precision_at_k(["Runbook: rolling back payment-service", "Noise"], EXPECTED, 2) == 0.5


def test_reciprocal_rank_rewards_ranking_the_right_document_first() -> None:
    assert reciprocal_rank(["Runbook: rolling back payment-service", "x"], EXPECTED) == 1.0
    assert reciprocal_rank(["x", "Runbook: rolling back payment-service"], EXPECTED) == 0.5
    assert reciprocal_rank(["x", "y"], EXPECTED) == 0.0


def test_ndcg_prefers_the_wanted_document_higher_up() -> None:
    first = ndcg_at_k(["Runbook: rolling back payment-service", "x", "y"], EXPECTED, 3)
    third = ndcg_at_k(["x", "y", "Runbook: rolling back payment-service"], EXPECTED, 3)

    assert first == 1.0
    assert third < first


def test_multiple_expected_documents_are_scored_partially() -> None:
    expected = ["Doc A", "Doc B"]

    assert recall_at_k(["Doc A", "Noise"], expected, 8) == 0.5


def test_case_score_reports_what_was_missed() -> None:
    score = score_case("case-1", ["Noise"], ["Doc A", "Doc B"], 8)

    # A failing case must say which document was not surfaced, otherwise the
    # number is not actionable.
    assert score.missing == ["Doc A", "Doc B"]
    assert score.found == []


def test_aggregate_averages_across_cases() -> None:
    perfect = score_case("a", ["Doc A"], ["Doc A"], 8)
    missed = score_case("b", ["Noise"], ["Doc B"], 8)

    metrics = aggregate([perfect, missed])

    assert metrics["recall_at_k"] == 0.5
    assert metrics["mrr"] == 0.5


def test_aggregate_of_nothing_is_zero_not_an_error() -> None:
    assert aggregate([])["recall_at_k"] == 0.0
