# ADR-004: Qdrant for vector and sparse retrieval

- **Status**: Accepted
- **Date**: 2026-09-22

## Context

The copilot answers from runbooks, postmortems and past incidents. Retrieval
must be hybrid — semantic plus keyword — because incident language mixes prose
("checkout is throwing 500s") with exact tokens ("ERR_CONN_RESET", service
names, error codes) that embeddings handle poorly. Every query must be filtered
by organization, and that filter must be impossible to forget.

## Decision

Qdrant, holding a dense vector and a sparse BM25 vector per chunk, with
`organization_id` as an indexed tenant payload filter. Candidates from both
retrievals are merged with Reciprocal Rank Fusion in application code, then
reranked by a cross-encoder.

## Alternatives considered

- **pgvector.** One fewer datastore, transactionally consistent with the source
  of truth. At our scale it would genuinely be enough. Rejected because hybrid
  search would then be split across two engines and PostgreSQL's `ts_rank` is
  not BM25 — and because retrieval load should not compete with OLTP traffic.
- **Qdrant's built-in fusion.** Convenient, but doing RRF ourselves keeps the
  merge step explicit, testable and measurable, which matters for evaluation.
- **A hosted search service.** Operationally simpler, but it cannot run in
  `docker compose up`.

## Consequences

- A second datastore to run, back up and monitor.
- It is never a source of truth: the index is rebuildable from
  `document_versions`, and re-indexing is an idempotent job.
- Retrieval is swappable behind a `SearchProvider` interface.
