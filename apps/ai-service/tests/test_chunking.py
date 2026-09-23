from opspilot_ai.retrieval.chunking import chunk_markdown

RUNBOOK = """# Rolling back payment-service

## When to roll back
Roll back when error rate exceeds 2% for five minutes.

## Procedure
1. Identify the release.
2. Announce in the incident channel.
3. Run the rollback command.

## Cautions
Rolling back does not revert database migrations.
"""


def test_splits_on_headings_so_procedures_stay_together() -> None:
    chunks = chunk_markdown(RUNBOOK)

    headings = [chunk.heading_path for chunk in chunks]
    assert any(heading and heading.endswith("Procedure") for heading in headings)
    procedure = next(c for c in chunks if c.heading_path and c.heading_path.endswith("Procedure"))
    # All three steps in one chunk: a chunk starting mid-procedure is useless to cite.
    assert "1." in procedure.content
    assert "3." in procedure.content


def test_heading_path_is_hierarchical_and_travels_with_the_chunk() -> None:
    chunks = chunk_markdown(RUNBOOK)

    procedure = next(c for c in chunks if c.heading_path and "Procedure" in c.heading_path)
    assert procedure.heading_path == "Rolling back payment-service > Procedure"
    assert procedure.content.startswith("Rolling back payment-service > Procedure")


def test_long_sections_are_split_with_overlap() -> None:
    long_text = "# Title\n\n" + ("Sentence about connection pools. " * 400)

    chunks = chunk_markdown(long_text, max_tokens=100, overlap_tokens=20)

    assert len(chunks) > 1
    assert all(chunk.token_count <= 160 for chunk in chunks)
    # Overlap means a sentence spanning a boundary is still retrievable whole.
    assert chunks[0].content[-40:-10] in chunks[1].content


def test_indexes_are_contiguous_and_empty_sections_dropped() -> None:
    chunks = chunk_markdown("# A\n\n## Empty\n\n## Real\n\nContent here.")

    assert [chunk.index for chunk in chunks] == list(range(len(chunks)))
    assert all(chunk.content.strip() for chunk in chunks)


def test_plain_text_without_headings_still_chunks() -> None:
    chunks = chunk_markdown("No headings at all, just prose about payments.")

    assert len(chunks) == 1
    assert chunks[0].heading_path is None
