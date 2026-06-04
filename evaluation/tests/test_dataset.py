import json
from pathlib import Path

import pytest

from evaluation.modules.dataset import load_dataset


@pytest.fixture
def valid_dataset_path(tmp_path):
    """Create a minimal valid dataset file for testing."""
    data = {
        "version": "1.0",
        "created_at": "2026-06-04",
        "total_questions": 3,
        "distribution": {"easy": 1, "medium": 1, "edge": 1},
        "questions": [
            {
                "id": "q001",
                "question": "Test easy?",
                "ground_truth": "Test answer.",
                "ground_truth_chunk_ids": ["chunk_1"],
                "difficulty": "easy",
                "category": "factual_lookup",
                "notes": "test"
            },
            {
                "id": "q002",
                "question": "Test medium?",
                "ground_truth": "Test answer.",
                "ground_truth_chunk_ids": ["chunk_1", "chunk_2"],
                "difficulty": "medium",
                "category": "multi_source",
                "notes": "test"
            },
            {
                "id": "q003",
                "question": "Test edge?",
                "ground_truth": "The sources do not contain...",
                "ground_truth_chunk_ids": [],
                "difficulty": "edge",
                "category": "edge_case",
                "notes": "test"
            }
        ]
    }
    path = tmp_path / "dataset.json"
    path.write_text(json.dumps(data), encoding='utf-8')
    return path


def test_load_valid_dataset(valid_dataset_path):
    """Loading a well-formed dataset returns a Dataset with all questions."""
    ds = load_dataset(valid_dataset_path)
    assert ds.total_questions == 3
    assert len(ds.questions) == 3
    assert ds.questions[0].id == "q001"


def test_question_is_refusal(valid_dataset_path):
    """Edge-case questions with empty chunk_ids are correctly flagged."""
    ds = load_dataset(valid_dataset_path)
    refusals = ds.refusal_questions()
    assert len(refusals) == 1
    assert refusals[0].id == "q003"


def test_by_difficulty_filter(valid_dataset_path):
    """Filtering by difficulty returns only matching questions."""
    ds = load_dataset(valid_dataset_path)
    easy = ds.by_difficulty('easy')
    assert len(easy) == 1
    assert easy[0].difficulty == 'easy'


def test_load_missing_file_raises(tmp_path):
    """Loading a non-existent file raises FileNotFoundError."""
    with pytest.raises(FileNotFoundError):
        load_dataset(tmp_path / "missing.json")


def test_load_invalid_difficulty_raises(tmp_path):
    """A question with invalid difficulty value fails validation."""
    data = {
        "version": "1.0",
        "created_at": "2026-06-04",
        "total_questions": 1,
        "distribution": {"easy": 1, "medium": 0, "edge": 0},
        "questions": [{
            "id": "q001",
            "question": "Test?",
            "ground_truth": "X",
            "ground_truth_chunk_ids": ["c1"],
            "difficulty": "INVALID",
            "category": "factual_lookup",
            "notes": ""
        }]
    }
    path = tmp_path / "bad.json"
    path.write_text(json.dumps(data))

    with pytest.raises(ValueError, match="invalid difficulty"):
        load_dataset(path)


def test_load_count_mismatch_raises(tmp_path):
    """Mismatched total_questions vs actual count fails."""
    data = {
        "version": "1.0",
        "created_at": "2026-06-04",
        "total_questions": 5,  # declares 5
        "distribution": {"easy": 1, "medium": 0, "edge": 0},
        "questions": [{  # but only 1
            "id": "q001",
            "question": "Test?",
            "ground_truth": "X",
            "ground_truth_chunk_ids": ["c1"],
            "difficulty": "easy",
            "category": "factual_lookup",
            "notes": ""
        }]
    }
    path = tmp_path / "bad.json"
    path.write_text(json.dumps(data))

    with pytest.raises(ValueError, match="count mismatch"):
        load_dataset(path)


def test_load_actual_golden_dataset():
    """Smoke test: real golden dataset loads without errors."""
    dataset_path = Path(__file__).parent.parent / "golden-dataset.json"
    if not dataset_path.exists():
        pytest.skip("Real golden-dataset.json not available")

    ds = load_dataset(dataset_path)
    assert ds.total_questions == 25
    assert len(ds.by_difficulty('easy')) == 10
    assert len(ds.by_difficulty('medium')) == 10
    assert len(ds.by_difficulty('edge')) == 5
