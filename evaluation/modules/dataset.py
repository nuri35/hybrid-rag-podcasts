"""Type-safe loader for the golden dataset (evaluation/golden-dataset.json).

Validates schema, question counts, declared-vs-actual difficulty distribution,
and ID uniqueness at load time so downstream eval steps can trust the data.
"""

from dataclasses import dataclass
from pathlib import Path
from typing import List
import json


@dataclass(frozen=True)
class Question:
    id: str
    question: str
    ground_truth: str
    ground_truth_chunk_ids: List[str]
    difficulty: str  # 'easy' | 'medium' | 'edge'
    category: str  # 'factual_lookup' | 'multi_source' | 'edge_case'
    notes: str

    @property
    def is_refusal(self) -> bool:
        """Edge case: empty ground_truth_chunk_ids means refusal expected."""
        return len(self.ground_truth_chunk_ids) == 0


@dataclass(frozen=True)
class Dataset:
    version: str
    created_at: str
    total_questions: int
    distribution: dict
    questions: List[Question]

    def by_difficulty(self, difficulty: str) -> List[Question]:
        return [q for q in self.questions if q.difficulty == difficulty]

    def by_category(self, category: str) -> List[Question]:
        return [q for q in self.questions if q.category == category]

    def refusal_questions(self) -> List[Question]:
        return [q for q in self.questions if q.is_refusal]


def load_dataset(path: Path) -> Dataset:
    """
    Load and validate the golden dataset JSON.

    Raises:
        FileNotFoundError: if path doesn't exist
        ValueError: if schema is invalid or counts don't match
    """
    if not path.exists():
        raise FileNotFoundError(f"Dataset not found: {path}")

    with open(path, 'r', encoding='utf-8') as f:
        data = json.load(f)

    # Validate top-level structure
    required_keys = {'version', 'created_at', 'total_questions', 'distribution', 'questions'}
    missing = required_keys - set(data.keys())
    if missing:
        raise ValueError(f"Dataset missing keys: {missing}")

    # Validate questions
    questions = []
    for q_data in data['questions']:
        q = _parse_question(q_data)
        questions.append(q)

    # Cross-validation
    if len(questions) != data['total_questions']:
        raise ValueError(
            f"Question count mismatch: declared {data['total_questions']}, found {len(questions)}"
        )

    # Distribution sanity check
    declared_dist = data['distribution']
    actual_easy = sum(1 for q in questions if q.difficulty == 'easy')
    actual_medium = sum(1 for q in questions if q.difficulty == 'medium')
    actual_edge = sum(1 for q in questions if q.difficulty == 'edge')

    if (actual_easy != declared_dist.get('easy', 0) or
        actual_medium != declared_dist.get('medium', 0) or
        actual_edge != declared_dist.get('edge', 0)):
        raise ValueError(
            f"Distribution mismatch: declared {declared_dist}, "
            f"actual easy={actual_easy} medium={actual_medium} edge={actual_edge}"
        )

    # ID uniqueness check
    ids = [q.id for q in questions]
    if len(ids) != len(set(ids)):
        raise ValueError("Duplicate question IDs detected")

    return Dataset(
        version=data['version'],
        created_at=data['created_at'],
        total_questions=data['total_questions'],
        distribution=data['distribution'],
        questions=questions,
    )


def _parse_question(data: dict) -> Question:
    """Parse a single question dict into Question dataclass with validation."""
    required = {'id', 'question', 'ground_truth', 'ground_truth_chunk_ids',
                'difficulty', 'category', 'notes'}
    missing = required - set(data.keys())
    if missing:
        raise ValueError(f"Question {data.get('id', '?')} missing fields: {missing}")

    # Validate difficulty
    if data['difficulty'] not in ('easy', 'medium', 'edge'):
        raise ValueError(f"Question {data['id']}: invalid difficulty '{data['difficulty']}'")

    # Validate category
    if data['category'] not in ('factual_lookup', 'multi_source', 'edge_case'):
        raise ValueError(f"Question {data['id']}: invalid category '{data['category']}'")

    # Validate chunk_ids is a list
    if not isinstance(data['ground_truth_chunk_ids'], list):
        raise ValueError(f"Question {data['id']}: ground_truth_chunk_ids must be a list")

    return Question(
        id=data['id'],
        question=data['question'],
        ground_truth=data['ground_truth'],
        ground_truth_chunk_ids=list(data['ground_truth_chunk_ids']),
        difficulty=data['difficulty'],
        category=data['category'],
        notes=data['notes'],
    )
