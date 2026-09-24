"""Runs a retrieval evaluation and writes machine-readable results.

Results record the model, the dataset, the commit and the timestamp, because a
score without that context is not comparable to anything — and is exactly the
kind of number that gets quoted later without its caveats.
"""

import json
import subprocess
import time
from dataclasses import asdict, dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from opspilot_ai.logging import get_logger
from opspilot_ai.service import RetrievalService, SearchRequest

from .metrics import CaseScore, aggregate, score_case

logger = get_logger(__name__)


@dataclass(frozen=True)
class EvalCase:
    id: str
    question: str
    expected_documents: list[str]
    expected_answer: str = ""


@dataclass(frozen=True)
class EvalDataset:
    name: str
    description: str
    cases: list[EvalCase]


def load_dataset(path: Path) -> EvalDataset:
    payload = json.loads(path.read_text())
    return EvalDataset(
        name=payload["name"],
        description=payload.get("description", ""),
        cases=[
            EvalCase(
                id=case["id"],
                question=case["question"],
                expected_documents=case["expected_documents"],
                expected_answer=case.get("expected_answer", ""),
            )
            for case in payload["cases"]
        ],
    )


def _git_sha() -> str:
    try:
        return subprocess.run(
            ["git", "rev-parse", "--short", "HEAD"],  # noqa: S607
            capture_output=True,
            text=True,
            check=True,
            timeout=5,
        ).stdout.strip()
    except (subprocess.SubprocessError, OSError):
        return "unknown"


async def run_evaluation(
    retrieval: RetrievalService,
    dataset: EvalDataset,
    organization_id: str,
    *,
    top_k: int = 8,
    mode: str = "hybrid",
    embedding_provider: str = "unknown",
    reranker_provider: str = "unknown",
) -> dict[str, Any]:
    scores: list[CaseScore] = []
    per_case: list[dict[str, Any]] = []
    started = time.perf_counter()

    for case in dataset.cases:
        case_started = time.perf_counter()
        result = await retrieval.search(
            SearchRequest(
                organization_id=organization_id,
                query=case.question,
                top_k=top_k,
                mode=mode,
            )
        )
        # Chunks are scored by the document they came from: retrieving three
        # chunks of the right runbook is one correct document, not three.
        titles: list[str] = []
        for scored in result.chunks:
            if scored.chunk.title not in titles:
                titles.append(scored.chunk.title)

        score = score_case(case.id, titles, case.expected_documents, top_k)
        scores.append(score)
        per_case.append(
            {
                **asdict(score),
                "question": case.question,
                "retrieved": titles,
                "latency_ms": int((time.perf_counter() - case_started) * 1000),
                "retrieval_ms": result.timing.dense_ms + result.timing.sparse_ms,
                "rerank_ms": result.timing.rerank_ms,
            }
        )

    return {
        "dataset": dataset.name,
        "cases": len(dataset.cases),
        "config": {
            "mode": mode,
            "top_k": top_k,
            "embedding_provider": embedding_provider,
            "reranker_provider": reranker_provider,
        },
        "git_sha": _git_sha(),
        "generated_at": datetime.now(UTC).isoformat(),
        "total_ms": int((time.perf_counter() - started) * 1000),
        "metrics": aggregate(scores),
        "results": per_case,
    }


def write_results(report: dict[str, Any], directory: Path) -> Path:
    directory.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
    path = directory / f"{stamp}-{report['dataset']}.json"
    path.write_text(json.dumps(report, indent=2))
    return path
