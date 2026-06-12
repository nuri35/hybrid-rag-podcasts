import { Injectable } from '@nestjs/common';
import type { RetrievedChunk } from '../retrieval/retrieval.types';
import { FUSION_OUTPUT_TOP_K, RRF_K } from './rrf-fusion.constants';

/** Internal fusion accumulator: one entry per unique chunk id. */
interface FusionEntry {
  chunk: RetrievedChunk;
  rrfScore: number;
  /** How many input lists this chunk appeared in (used for tie-breaking). */
  listCount: number;
}

/**
 * Phase 4.3 — Reciprocal Rank Fusion of two ranked retriever lists.
 *
 * **Why rank-based, not score-based:** the vector side's `score` is a cosine
 * similarity in `[0, 1]`; the keyword side's is a raw BM25 score (unbounded,
 * ~12-28 in practice). The two scales are incomparable by magnitude, so any
 * score average / min-max blend is broken. RRF ignores raw scores entirely and
 * fuses on **rank position** instead. See ADR 0019.
 *
 * Pure: no I/O, no async, no state, fully deterministic — same input always
 * yields the same output. Input arrays and their chunk objects are never mutated.
 */
@Injectable()
export class RrfFusionService {
  /**
   * Fuse two ranked lists into one via RRF.
   *
   * Formula: `RRF_score(chunk) = Σ_lists 1 / (RRF_K + rank)`, where `rank` is the
   * chunk's 1-based position in each list it appears in. A chunk present in only
   * one list gets only that list's contribution. Chunks are deduplicated by `id`
   * (the bridge key shared across both stores); the first-seen chunk's
   * text/metadata is kept (the underlying source data is identical).
   *
   * Sort: descending by RRF score. **Deterministic tie-break** when scores are
   * exactly equal: (1) chunk present in MORE lists ranks first, then (2) stable
   * ascending lexicographic order by `id`. The fused `score` field carries the
   * RRF score (the original cosine/BM25 scores are consumed by ranking, not
   * forwarded).
   *
   * Either list may be empty (e.g. the ES-down degradation path from 4.2) — the
   * result is then the other list's order, re-scored by RRF, with no error.
   *
   * @param vectorHits  ranked vector (Chroma) results, best-first
   * @param keywordHits ranked keyword (Elasticsearch) results, best-first
   * @param topK        max fused results to return (default FUSION_OUTPUT_TOP_K)
   */
  fuse(
    vectorHits: RetrievedChunk[],
    keywordHits: RetrievedChunk[],
    topK: number = FUSION_OUTPUT_TOP_K,
  ): RetrievedChunk[] {
    const entries = new Map<string, FusionEntry>();
    this.accumulate(entries, vectorHits);
    this.accumulate(entries, keywordHits);

    const fused = Array.from(entries.values()).sort((a, b) => {
      if (b.rrfScore !== a.rrfScore) return b.rrfScore - a.rrfScore;
      if (b.listCount !== a.listCount) return b.listCount - a.listCount;
      if (a.chunk.id < b.chunk.id) return -1;
      if (a.chunk.id > b.chunk.id) return 1;
      return 0;
    });

    // New objects — never mutate the caller's chunks. Overwrite `score` with RRF.
    return fused.slice(0, topK).map((entry) => ({ ...entry.chunk, score: entry.rrfScore }));
  }

  /** Add one ranked list's RRF contributions into the accumulator. */
  private accumulate(entries: Map<string, FusionEntry>, hits: RetrievedChunk[]): void {
    hits.forEach((chunk, index) => {
      const contribution = 1 / (RRF_K + index + 1); // index+1 = 1-based rank
      const existing = entries.get(chunk.id);
      if (existing) {
        existing.rrfScore += contribution;
        existing.listCount += 1;
        return;
      }
      entries.set(chunk.id, { chunk, rrfScore: contribution, listCount: 1 });
    });
  }
}
