"""HTTP client for the NestJS QA endpoint (POST /api/v1/questions).

Rate-limit-aware (Sprint Rate-Limit ships per-IP throttling): honors 429
Retry-After, backs off on 503 (ingestion lock / circuit open), and retries
timeouts before giving up.
"""

from dataclasses import dataclass, field
from typing import List
import time

import requests


DEFAULT_API_BASE = "http://localhost:3000"
DEFAULT_TIMEOUT_SECONDS = 60  # LLM call can be slow
DEFAULT_BACKOFF_SECONDS = 5  # wait when rate-limited / unavailable


@dataclass(frozen=True)
class Source:
    chunk_id: str
    score: float
    excerpt: str
    metadata: dict


@dataclass(frozen=True)
class QueryResult:
    question: str
    answer: str
    sources: List[Source]
    # Phase 4 eval methodology: the pre-expansion RRF-fused ranked list
    # (retrievalMetadata.fusedTopK), in rank order. RANK metrics
    # (MRR/Hit@K/Precision@K) are scored over THIS list, not `sources` (the
    # expanded LLM context). Falls back to the expanded ids when the API omits
    # the metadata (cache hit / older API), so older runs still score.
    fused_top_k_ids: List[str] = field(default_factory=list)

    @property
    def retrieved_chunk_ids(self) -> List[str]:
        """The EXPANDED context ids in order (what the LLM saw). Used for
        generation metrics; NOT for rank metrics — see `rank_chunk_ids`."""
        return [s.chunk_id for s in self.sources]

    @property
    def rank_chunk_ids(self) -> List[str]:
        """The list to score RANK metrics over: the pre-expansion fused top-K
        when present, else the expanded context (backward-compatible)."""
        return self.fused_top_k_ids if self.fused_top_k_ids else self.retrieved_chunk_ids


class ApiClient:
    """
    HTTP client for the NestJS QA endpoint.

    Handles:
    - 429 (rate limit) with Retry-After-driven backoff
    - 503 (lock active / circuit open) with retry after delay
    - 500 / network errors propagated
    """

    def __init__(
        self,
        base_url: str = DEFAULT_API_BASE,
        timeout_seconds: int = DEFAULT_TIMEOUT_SECONDS,
        max_retries: int = 3,
    ):
        self.base_url = base_url.rstrip('/')
        self.timeout = timeout_seconds
        self.max_retries = max_retries

    def query(self, question: str) -> QueryResult:
        """
        Send a question to POST /api/v1/questions and parse the response.

        Raises:
            requests.RequestException: on persistent network failure
            ValueError: on malformed response
            RuntimeError: on persistent 429/503 after retries
        """
        url = f"{self.base_url}/api/v1/questions"
        payload = {"question": question}

        for attempt in range(self.max_retries):
            try:
                response = requests.post(url, json=payload, timeout=self.timeout)

                if response.status_code == 200:
                    return self._parse_response(question, response.json())

                if response.status_code == 429:
                    retry_after = int(response.headers.get('Retry-After', DEFAULT_BACKOFF_SECONDS))
                    print(f"  Rate limited (429), waiting {retry_after}s...")
                    time.sleep(retry_after)
                    continue

                if response.status_code == 503:
                    print(f"  Service unavailable (503), waiting {DEFAULT_BACKOFF_SECONDS}s...")
                    time.sleep(DEFAULT_BACKOFF_SECONDS)
                    continue

                # Other status codes: raise immediately
                response.raise_for_status()

            except requests.Timeout:
                if attempt < self.max_retries - 1:
                    print(f"  Timeout, retrying ({attempt + 1}/{self.max_retries})...")
                    time.sleep(2)
                    continue
                raise

        raise RuntimeError(f"Query failed after {self.max_retries} retries: {question[:50]}")

    def _parse_response(self, question: str, data: dict) -> QueryResult:
        """Parse the API response JSON into a QueryResult."""
        if 'answer' not in data or 'sources' not in data:
            raise ValueError(
                f"Malformed API response: missing 'answer' or 'sources'. Got keys: {list(data.keys())}"
            )

        sources = []
        for s in data.get('sources', []):
            sources.append(Source(
                chunk_id=s['chunkId'],
                score=s['score'],
                excerpt=s.get('excerpt', ''),
                metadata=s.get('metadata', {}),
            ))

        # Phase 4: pre-expansion fused top-K for rank metrics. Optional —
        # absent on cache hits / empty-retrieval / older API → empty list.
        fused_top_k_ids = []
        meta = data.get('retrievalMetadata')
        if isinstance(meta, dict):
            for entry in meta.get('fusedTopK', []):
                cid = entry.get('chunkId')
                if cid is not None:
                    fused_top_k_ids.append(cid)

        return QueryResult(
            question=question,
            answer=data['answer'],
            sources=sources,
            fused_top_k_ids=fused_top_k_ids,
        )
