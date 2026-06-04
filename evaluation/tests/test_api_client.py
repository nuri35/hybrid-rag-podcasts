from unittest.mock import MagicMock, patch

import pytest

from evaluation.modules.api_client import ApiClient


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
