"""Embedding providers.

`fastembed` runs ONNX models on CPU and keeps the image small. The hashing
provider is deterministic and needs no model download, which is what makes
tests and CI fast and offline — it is never the default in a real deployment.
"""

import hashlib
import math
import re
from collections import Counter
from typing import Protocol

from opspilot_ai.logging import get_logger

logger = get_logger(__name__)

TOKEN = re.compile(r"[a-z0-9_]+")


def tokenize(text: str) -> list[str]:
    return TOKEN.findall(text.lower())


class Embedder(Protocol):
    """Dense and sparse vectors come from one provider: both are needed for
    every indexed chunk, and splitting them would only add a second lifecycle."""

    dimensions: int

    def embed_documents(self, texts: list[str]) -> list[list[float]]: ...

    def embed_query(self, text: str) -> list[float]: ...

    def embed_documents_sparse(self, texts: list[str]) -> list[dict[int, float]]: ...

    def embed_query_sparse(self, text: str) -> dict[int, float]: ...


class HashingEmbedder:
    """Deterministic bag-of-words vectors: no model, no download, no network.

    Similar texts land near each other because they share tokens, which is
    enough to exercise the pipeline end to end; it is not a semantic model and
    is not used outside tests and offline development.
    """

    def __init__(self, dimensions: int = 384) -> None:
        self.dimensions = dimensions

    def _vector(self, text: str) -> list[float]:
        vector = [0.0] * self.dimensions
        for token, weight in Counter(tokenize(text)).items():
            digest = hashlib.blake2b(token.encode(), digest_size=8).digest()
            index = int.from_bytes(digest, "big") % self.dimensions
            vector[index] += 1.0 + math.log(weight)
        norm = math.sqrt(sum(value * value for value in vector)) or 1.0
        return [value / norm for value in vector]

    def embed_documents(self, texts: list[str]) -> list[list[float]]:
        return [self._vector(text) for text in texts]

    def embed_query(self, text: str) -> list[float]:
        return self._vector(text)

    def embed_documents_sparse(self, texts: list[str]) -> list[dict[int, float]]:
        return [self._sparse(text) for text in texts]

    def embed_query_sparse(self, text: str) -> dict[int, float]:
        return self._sparse(text)

    @staticmethod
    def _sparse(text: str) -> dict[int, float]:
        counts = Counter(tokenize(text))
        return {
            int.from_bytes(hashlib.blake2b(token.encode(), digest_size=4).digest(), "big")
            % (2**31): 1.0 + math.log(weight)
            for token, weight in counts.items()
        }


class FastEmbedEmbedder:
    """Real dense + sparse embeddings via fastembed (ONNX, CPU)."""

    def __init__(
        self,
        dense_model: str = "BAAI/bge-small-en-v1.5",
        sparse_model: str = "Qdrant/bm25",
        dimensions: int = 384,
    ) -> None:
        from fastembed import SparseTextEmbedding, TextEmbedding

        self.dimensions = dimensions
        self._dense = TextEmbedding(model_name=dense_model)
        self._sparse = SparseTextEmbedding(model_name=sparse_model)
        logger.info("embedder_loaded", dense=dense_model, sparse=sparse_model)

    def embed_documents(self, texts: list[str]) -> list[list[float]]:
        return [list(map(float, vector)) for vector in self._dense.embed(texts)]

    def embed_query(self, text: str) -> list[float]:
        return next(iter(self.embed_documents([text])))

    def embed_documents_sparse(self, texts: list[str]) -> list[dict[int, float]]:
        return [
            dict(zip(map(int, vector.indices), map(float, vector.values), strict=True))
            for vector in self._sparse.embed(texts)
        ]

    def embed_query_sparse(self, text: str) -> dict[int, float]:
        return next(iter(self.embed_documents_sparse([text])))


def create_embedder(provider: str) -> Embedder:
    if provider == "fastembed":
        return FastEmbedEmbedder()
    return HashingEmbedder()
