"""
Sanity tests for the orchestrator. Real end-to-end testing happens in the
actual baseline run, not here.
"""

import pytest
from unittest.mock import patch, MagicMock
from pathlib import Path
from io import StringIO
import sys


def test_parse_args_defaults():
    """Default CLI args produce expected values."""
    from evaluation.run_eval import parse_args, DEFAULT_DATASET_PATH, DEFAULT_API_BASE

    with patch('sys.argv', ['run-eval.py']):
        args = parse_args()

    assert args.dataset == DEFAULT_DATASET_PATH
    assert args.api_base == DEFAULT_API_BASE
    assert args.skip_cache_flush is False
    assert args.max_questions is None


def test_parse_args_overrides():
    """CLI args can be overridden."""
    from evaluation.run_eval import parse_args

    with patch('sys.argv', ['run-eval.py', '--max-questions', '3', '--skip-cache-flush']):
        args = parse_args()

    assert args.max_questions == 3
    assert args.skip_cache_flush is True


def test_validate_environment_missing_key_exits(monkeypatch):
    """Missing GOOGLE_API_KEY exits with error."""
    from evaluation.run_eval import validate_environment

    monkeypatch.delenv("GOOGLE_API_KEY", raising=False)
    monkeypatch.setattr("evaluation.run_eval.load_dotenv", lambda: None)

    with pytest.raises(SystemExit) as exc_info:
        validate_environment()

    assert exc_info.value.code == 1


def test_validate_environment_with_key_passes(monkeypatch):
    """Valid env passes silently."""
    from evaluation.run_eval import validate_environment

    monkeypatch.setenv("GOOGLE_API_KEY", "fake-key-123")
    monkeypatch.setattr("evaluation.run_eval.load_dotenv", lambda: None)

    validate_environment()  # Should not raise


def test_check_api_health_failure_exits():
    """API down should cause exit."""
    from evaluation.run_eval import check_api_health
    import requests

    with patch('evaluation.run_eval.requests.get') as mock_get:
        mock_get.side_effect = requests.RequestException("Connection refused")

        with pytest.raises(SystemExit) as exc_info:
            check_api_health("http://localhost:3000")

        assert exc_info.value.code == 1


def test_check_api_health_non_200_exits():
    """API responding with 500 should cause exit."""
    from evaluation.run_eval import check_api_health

    mock_response = MagicMock()
    mock_response.status_code = 500
    mock_response.text = "Internal error"

    with patch('evaluation.run_eval.requests.get', return_value=mock_response):
        with pytest.raises(SystemExit) as exc_info:
            check_api_health("http://localhost:3000")

        assert exc_info.value.code == 1


def test_check_api_health_success_passes():
    """API returning 200 passes silently."""
    from evaluation.run_eval import check_api_health

    mock_response = MagicMock()
    mock_response.status_code = 200

    with patch('evaluation.run_eval.requests.get', return_value=mock_response):
        check_api_health("http://localhost:3000")  # Should not raise


def test_prepare_output_dir_default(tmp_path, monkeypatch):
    """Default output dir uses date-based name."""
    from evaluation.run_eval import prepare_output_dir

    monkeypatch.chdir(tmp_path)
    output = prepare_output_dir(None)

    assert output.exists()
    assert "baseline-" in output.name


def test_prepare_output_dir_explicit(tmp_path):
    """Explicit output path is honored."""
    from evaluation.run_eval import prepare_output_dir

    target = tmp_path / "custom-output"
    output = prepare_output_dir(str(target))

    assert output.exists()
    assert output == target


def test_flush_qa_cache_docker_missing_warns():
    """If docker command is missing, prints warning but doesn't crash."""
    from evaluation.run_eval import flush_qa_cache

    with patch('evaluation.run_eval.subprocess.run', side_effect=FileNotFoundError):
        flush_qa_cache("hybrid-rag-redis")  # Should not raise


def test_flush_qa_cache_no_keys_succeeds():
    """Empty scan result handled gracefully."""
    from evaluation.run_eval import flush_qa_cache

    mock_scan = MagicMock()
    mock_scan.returncode = 0
    mock_scan.stdout = ""

    with patch('evaluation.run_eval.subprocess.run', return_value=mock_scan):
        flush_qa_cache("hybrid-rag-redis")  # Should not raise


def test_query_all_questions_handles_api_failure():
    """A failing API call doesn't abort the loop; placeholder result added."""
    from evaluation.run_eval import query_all_questions
    from evaluation.modules.dataset import Question

    questions = [
        Question(id="q001", question="Q1?", ground_truth="A1",
                 ground_truth_chunk_ids=["c1"], difficulty="easy",
                 category="factual_lookup", notes=""),
        Question(id="q002", question="Q2?", ground_truth="A2",
                 ground_truth_chunk_ids=["c2"], difficulty="easy",
                 category="factual_lookup", notes=""),
    ]

    with patch('evaluation.run_eval.ApiClient') as MockClient:
        instance = MockClient.return_value
        instance.query.side_effect = [
            MagicMock(question="Q1?", answer="A1", sources=[]),
            Exception("Connection error"),
        ]

        results, failed = query_all_questions(questions, "http://localhost:3000", sleep_ms=0)

    assert len(results) == 2
    assert len(failed) == 1
    assert failed[0][0].id == "q002"
    assert results[1].answer == "[QUERY FAILED]"
