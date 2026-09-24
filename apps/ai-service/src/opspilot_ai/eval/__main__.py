"""`python -m opspilot_ai.eval` — evaluate retrieval against a dataset.

Run it inside the ai-service container, where Qdrant and the configured
embedding models are reachable.
"""

import argparse
import asyncio
import sys
from pathlib import Path

from opspilot_ai.clients.qdrant import create_qdrant_client
from opspilot_ai.config import get_settings
from opspilot_ai.logging import configure_logging
from opspilot_ai.retrieval.embeddings import create_embedder
from opspilot_ai.retrieval.rerank import create_reranker
from opspilot_ai.retrieval.store import QdrantSearchProvider
from opspilot_ai.service import RetrievalService

from .runner import load_dataset, run_evaluation, write_results


async def main() -> int:
    parser = argparse.ArgumentParser(description="Evaluate OpsPilot retrieval")
    parser.add_argument("--organization-id", required=True)
    parser.add_argument("--dataset", default="/eval/datasets/retrieval-v1.json")
    parser.add_argument("--out", default="/eval/results")
    parser.add_argument("--top-k", type=int, default=8)
    parser.add_argument("--mode", default="hybrid", choices=["hybrid", "vector", "keyword"])
    args = parser.parse_args()

    settings = get_settings()
    configure_logging(settings.log_level)

    client = create_qdrant_client(settings)
    provider = QdrantSearchProvider(
        client,
        create_embedder(settings.embedding_provider),
        create_reranker(settings.reranker_provider),
    )
    retrieval = RetrievalService(provider)

    dataset = load_dataset(Path(args.dataset))
    report = await run_evaluation(
        retrieval,
        dataset,
        args.organization_id,
        top_k=args.top_k,
        mode=args.mode,
        embedding_provider=settings.embedding_provider,
        reranker_provider=settings.reranker_provider,
    )
    path = write_results(report, Path(args.out))

    metrics = report["metrics"]
    print(f"dataset:  {report['dataset']} ({report['cases']} cases)")
    print(f"mode:     {args.mode}  embeddings={settings.embedding_provider}")
    print(
        "metrics:  "
        f"recall@{args.top_k}={metrics['recall_at_k']}  "
        f"precision@{args.top_k}={metrics['precision_at_k']}  "
        f"MRR={metrics['mrr']}  nDCG={metrics['ndcg']}"
    )
    for case in report["results"]:
        if case["missing"]:
            print(f"  missed {case['case_id']}: expected {case['missing']}")
    print(f"written:  {path}")

    await client.close()
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
