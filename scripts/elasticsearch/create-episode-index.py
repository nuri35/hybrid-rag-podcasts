"""
Create the podcast_episodes index in Elasticsearch.

Phase 5 (LLM Tool Use), sub-phase 5.1. Creates the EPISODE-grained index from
the mapping at scripts/elasticsearch/mappings/podcast_episodes.json. Does NOT
populate documents — that is build-episode-index.py.

Why a separate episode index: the podcast_chunks index is CHUNK-grained (1 doc
per chunk), so raw doc_count aggregations are biased by chunk count per episode
(e.g. "which guest most often" gives Michael Malice by chunks vs Eric Weinstein
by episodes). This index holds exactly one doc per episode, so count / group_by /
avg are structurally correct for the query_metadata tool. It is derived,
rebuildable data — Chroma stays the source of truth. See PHASE_5_1_PLAN.md.

Usage:
    python scripts/elasticsearch/create-episode-index.py           # safe, skip if exists
    python scripts/elasticsearch/create-episode-index.py --force    # delete and recreate

Connection:
    Defaults to http://localhost:9200, override with ELASTICSEARCH_URL.
"""

import argparse
import json
import os
import sys
from pathlib import Path

from elasticsearch import Elasticsearch

INDEX_NAME = "podcast_episodes"
MAPPING_PATH = Path(__file__).parent / "mappings" / "podcast_episodes.json"


def get_client() -> Elasticsearch:
    url = os.environ.get("ELASTICSEARCH_URL", "http://localhost:9200")
    # request_timeout keeps a dead/booting cluster from hanging the script.
    client = Elasticsearch(url, request_timeout=10)
    try:
        reachable = client.ping()
    except Exception as error:  # noqa: BLE001 — fail with guidance, not a traceback
        print(f"ERROR: Cannot connect to Elasticsearch at {url}: {error}", file=sys.stderr)
        print("Is the cluster up? Try: docker compose up -d elasticsearch", file=sys.stderr)
        sys.exit(1)
    if not reachable:
        print(f"ERROR: Elasticsearch at {url} did not respond to ping.", file=sys.stderr)
        print("Is the cluster up? Try: docker compose up -d elasticsearch", file=sys.stderr)
        sys.exit(1)
    return client


def load_mapping() -> dict:
    if not MAPPING_PATH.exists():
        print(f"ERROR: Mapping file not found: {MAPPING_PATH}", file=sys.stderr)
        sys.exit(1)
    return json.loads(MAPPING_PATH.read_text(encoding="utf-8"))


def create_index(force: bool = False) -> None:
    client = get_client()
    mapping = load_mapping()

    if client.indices.exists(index=INDEX_NAME):
        if force:
            print(f"Index '{INDEX_NAME}' exists. Deleting (--force flag passed)...")
            client.indices.delete(index=INDEX_NAME)
        else:
            print(f"WARNING: Index '{INDEX_NAME}' already exists. Use --force to recreate.")
            return

    print(f"Creating index '{INDEX_NAME}'...")
    # elasticsearch-py 8.x: pass settings/mappings as explicit kwargs.
    client.indices.create(
        index=INDEX_NAME,
        settings=mapping["settings"],
        mappings=mapping["mappings"],
    )

    info = client.indices.get(index=INDEX_NAME)
    print(f"Index '{INDEX_NAME}' created successfully.")
    print("Settings:")
    print(json.dumps(info[INDEX_NAME]["settings"], indent=2))


def main() -> None:
    parser = argparse.ArgumentParser(description="Create the podcast_episodes Elasticsearch index.")
    parser.add_argument(
        "--force",
        action="store_true",
        help="Delete and recreate the index if it already exists.",
    )
    args = parser.parse_args()
    create_index(force=args.force)


if __name__ == "__main__":
    main()
