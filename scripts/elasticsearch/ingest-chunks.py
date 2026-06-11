"""
Bulk-ingest podcast chunks from Chroma into Elasticsearch.

Phase 4 (Hybrid Retrieval), sub-phase 4.1.4. Reads every chunk from the Chroma
``podcasts`` collection (the vector-side source of truth) and indexes it into the
``podcast_chunks`` Elasticsearch index for BM25 keyword retrieval. The two stores
are bridged by ``chunk_id`` — the same id is the Chroma document id AND the ES
``_id``, so re-running this script overwrites in place and never duplicates.

Sync strategy (manual + sequential):
    Chroma is filled first by the TypeScript ingestion pipeline. This script is
    then run by hand to derive the ES index from Chroma. There is NO automatic
    trigger in Phase 4 — ES is rebuildable derived data, not a primary store.
    To re-sync after a Chroma re-ingest, just run this script again (idempotent),
    or rebuild from scratch with ``create-index.py --force`` then this script.

Usage:
    python scripts/elasticsearch/ingest-chunks.py            # full run
    python scripts/elasticsearch/ingest-chunks.py --dry-run  # read+transform only,
                                                             # print first doc, no writes

Connection (env overrides):
    CHROMA_URL           default http://localhost:8000
    ELASTICSEARCH_URL    default http://localhost:9200

Exit codes:
    0  full success (all chunks indexed, Chroma count == ES count)
    1  Chroma down / ES down / index missing / any bulk failure / count mismatch
"""

import argparse
import json
import os
import sys
import time
from urllib.parse import urlparse

from elasticsearch import Elasticsearch, helpers

INDEX_NAME = "podcast_chunks"
COLLECTION_NAME = "podcasts"
PAGE_SIZE = 1000

# Chroma metadata keys mapped straight through to ES keyword fields.
_KEYWORD_FIELDS = (
    "episode_id",
    "title",
    "date",
    "guest_name",
    "guest_affiliation",
    "guest_role",
)
# Chroma stores ALL metadata values as strings (even numerics). These map to ES
# integer fields, so they must be coerced — and an empty string ('') must become
# None, not '', or ES throws mapper_parsing_exception on the integer field.
_INTEGER_FIELDS = ("chunk_index", "total_chunks", "duration_min")


# ----------------------------------------------------------------------------
# Connections
# ----------------------------------------------------------------------------

def _connect_chroma():
    """Open the Chroma podcasts collection.

    Clears SSL_CERT_FILE-family env vars for the duration of the client's life:
    httpx (chromadb's transport) eagerly loads a CA bundle in
    ssl.create_default_context and raises PermissionError before any request if
    one of those vars points at an unreadable file. Plain HTTP to localhost needs
    no CA bundle. Caller MUST restore via the returned dict in a finally block.
    Same pattern as evaluation/modules/generation_metrics.py.
    """
    import chromadb
    from chromadb.config import Settings

    cleared_env = {}
    for var in ("SSL_CERT_FILE", "SSL_CERT_DIR", "REQUESTS_CA_BUNDLE", "CURL_CA_BUNDLE"):
        if var in os.environ:
            cleared_env[var] = os.environ.pop(var)

    url = os.environ.get("CHROMA_URL", "http://localhost:8000")
    parsed = urlparse(url)
    host = parsed.hostname or "localhost"
    port = parsed.port or 8000

    try:
        client = chromadb.HttpClient(
            host=host,
            port=port,
            settings=Settings(anonymized_telemetry=False),
        )
        client.heartbeat()
        collection = client.get_collection(COLLECTION_NAME)
    except Exception as error:  # noqa: BLE001 — fail with guidance, not a traceback
        os.environ.update(cleared_env)
        print(f"ERROR: cannot reach Chroma at {url} or open '{COLLECTION_NAME}': {error}", file=sys.stderr)
        print("Is Chroma up and ingested? Try: docker compose up -d chroma", file=sys.stderr)
        sys.exit(1)

    return collection, cleared_env


def _connect_es() -> Elasticsearch:
    url = os.environ.get("ELASTICSEARCH_URL", "http://localhost:9200")
    client = Elasticsearch(url, request_timeout=30)
    try:
        reachable = client.ping()
    except Exception as error:  # noqa: BLE001
        print(f"ERROR: cannot connect to Elasticsearch at {url}: {error}", file=sys.stderr)
        print("Is the cluster up? Try: docker compose up -d elasticsearch", file=sys.stderr)
        sys.exit(1)
    if not reachable:
        print(f"ERROR: Elasticsearch at {url} did not respond to ping.", file=sys.stderr)
        sys.exit(1)
    if not client.indices.exists(index=INDEX_NAME):
        print(f"ERROR: index '{INDEX_NAME}' does not exist. Run create-index.py first.", file=sys.stderr)
        sys.exit(1)
    return client


# ----------------------------------------------------------------------------
# Transform
# ----------------------------------------------------------------------------

def _to_int(value):
    """Coerce a Chroma string-numeric to int; '' / None -> None (skip the field)."""
    if value is None or value == "":
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _build_action(chunk_id: str, document: str, metadata: dict) -> dict:
    """Map one Chroma chunk to an ES bulk index action (overwrite by _id)."""
    source = {
        "chunk_id": chunk_id,
        "text": document or "",
    }
    for field in _KEYWORD_FIELDS:
        source[field] = metadata.get(field, "")
    for field in _INTEGER_FIELDS:
        coerced = _to_int(metadata.get(field))
        if coerced is not None:
            source[field] = coerced

    return {
        "_op_type": "index",  # index = overwrite-by-id → idempotent re-runs
        "_index": INDEX_NAME,
        "_id": chunk_id,
        "_source": source,
    }


# ----------------------------------------------------------------------------
# Main flow
# ----------------------------------------------------------------------------

def _ingest(dry_run: bool) -> int:
    collection, cleared_env = _connect_chroma()
    try:
        total = collection.count()
        print(f"Chroma collection '{COLLECTION_NAME}': {total} chunks.")
        if total == 0:
            print("ERROR: Chroma collection is empty — nothing to ingest. Run TS ingestion first.", file=sys.stderr)
            return 1

        es = None if dry_run else _connect_es()

        total_indexed = 0
        failed_ids = []
        batches = (total + PAGE_SIZE - 1) // PAGE_SIZE
        started = time.time()

        for batch_no, offset in enumerate(range(0, total, PAGE_SIZE), start=1):
            page = collection.get(
                limit=PAGE_SIZE,
                offset=offset,
                include=["documents", "metadatas"],
            )
            ids = page["ids"]
            if not ids:
                break

            actions = [
                _build_action(cid, doc, meta)
                for cid, doc, meta in zip(ids, page["documents"], page["metadatas"])
            ]

            if dry_run:
                print(f"DRY-RUN: batch {batch_no}/{batches} - {len(actions)} docs transformed (no writes).")
                if batch_no == 1 and actions:
                    print("First transformed document:")
                    print(json.dumps(actions[0], indent=2, ensure_ascii=False))
                total_indexed += len(actions)
                continue

            success, errors = helpers.bulk(es, actions, raise_on_error=False, stats_only=False)
            total_indexed += success
            batch_failed = 0
            for err in errors:
                batch_failed += 1
                op = err.get("index", err)
                failed_ids.append(op.get("_id", "<unknown>"))
            print(
                f"Batch {batch_no}/{batches} - {success} indexed, {batch_failed} failed "
                f"(offset {offset})"
            )

        elapsed = time.time() - started

        if dry_run:
            print(f"\nDRY-RUN complete: {total_indexed} docs transformed, 0 written, {elapsed:.1f}s.")
            return 0

        es.indices.refresh(index=INDEX_NAME)
        es_count = es.count(index=INDEX_NAME)["count"]

        print("\n" + "=" * 56)
        print(f"Ingestion complete in {elapsed:.1f}s")
        print(f"  batches:        {batches}")
        print(f"  indexed:        {total_indexed}")
        print(f"  failed:         {len(failed_ids)}")
        print(f"  Chroma count:   {total}")
        print(f"  ES count:       {es_count}")
        print("=" * 56)

        if failed_ids:
            print(f"WARNING: {len(failed_ids)} chunk(s) failed to index.", file=sys.stderr)
            print("Failed chunk_ids: " + ", ".join(failed_ids[:50]) +
                  (" ..." if len(failed_ids) > 50 else ""), file=sys.stderr)
            return 1
        if es_count != total:
            print(f"WARNING: COUNT MISMATCH — Chroma={total} ES={es_count}.", file=sys.stderr)
            return 1

        print("SUCCESS: Chroma and ES counts match, no failures.")
        return 0
    finally:
        os.environ.update(cleared_env)


def main() -> None:
    parser = argparse.ArgumentParser(description="Bulk-ingest Chroma chunks into Elasticsearch.")
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Read and transform only; print the first transformed doc, write nothing.",
    )
    args = parser.parse_args()
    sys.exit(_ingest(dry_run=args.dry_run))


if __name__ == "__main__":
    main()
