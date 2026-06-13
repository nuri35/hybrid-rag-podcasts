import { Injectable, Logger } from '@nestjs/common';
import { ChromaRepository } from '../vector-store/chroma.repository';
import { MAX_EXPANDED_CHUNKS, NEIGHBOR_WINDOW } from './retrieval.constants';
import type { RetrievedChunk } from './retrieval.types';

/** A chunk id decomposed into its episode + positional index. */
interface ParsedChunkId {
  episodeId: string;
  index: number;
}

/**
 * Score assigned to an injected neighbor chunk. Neighbors are *context*, not
 * independently-ranked retrieval results — they were surfaced by neither the
 * vector nor the keyword side, so they carry no rank. 0 (rather than inheriting
 * the parent's RRF score) makes that unambiguous: any chunk with score 0 in the
 * fused output is a context-completion neighbor, not a ranked hit. Downstream
 * (QaChainService.formatContext) orders by array position, not score, so the
 * sentinel never affects prompt ordering.
 */
const NEIGHBOR_SCORE = 0;

/**
 * Phase 4 enhancement — post-fusion neighbor-chunk expansion.
 *
 * **Problem (from the q017 investigation):** RRF correctly surfaces the
 * on-topic chunk, but a definition split across a chunk boundary stays broken
 * because the *completing* chunk is unreachable by either retriever. q017's
 * abstractor definition starts in `269_chunk_306` (which ends mid-sentence at
 * "...come up with a set of axioms") and finishes in `269_chunk_307` — and 307
 * carries none of the query's literal terms (so BM25 skips it) and is
 * semantically eclipsed by the C++ "constructor" homonym (so the vector side
 * retrieves episode 48 instead). No amount of FUSION_OUTPUT_TOP_K / SOURCE_TOP_K
 * / RRF_K tuning recovers a chunk that is in *neither* source's top-10.
 *
 * **Solution:** after fusion, pull each surviving chunk's ±NEIGHBOR_WINDOW
 * neighbors by deterministic id (`{episode_id}_chunk_{index}`) and place them
 * *adjacent to their parent in chunk_index order*, so the split sentence is
 * reassembled contiguously for the LLM.
 *
 * Single Chroma round trip: all needed neighbor ids are computed up front,
 * deduped, and fetched in ONE batched `getByIds` call. Parent text is already
 * in hand from fusion, so only the *missing* neighbor ids are fetched.
 *
 * Pure-ish: one batched read, otherwise deterministic. Never mutates the input
 * chunks. Graceful: a Chroma fetch error degrades to the un-expanded input.
 */
@Injectable()
export class NeighborExpansionService {
  private readonly logger = new Logger(NeighborExpansionService.name);

  constructor(private readonly chromaRepository: ChromaRepository) {}

  /**
   * Expand a fused, rank-ordered chunk list with ±1 neighbors.
   *
   * Ordering algorithm (preserves fusion rank as the primary order, glues
   * neighbors to their parent so split sentences rejoin):
   *   1. Walk `fusedChunks` in rank order. For each parent, form a "group":
   *      [prevNeighbor?, parent, nextNeighbor?] in chunk_index order.
   *   2. Concatenate groups in fusion-rank order.
   *   3. Deduplicate by chunk_id, keeping the FIRST occurrence (a chunk already
   *      emitted as someone's neighbor/parent is not repeated later).
   *   4. Cap at MAX_EXPANDED_CHUNKS by truncating from the END (highest-rank
   *      groups survive; lowest-rank material drops first).
   * Missing neighbors (episode boundary, or id absent in Chroma) are skipped
   * silently — they never enter a group.
   *
   * @param fusedChunks the RRF-fused, rank-ordered chunks (parents)
   * @returns expanded list, parents keep their RRF score, neighbors score 0
   */
  async expand(fusedChunks: RetrievedChunk[]): Promise<RetrievedChunk[]> {
    if (fusedChunks.length === 0) {
      return [];
    }

    const parentMap = new Map<string, RetrievedChunk>();
    for (const chunk of fusedChunks) {
      parentMap.set(chunk.id, chunk);
    }

    // 1. Compute neighbor ids (±NEIGHBOR_WINDOW, same episode only). Skip ids we
    //    already hold as parents — no point fetching text we already have.
    const neighborIdsToFetch = new Set<string>();
    for (const chunk of fusedChunks) {
      for (const neighborId of this.neighborIdsOf(chunk.id)) {
        if (!parentMap.has(neighborId)) {
          neighborIdsToFetch.add(neighborId);
        }
      }
    }

    // 2. Single batched fetch of the missing neighbor ids. Non-existent ids
    //    (last chunk's +1, first chunk's -1 already excluded, or genuine gaps)
    //    are simply omitted by Chroma. A fetch error degrades to no expansion.
    const neighborMap = await this.fetchNeighbors(Array.from(neighborIdsToFetch));

    // 3. Walk parents in rank order, emit groups, dedup by id (first wins).
    const lookup = (id: string): RetrievedChunk | undefined =>
      parentMap.get(id) ?? neighborMap.get(id);

    const orderedIds: string[] = [];
    const seen = new Set<string>();
    for (const chunk of fusedChunks) {
      for (const id of this.groupIdsOf(chunk.id)) {
        if (seen.has(id)) continue;
        if (lookup(id) === undefined) continue; // missing neighbor — skip silently
        seen.add(id);
        orderedIds.push(id);
      }
    }

    // 4. Cap from the end, then materialize.
    const capped = orderedIds.slice(0, MAX_EXPANDED_CHUNKS);
    return capped.map((id) => {
      const chunk = lookup(id);
      // lookup() was already proven defined above; non-null assertion is safe.
      return chunk as RetrievedChunk;
    });
  }

  /**
   * The group id sequence for a parent, in chunk_index order:
   * `[prevId?, parentId, nextId?]`. `prevId` is omitted for `chunk_0` (no -1);
   * `nextId` is always computed (a non-existent +1, e.g. the episode's last
   * chunk, is filtered out later when the lookup misses). An unparseable id
   * yields just `[parentId]` — the parent is always preserved.
   */
  private groupIdsOf(parentId: string): string[] {
    const parsed = this.parseChunkId(parentId);
    if (parsed === null) {
      return [parentId];
    }
    const ids: string[] = [];
    if (parsed.index >= NEIGHBOR_WINDOW) {
      ids.push(this.buildChunkId(parsed.episodeId, parsed.index - NEIGHBOR_WINDOW));
    }
    ids.push(parentId);
    ids.push(this.buildChunkId(parsed.episodeId, parsed.index + NEIGHBOR_WINDOW));
    return ids;
  }

  /** Just the neighbor ids (excludes the parent itself). */
  private neighborIdsOf(parentId: string): string[] {
    return this.groupIdsOf(parentId).filter((id) => id !== parentId);
  }

  /**
   * Batched neighbor fetch → `id → RetrievedChunk` map. The neighbor's
   * `chunkIndex` is taken from the id arithmetic (deterministic, correct by
   * construction) rather than trusting metadata. Score is the neighbor sentinel.
   * On any Chroma error, logs WARN and returns an empty map (degrade to no
   * expansion) — an auxiliary context layer must never fail the request.
   */
  private async fetchNeighbors(ids: string[]): Promise<Map<string, RetrievedChunk>> {
    const map = new Map<string, RetrievedChunk>();
    if (ids.length === 0) {
      return map;
    }
    try {
      const docs = await this.chromaRepository.getByIds(ids);
      for (const doc of docs) {
        const parsed = this.parseChunkId(doc.id);
        map.set(doc.id, {
          id: doc.id,
          document: doc.document,
          score: NEIGHBOR_SCORE,
          metadata: doc.metadata,
          chunkIndex: parsed?.index ?? 0,
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `neighbor_fetch_failed requested=${ids.length} ` +
          `action=degrade_to_no_expansion error_message=${message}`,
      );
      return new Map<string, RetrievedChunk>();
    }
    return map;
  }

  /**
   * Parse `{episode_id}_chunk_{index}` from the RIGHT so episode ids that
   * themselves contain underscores (and the `_0`/`_1` collision-disambiguation
   * suffixes from `prepare_dataset.py`) survive — e.g. `14_0_chunk_5` →
   * `{ episodeId: '14_0', index: 5 }`. Returns null for an id that doesn't match.
   */
  private parseChunkId(chunkId: string): ParsedChunkId | null {
    const match = /^(.+)_chunk_(\d+)$/.exec(chunkId);
    if (match === null) {
      return null;
    }
    return { episodeId: match[1], index: Number.parseInt(match[2], 10) };
  }

  private buildChunkId(episodeId: string, index: number): string {
    return `${episodeId}_chunk_${index}`;
  }
}
