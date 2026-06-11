"""
Smoke-test the podcast_chunks Elasticsearch index.

Phase 4 (Hybrid Retrieval), sub-phase 4.1.5. Re-runnable verification suite for
the BM25 keyword index. MEASUREMENT ONLY — this script never tunes the analyzer,
mapping, or query DSL. It reports what BM25 alone retrieves so we can judge how
much keyword search fixes before RRF fusion + the vector side are added.

Runs 8 checks and prints a PASS/FAIL summary table:
    1. Cluster health (green/yellow)
    2. Document count (ES == Chroma)
    3. Basic searchability ("Turing machine")
    4. Rare-term precision ("constructors abstractors")
    5. Stemming sanity ("machines" vs "machine" overlap — english analyzer)
    6. Stopword sanity ("the of and" — stopwords removed)
    7. Nonexistent term ("xyzqwerty123" — 0 hits)
    8. Ground-truth spot check for the 4 failing baseline questions
       (q006/q012/q014/q017), ranks read live from evaluation/golden-dataset.json

Usage:
    python scripts/elasticsearch/smoke-test.py

Connection (env overrides): ELASTICSEARCH_URL, CHROMA_URL.
"""

import json
import os
import sys
from pathlib import Path
from urllib.parse import urlparse

from elasticsearch import Elasticsearch

# Windows consoles default to cp1252 and choke on the check/cross glyphs below.
try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:  # noqa: BLE001 — older Python / non-reconfigurable stream
    pass

INDEX_NAME = "podcast_chunks"
COLLECTION_NAME = "podcasts"
GOLDEN_PATH = Path(__file__).resolve().parents[2] / "evaluation" / "golden-dataset.json"
FAILING_QUESTIONS = ("q006", "q012", "q014", "q017")

TICK = "✓"  # ✓
CROSS = "✗"  # ✗


def _es() -> Elasticsearch:
    url = os.environ.get("ELASTICSEARCH_URL", "http://localhost:9200")
    client = Elasticsearch(url, request_timeout=30)
    if not client.ping():
        print(f"ERROR: Elasticsearch not reachable at {url}.", file=sys.stderr)
        sys.exit(1)
    return client


def _chroma_count() -> int:
    """Live Chroma count, with the SSL_CERT_FILE-family workaround."""
    import chromadb
    from chromadb.config import Settings

    cleared = {}
    for var in ("SSL_CERT_FILE", "SSL_CERT_DIR", "REQUESTS_CA_BUNDLE", "CURL_CA_BUNDLE"):
        if var in os.environ:
            cleared[var] = os.environ.pop(var)
    url = os.environ.get("CHROMA_URL", "http://localhost:8000")
    parsed = urlparse(url)
    try:
        client = chromadb.HttpClient(
            host=parsed.hostname or "localhost",
            port=parsed.port or 8000,
            settings=Settings(anonymized_telemetry=False),
        )
        return client.get_collection(COLLECTION_NAME).count()
    except Exception as error:  # noqa: BLE001
        print(f"  WARNING: cannot read Chroma count: {error}")
        return -1
    finally:
        os.environ.update(cleared)


def _search(es: Elasticsearch, text: str, size: int = 10):
    """match query on the english-analyzed text field; returns list of (id, score)."""
    resp = es.search(
        index=INDEX_NAME,
        size=size,
        query={"match": {"text": text}},
        _source=False,
    )
    return [(h["_id"], h["_score"]) for h in resp["hits"]["hits"]]


def main() -> None:
    es = _es()
    rows = []  # (check label, result string, passed)

    # --- Check 1: cluster health ------------------------------------------
    health = es.cluster.health()
    status = health["status"]
    rows.append(("1. Cluster health", f"{status}", status in ("green", "yellow")))

    # --- Check 2: document count ------------------------------------------
    es.indices.refresh(index=INDEX_NAME)
    es_count = es.count(index=INDEX_NAME)["count"]
    chroma_count = _chroma_count()
    rows.append((
        "2. Count match",
        f"ES={es_count} Chroma={chroma_count}",
        chroma_count != -1 and es_count == chroma_count,
    ))

    # --- Check 3: basic searchability -------------------------------------
    hits = _search(es, "Turing machine", size=3)
    print("\n[Check 3] 'Turing machine' top 3:")
    for cid, score in hits:
        print(f"    {cid}  score={score:.3f}")
    rows.append(("3. Basic search", f"{len(hits)} hits", len(hits) >= 1))

    # --- Check 4: rare-term precision -------------------------------------
    hits = _search(es, "constructors abstractors", size=3)
    print("\n[Check 4] 'constructors abstractors' top 3:")
    for cid, score in hits:
        print(f"    {cid}  score={score:.3f}")
    rows.append(("4. Rare-term precision", f"{len(hits)} hits", len(hits) >= 1))

    # --- Check 5: stemming sanity -----------------------------------------
    singular = {cid for cid, _ in _search(es, "machine", size=10)}
    plural = {cid for cid, _ in _search(es, "machines", size=10)}
    overlap = singular & plural
    print(f"\n[Check 5] stemming: 'machine' vs 'machines' top-10 overlap = {len(overlap)}")
    rows.append(("5. Stemming overlap", f"{len(overlap)}/10 shared", len(overlap) >= 1))

    # --- Check 6: stopword sanity -----------------------------------------
    stop_hits = _search(es, "the of and", size=10)
    print(f"\n[Check 6] stopwords-only 'the of and' → {len(stop_hits)} hits "
          f"(english analyzer should strip these)")
    rows.append(("6. Stopword removal", f"{len(stop_hits)} hits", len(stop_hits) == 0))

    # --- Check 7: nonexistent term ----------------------------------------
    none_hits = _search(es, "xyzqwerty123", size=10)
    rows.append(("7. Nonexistent term", f"{len(none_hits)} hits", len(none_hits) == 0))

    # --- Check 8: ground-truth spot check ---------------------------------
    print("\n[Check 8] Ground-truth ranks for the 4 failing baseline questions:")
    golden = json.loads(GOLDEN_PATH.read_text(encoding="utf-8"))
    by_id = {q["id"]: q for q in golden["questions"]}

    print(f"    {'qid':<6} {'top5':<5} {'rank/10':<9} ground-truth chunk_id(s)")
    print(f"    {'-'*6} {'-'*5} {'-'*9} {'-'*40}")
    gt_results = []
    for qid in FAILING_QUESTIONS:
        q = by_id[qid]
        gt_ids = q["ground_truth_chunk_ids"]
        ranked = [cid for cid, _ in _search(es, q["question"], size=10)]
        top5 = set(ranked[:5])

        best_rank = None
        for gt in gt_ids:
            if gt in ranked:
                r = ranked.index(gt) + 1
                best_rank = r if best_rank is None else min(best_rank, r)
        in_top5 = any(gt in top5 for gt in gt_ids)

        rank_str = f"#{best_rank}" if best_rank is not None else "not in 10"
        top5_str = f"{TICK}" if in_top5 else f"{CROSS}"
        print(f"    {qid:<6} {top5_str:<5} {rank_str:<9} {', '.join(gt_ids)}")
        gt_results.append((qid, in_top5, best_rank))

    found_in_top5 = sum(1 for _, t5, _ in gt_results if t5)
    # Check 8 is MEASUREMENT — it never "fails" the suite; BM25 missing some of
    # the 4 is expected at this stage (RRF + vector side help later).
    rows.append((
        "8. Ground-truth (measure)",
        f"{found_in_top5}/4 in top5",
        True,
    ))

    # --- Summary table ----------------------------------------------------
    print("\n" + "=" * 56)
    print(f"{'CHECK':<28} {'RESULT':<20} {'STATUS'}")
    print("-" * 56)
    all_pass = True
    for label, result, passed in rows:
        mark = "PASS" if passed else "FAIL"
        if not passed:
            all_pass = False
        print(f"{label:<28} {result:<20} {mark}")
    print("=" * 56)
    print(f"\nGround-truth detail: {found_in_top5}/4 questions have a ground-truth chunk in BM25 top-5.")
    print("(Check 8 is measurement-only; it does not fail the suite.)")

    sys.exit(0 if all_pass else 1)


if __name__ == "__main__":
    main()
