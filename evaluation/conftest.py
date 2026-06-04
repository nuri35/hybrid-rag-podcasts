import sys
from pathlib import Path

# Ensure the repo root is in path so tests can `from evaluation.modules.X import Y`
sys.path.insert(0, str(Path(__file__).parent.parent))
