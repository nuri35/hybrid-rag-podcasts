"""
Build (populate) the podcast_episodes index from podcast_chunks.

Phase 5 (LLM Tool Use), sub-phase 5.1. Derives exactly ONE document per episode
from the chunk-grained podcast_chunks index. Episode-level metadata (title,
guest_name, duration_min, total_chunks) is constant across every chunk of an
episode, so we group by episode_id and take one representative chunk per group.

Source: the podcast_chunks ES index (NOT Chroma) — the metadata is already there
and this keeps the script a pure ES->ES derivation. podcast_chunks itself is
derived from Chroma (the source of truth) by ingest-chunks.py.

Idempotent: episode_id is the ES _id, so re-running overwrites in place. Rebuild
from scratch with create-episode-index.py --force then this script.

Usage:
    python scripts/elasticsearch/build-episode-index.py            # full run
    python scripts/elasticsearch/build-episode-index.py --dry-run  # transform only, no writes

Connection:
    ELASTICSEARCH_URL    default http://localhost:9200

Exit codes:
    0  success (one doc per episode, ES episode count == distinct episodes in chunks)
    1  ES down / source index missing / bulk failure / count mismatch
"""

import argparse
import json
import os
import sys
import time

from elasticsearch import Elasticsearch, helpers

SOURCE_INDEX = "podcast_chunks"
TARGET_INDEX = "podcast_episodes"
# Generous ceiling for distinct episodes (319 today). A single terms bucket scan
# is simpler than composite pagination and safe at this cardinality.
MAX_EPISODES = 10000
# Fields copied onto each episode doc (constant per episode in the chunk index).
_KEYWORD_FIELDS = ("title", "guest_name")
_INTEGER_FIELDS = ("duration_min", "total_chunks")


def _connect_es() -> Elasticsearch:
    url = os.environ.get("ELASTICSEARCH_URL", "http://localhost:9200")
    client = Elasticsearch(url, request_timeout=30)
    try:
        reachable = client.ping()
    except Exception as error:  # noqa: BLE001 — fail with guidance, not a traceback
        print(f"ERROR: cannot connect to Elasticsearch at {url}: {error}", file=sys.stderr)
        print("Is the cluster up? Try: docker compose up -d elasticsearch", file=sys.stderr)
        sys.exit(1)
    if not reachable:
        print(f"ERROR: Elasticsearch at {url} did not respond to ping.", file=sys.stderr)
        sys.exit(1)
    if not client.indices.exists(index=SOURCE_INDEX):
        print(f"ERROR: source index '{SOURCE_INDEX}' does not exist. Run create-index.py + "
              f"ingest-chunks.py first.", file=sys.stderr)
        sys.exit(1)
    if not client.indices.exists(index=TARGET_INDEX):
        print(f"ERROR: target index '{TARGET_INDEX}' does not exist. Run "
              f"create-episode-index.py first.", file=sys.stderr)
        sys.exit(1)
    return client


def _fetch_episode_sources(es: Elasticsearch) -> list:
    """Group podcast_chunks by episode_id, take one representative chunk per group."""
    response = es.search(
        index=SOURCE_INDEX,
        size=0,
        aggs={
            "episodes": {
                "terms": {"field": "episode_id", "size": MAX_EPISODES},
                "aggs": {
                    "one": {
                        "top_hits": {
                            "size": 1,
                            "_source": list(_KEYWORD_FIELDS) + list(_INTEGER_FIELDS),
                        }
                    }
                },
            }
        },
    )
    buckets = response["aggregations"]["episodes"]["buckets"]
    if len(buckets) >= MAX_EPISODES:
        print(f"WARNING: hit the MAX_EPISODES ceiling ({MAX_EPISODES}); some episodes may be "
              f"missing. Raise MAX_EPISODES.", file=sys.stderr)
    return buckets


def _build_action(bucket: dict) -> dict:
    """Map one episode_id bucket to an ES bulk index action (overwrite by _id)."""
    episode_id = bucket["key"]
    rep = bucket["one"]["hits"]["hits"][0]["_source"]
    source = {"episode_id": episode_id}
    for field in _KEYWORD_FIELDS:
        source[field] = rep.get(field, "")
    for field in _INTEGER_FIELDS:
        value = rep.get(field)
        if value is not None:
            source[field] = value
    return {
        "_op_type": "index",  # overwrite-by-id → idempotent re-runs
        "_index": TARGET_INDEX,
        "_id": episode_id,
        "_source": source,
    }


def _build(dry_run: bool) -> int:
    es = _connect_es()

    started = time.time()
    buckets = _fetch_episode_sources(es)
    distinct_episodes = len(buckets)
    print(f"Source '{SOURCE_INDEX}': {distinct_episodes} distinct episodes.")
    if distinct_episodes == 0:
        print("ERROR: no episodes found — is podcast_chunks populated?", file=sys.stderr)
        return 1

    actions = [_build_action(b) for b in buckets]

    if dry_run:
        print(f"DRY-RUN: {len(actions)} episode docs transformed (no writes).")
        print("First transformed document:")
        print(json.dumps(actions[0]["_source"], indent=2, ensure_ascii=False))
        print(f"\nDRY-RUN complete in {time.time() - started:.1f}s.")
        return 0

    success, errors = helpers.bulk(es, actions, raise_on_error=False, stats_only=False)
    failed_ids = [e.get("index", e).get("_id", "<unknown>") for e in errors]

    es.indices.refresh(index=TARGET_INDEX)
    es_count = es.count(index=TARGET_INDEX)["count"]
    elapsed = time.time() - started

    print("\n" + "=" * 56)
    print(f"Episode index build complete in {elapsed:.1f}s")
    print(f"  distinct episodes: {distinct_episodes}")
    print(f"  indexed:           {success}")
    print(f"  failed:            {len(failed_ids)}")
    print(f"  ES episode count:  {es_count}")
    print("=" * 56)

    if failed_ids:
        print(f"WARNING: {len(failed_ids)} episode(s) failed to index: "
              + ", ".join(failed_ids[:50]), file=sys.stderr)
        return 1
    if es_count != distinct_episodes:
        print(f"WARNING: COUNT MISMATCH — distinct={distinct_episodes} ES={es_count}.", file=sys.stderr)
        return 1

    print("SUCCESS: one document per episode, counts match.")
    return 0


def main() -> None:
    parser = argparse.ArgumentParser(description="Build podcast_episodes from podcast_chunks.")
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Group and transform only; print the first episode doc, write nothing.",
    )
    args = parser.parse_args()
    sys.exit(_build(dry_run=args.dry_run))


if __name__ == "__main__":
    main()
