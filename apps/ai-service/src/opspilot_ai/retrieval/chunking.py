"""Structure-aware chunking.

Splitting on markdown headings first keeps a runbook's steps together, which
matters more for answer quality than any embedding-model choice: a chunk that
starts mid-procedure cannot be cited usefully.
"""

import re
from dataclasses import dataclass

HEADING = re.compile(r"^(#{1,6})\s+(.*)$")

#: Rough token estimate; a real tokenizer is not worth the dependency here, and
#: the limit only needs to be approximately right.
CHARS_PER_TOKEN = 4


@dataclass(frozen=True)
class TextChunk:
    index: int
    content: str
    heading_path: str | None
    token_count: int


def _estimate_tokens(text: str) -> int:
    return max(1, len(text) // CHARS_PER_TOKEN)


def chunk_markdown(
    text: str, *, max_tokens: int = 400, overlap_tokens: int = 60
) -> list[TextChunk]:
    """Splits by heading, then by size, keeping an overlap between neighbours."""
    sections: list[tuple[str | None, list[str]]] = []
    path: list[str] = []
    current: list[str] = []
    current_heading: str | None = None

    for line in text.splitlines():
        match = HEADING.match(line)
        if match:
            if current:
                sections.append((current_heading, current))
                current = []
            depth = len(match.group(1))
            title = match.group(2).strip()
            path = path[: depth - 1]
            path.append(title)
            current_heading = " > ".join(path)
            continue
        current.append(line)

    if current:
        sections.append((current_heading, current))

    chunks: list[TextChunk] = []
    for heading, lines in sections:
        body = "\n".join(lines).strip()
        if not body:
            continue
        for piece in _split_by_size(body, max_tokens, overlap_tokens):
            # The heading travels with the chunk: retrieval matches on it, and a
            # citation reads as "Runbook > Procedure" rather than a bare number.
            content = f"{heading}\n\n{piece}" if heading else piece
            chunks.append(
                TextChunk(
                    index=len(chunks),
                    content=content,
                    heading_path=heading,
                    token_count=_estimate_tokens(content),
                )
            )
    return chunks


def _split_by_size(text: str, max_tokens: int, overlap_tokens: int) -> list[str]:
    max_chars = max_tokens * CHARS_PER_TOKEN
    if len(text) <= max_chars:
        return [text]

    overlap_chars = overlap_tokens * CHARS_PER_TOKEN
    pieces: list[str] = []
    start = 0
    while start < len(text):
        end = min(len(text), start + max_chars)
        if end < len(text):
            # Prefer a paragraph or sentence boundary over a hard cut.
            boundary = max(text.rfind("\n\n", start, end), text.rfind(". ", start, end))
            if boundary > start + max_chars // 2:
                end = boundary + 1
        pieces.append(text[start:end].strip())
        if end >= len(text):
            break
        start = max(end - overlap_chars, start + 1)
    return [piece for piece in pieces if piece]
