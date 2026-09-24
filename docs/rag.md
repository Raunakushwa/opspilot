# Retrieval

## Pipeline

```
query → dense (bge-small, 384d) ─┐
                                 ├─ Reciprocal Rank Fusion (app code) → cross-encoder rerank → top 8
      → sparse (BM25)           ─┘
```

Both retrievals are filtered by organization from verified context — never
from anything a model produced — using a Qdrant tenant payload index.

**Fusion happens in application code**, not inside Qdrant, because cosine
similarity and BM25 live on different scales: only rank is a sound signal, and
keeping the merge explicit makes it testable and measurable (ADR-004).

**Reranking is a separate stage** with its own latency measurement. Retrieval
optimises for recall over ~30 candidates; reranking optimises for precision
over 8.

## Ingestion

1. A document version is created (documents are versioned).
2. The worker enqueues an ingestion job.
3. The worker reads the text from PostgreSQL and posts it to the AI service,
   which holds **no database credentials for domain tables**.
4. The service chunks on markdown headings first, then by size with overlap,
   so a runbook's steps stay in one chunk and the heading travels with it.
5. Chunks are embedded (dense + sparse) and upserted with deterministic point
   ids derived from (version, index), which makes re-indexing idempotent.
6. Only **after** the new version is searchable are older versions removed, so
   a document is never briefly unfindable.

On startup the worker re-queues anything not `INDEXED`, so a lost job or a
freshly seeded database converges without manual steps.

## Evaluation

`pnpm evaluate:rag` scores retrieval against
[`eval/datasets/retrieval-v1.json`](../eval/datasets/retrieval-v1.json):
eight questions an on-call engineer would actually ask, each labelled with the
documents a competent responder would want.

Metrics are **recall@k, precision@k, MRR and nDCG**, computed from the ranking
alone. No model judges them, so a score change means a retrieval change rather
than a different mood from a judge. Chunks are scored by their document:
retrieving three chunks of the right runbook is one correct document, not
three.

Reports are written to `eval/results/` with the dataset, config, embedding
provider, git commit and timestamp — a score without that context is not
comparable to anything.

### Measured (2026-09-24, bge-small + BM25 + ms-marco MiniLM cross-encoder)

k=8: **recall 1.0 · MRR 1.0 · nDCG 1.0 · precision 0.39**

Precision is low _because the corpus is small_: with seven seeded documents, a
top-8 window necessarily includes unrelated ones. That is a property of the
demo dataset, not a retrieval failure.

At k=4, comparing modes:

| mode         | recall@4 | MRR     | nDCG    |
| ------------ | -------- | ------- | ------- |
| hybrid       | **1.0**  | **1.0** | **1.0** |
| vector only  | 0.94     | 0.94    | 0.91    |
| keyword only | 1.0      | 1.0     | 1.0     |

Vector-only **misses** the architecture document for _"what does 'timeout
acquiring connection from pool' mean?"_ — a near-exact token match that
embeddings blur. That is the case ADR-004 predicted, now demonstrated rather
than argued.

Keyword-only also scores 1.0 here. On a corpus this small that is
unsurprising, and no general claim that hybrid beats BM25 is made from eight
questions.

### Not yet measured

Generation quality (faithfulness, answer relevance) needs a judge model and a
key; the harness reports retrieval only, and the two are never averaged
together.
