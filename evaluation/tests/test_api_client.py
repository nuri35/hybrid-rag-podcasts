from unittest.mock import MagicMock, patch

import pytest

from evaluation.modules.api_client import ApiClient, QueryResult, Source
from evaluation.modules.retrieval_metrics import compute_per_question_scores


@pytest.fixture
def mock_successful_response():
    """Mock a successful API response."""
    return {
        "answer": "Test answer with [Source 1].",
        "sources": [
            {
                "chunkId": "chunk_1",
                "score": 0.85,
                "excerpt": "Excerpt text...",
                "metadata": {"episode_id": "1"}
            },
            {
                "chunkId": "chunk_2",
                "score": 0.78,
                "excerpt": "Another excerpt...",
                "metadata": {"episode_id": "1"}
            }
        ]
    }


# ============================================================
# Phase 4 — fused top-K metadata parsing + rank-source split
# ============================================================

def test_parses_retrieval_metadata_fused_top_k():
    """retrievalMetadata.fusedTopK parses into fused_top_k_ids (rank order)."""
    client = ApiClient()
    resp = {
        "answer": "A [Source 1].",
        # expanded context (what the LLM saw) = 1 chunk
        "sources": [{"chunkId": "x_chunk_5", "score": 0.0, "excerpt": "", "metadata": {}}],
        # pre-expansion fused ranked list = 2 chunks
        "retrievalMetadata": {"fusedTopK": [
            {"chunkId": "x_chunk_5", "rrfScore": 0.031, "rank": 1},
            {"chunkId": "x_chunk_9", "rrfScore": 0.016, "rank": 2},
        ]},
    }
    with patch('requests.post') as mock_post:
        mock_post.return_value.status_code = 200
        mock_post.return_value.json.return_value = resp
        r = client.query("q")

    assert r.fused_top_k_ids == ["x_chunk_5", "x_chunk_9"]
    assert r.rank_chunk_ids == ["x_chunk_5", "x_chunk_9"]   # rank metrics read this
    assert r.retrieved_chunk_ids == ["x_chunk_5"]            # generation reads this (expanded)


def test_rank_chunk_ids_falls_back_to_expanded_when_metadata_absent(mock_successful_response):
    """Old API / cache hit without retrievalMetadata → rank uses expanded list."""
    client = ApiClient()
    with patch('requests.post') as mock_post:
        mock_post.return_value.status_code = 200
        mock_post.return_value.json.return_value = mock_successful_response
        r = client.query("q")

    assert r.fused_top_k_ids == []
    assert r.rank_chunk_ids == r.retrieved_chunk_ids == ["chunk_1", "chunk_2"]


def test_fused_vs_expanded_rank_metric_proof():
    """THE methodology-fix proof: the SAME GT scores differently depending on
    which list rank metrics read. Over the expanded list it would MISS (GT at
    rank 6); over the fused list it HITS (GT at rank 3)."""
    gt = ["59_chunk_12"]
    # Expanded context: 5 filler chunks then GT → GT at index 5 (rank 6), out of top-5.
    expanded = [Source(chunk_id=f"c{i}", score=0.0, excerpt="", metadata={}) for i in range(5)]
    expanded.append(Source(chunk_id="59_chunk_12", score=0.0, excerpt="", metadata={}))
    # Fused (pre-expansion): GT at index 2 (rank 3).
    qr = QueryResult(
        question="q", answer="a [Source 1].", sources=expanded,
        fused_top_k_ids=["a", "b", "59_chunk_12", "d", "e"],
    )

    over_expanded = compute_per_question_scores(
        retrieved_ids=qr.retrieved_chunk_ids, ground_truth_ids=gt, k=5)
    over_fused = compute_per_question_scores(
        retrieved_ids=qr.rank_chunk_ids, ground_truth_ids=gt, k=5)

    assert over_expanded.hit_at_k == 0.0      # broken: neighbors pushed GT out of top-5
    assert over_fused.hit_at_k == 1.0          # fixed: fused list hits
    assert abs(over_fused.mrr - (1.0 / 3.0)) < 1e-9   # GT at fused rank 3


def test_query_parses_successful_response(mock_successful_response):
    """A 200 response with valid JSON parses correctly."""
    client = ApiClient()

    with patch('requests.post') as mock_post:
        mock_post.return_value.status_code = 200
        mock_post.return_value.json.return_value = mock_successful_response

        result = client.query("test question")

        assert result.question == "test question"
        assert result.answer == "Test answer with [Source 1]."
        assert len(result.sources) == 2
        assert result.sources[0].chunk_id == "chunk_1"
        assert result.retrieved_chunk_ids == ["chunk_1", "chunk_2"]


def test_query_handles_rate_limit_then_succeeds(mock_successful_response):
    """A 429 followed by 200 retries and eventually succeeds."""
    client = ApiClient(max_retries=3)

    with patch('requests.post') as mock_post, patch('time.sleep'):
        responses = [MagicMock(status_code=429, headers={'Retry-After': '1'}),
                     MagicMock(status_code=200)]
        responses[1].json.return_value = mock_successful_response
        mock_post.side_effect = responses

        result = client.query("test")
        assert result.answer == "Test answer with [Source 1]."
        assert mock_post.call_count == 2


def test_query_raises_on_malformed_response():
    """Response missing 'answer' or 'sources' raises ValueError."""
    client = ApiClient()

    with patch('requests.post') as mock_post:
        mock_post.return_value.status_code = 200
        mock_post.return_value.json.return_value = {"oops": "bad"}

        with pytest.raises(ValueError, match="Malformed API response"):
            client.query("test")


def test_query_retries_on_503_then_gives_up():
    """Persistent 503 eventually raises after max_retries."""
    client = ApiClient(max_retries=2)

    with patch('requests.post') as mock_post, patch('time.sleep'):
        mock_post.return_value.status_code = 503

        with pytest.raises(RuntimeError, match="Query failed after"):
            client.query("test")
