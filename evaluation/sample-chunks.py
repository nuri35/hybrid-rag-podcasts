"""Sample consecutive chunks from Chroma for golden-dataset preparation.

Read-only helper for Phase 2 (Evaluation). Connects to the local Chroma
server, discovers all episodes from chunk metadata, samples 8 episodes with
distinct guests for thematic diversity, pulls a consecutive run of 10-15
chunks from each, and writes them to ``evaluation/chunks-for-dataset.md``
in a human-readable format.

Usage (from repo root, venv active):
    python evaluation/sample-chunks.py

Idempotent: re-running is safe (output file is overwritten); sampling is
random, so successive runs may select different episodes/windows.
"""

from __future__ import annotations

import random
import sys
from pathlib import Path

try:
    import chromadb
except ImportError:
    print(
        "ERROR: the 'chromadb' package is not installed.\n"
        "Install evaluation dependencies first:\n"
        "    pip install -r requirements-eval.txt",
        file=sys.stderr,
    )
    sys.exit(1)

# --- Configuration (mirrors the NestJS env defaults) -----------------------

CHROMA_HOST = "localhost"
CHROMA_PORT = 8000
COLLECTION_NAME = "podcasts"

EPISODES_TO_SAMPLE = 8
MIN_CHUNKS_PER_EPISODE = 10
MAX_CHUNKS_PER_EPISODE = 15
METADATA_PAGE_SIZE = 5000

OUTPUT_PATH = Path(__file__).parent / "chunks-for-dataset.md"


def connect_collection() -> "chromadb.api.models.Collection.Collection":
    """Connect to the Chroma server and open the podcasts collection.

    Exits with a descriptive message on any connection/lookup failure —
    the most common cause is the docker-compose Chroma service not running.
    """
    try:
        client = chromadb.HttpClient(
            host=CHROMA_HOST,
            port=CHROMA_PORT,
            # chromadb 0.5.x ships a posthog version mismatch that spams a
            # "Failed to send telemetry event" warning — disable outright.
            settings=chromadb.Settings(anonymized_telemetry=False),
        )
        client.heartbeat()
    except Exception as error:  # noqa: BLE001 — fail with guidance, not a stack trace
        print(
            f"ERROR: cannot reach Chroma at http://{CHROMA_HOST}:{CHROMA_PORT} — {error}\n"
            "Is the Chroma server running? Start it with: docker-compose up -d",
            file=sys.stderr,
        )
        sys.exit(1)

    try:
        return client.get_collection(COLLECTION_NAME)
    except Exception as error:  # noqa: BLE001
        print(
            f"ERROR: collection '{COLLECTION_NAME}' not found — {error}\n"
            "Has ingestion been run? See README 'Usage' for the ingest command.",
            file=sys.stderr,
        )
        sys.exit(1)


def discover_episodes(collection) -> dict[str, dict]:
    """Page through all chunk metadata and build an episode registry.

    Returns ``{episode_id: {"title": ..., "guest_name": ..., "chunk_count": ...}}``.
    Only metadata is fetched (no documents, no embeddings), so this stays
    cheap even at ~54k chunks.
    """
    episodes: dict[str, dict] = {}
    offset = 0

    while True:
        page = collection.get(
            include=["metadatas"],
            limit=METADATA_PAGE_SIZE,
            offset=offset,
        )
        metadatas = page["metadatas"]
        if not metadatas:
            break

        for meta in metadatas:
            episode_id = str(meta.get("episode_id", ""))
            if not episode_id:
                continue
            entry = episodes.setdefault(
                episode_id,
                {
                    "title": meta.get("title", "(unknown title)"),
                    "guest_name": meta.get("guest_name", "") or "(unknown guest)",
                    "chunk_count": 0,
                },
            )
            entry["chunk_count"] += 1

        offset += len(metadatas)
        print(f"  scanned {offset} chunk metadatas...", flush=True)

    return episodes


def select_diverse_episodes(episodes: dict[str, dict]) -> list[str]:
    """Pick EPISODES_TO_SAMPLE episode_ids, preferring distinct guests.

    Strategy: group episodes by guest, shuffle the guest list, take one
    random episode per guest. Distinct guests are the proxy for thematic
    diversity (consciousness / AI / philosophy / sports guests differ).
    Falls back to remaining episodes if there are fewer than 8 guests.
    """
    eligible = {
        ep_id: info
        for ep_id, info in episodes.items()
        if info["chunk_count"] >= MIN_CHUNKS_PER_EPISODE
    }
    if len(eligible) < EPISODES_TO_SAMPLE:
        print(
            f"ERROR: only {len(eligible)} episodes have >= {MIN_CHUNKS_PER_EPISODE} chunks; "
            f"need {EPISODES_TO_SAMPLE}.",
            file=sys.stderr,
        )
        sys.exit(1)

    by_guest: dict[str, list[str]] = {}
    for ep_id, info in eligible.items():
        by_guest.setdefault(info["guest_name"], []).append(ep_id)

    guests = list(by_guest.keys())
    random.shuffle(guests)

    selected = [random.choice(by_guest[guest]) for guest in guests[:EPISODES_TO_SAMPLE]]

    # Fewer distinct guests than needed → top up with any remaining episodes.
    if len(selected) < EPISODES_TO_SAMPLE:
        remaining = [ep_id for ep_id in eligible if ep_id not in selected]
        selected += random.sample(remaining, EPISODES_TO_SAMPLE - len(selected))

    return selected


def fetch_consecutive_chunks(collection, episode_id: str) -> list[dict]:
    """Fetch all chunks of an episode, then cut a random consecutive window.

    Window size is random in [MIN, MAX] (capped at what the episode has);
    start offset is random so re-runs sample different transcript regions.
    """
    result = collection.get(
        where={"episode_id": episode_id},
        include=["documents", "metadatas"],
    )

    chunks = [
        {
            "chunk_id": chunk_id,
            "chunk_index": int(meta.get("chunk_index", i)),
            "text": text,
        }
        for i, (chunk_id, meta, text) in enumerate(
            zip(result["ids"], result["metadatas"], result["documents"])
        )
    ]
    chunks.sort(key=lambda c: c["chunk_index"])

    window_size = min(random.randint(MIN_CHUNKS_PER_EPISODE, MAX_CHUNKS_PER_EPISODE), len(chunks))
    max_start = len(chunks) - window_size
    start = random.randint(0, max_start)
    return chunks[start : start + window_size]


def render_markdown(sampled: list[tuple[str, dict, list[dict]]]) -> str:
    """Render sampled episodes/chunks in the golden-dataset review format."""
    lines = ["# Chunks for Golden Dataset", ""]

    for episode_id, info, chunks in sampled:
        lines.append(f"## Episode {episode_id} — {info['title']} (guest: {info['guest_name']})")
        lines.append("")
        for chunk in chunks:
            lines.append(f"### Chunk {chunk['chunk_id']}")
            lines.append("")
            lines.append(chunk["text"])
            lines.append("")

    return "\n".join(lines)


def main() -> None:
    print(f"Connecting to Chroma at http://{CHROMA_HOST}:{CHROMA_PORT} ...")
    collection = connect_collection()
    print(f"Collection '{COLLECTION_NAME}' opened ({collection.count()} chunks total).")

    print("Discovering episodes from chunk metadata ...")
    episodes = discover_episodes(collection)
    print(f"Found {len(episodes)} distinct episodes.")

    selected = select_diverse_episodes(episodes)
    print(f"Selected {len(selected)} episodes: {', '.join(selected)}")

    sampled = []
    for episode_id in selected:
        chunks = fetch_consecutive_chunks(collection, episode_id)
        info = episodes[episode_id]
        print(
            f"  episode {episode_id} ({info['guest_name']}): "
            f"{len(chunks)} consecutive chunks "
            f"[{chunks[0]['chunk_index']}..{chunks[-1]['chunk_index']}]"
        )
        sampled.append((episode_id, info, chunks))

    OUTPUT_PATH.write_text(render_markdown(sampled), encoding="utf-8")
    print(f"Wrote {OUTPUT_PATH} ({sum(len(c) for _, _, c in sampled)} chunks).")


if __name__ == "__main__":
    main()
