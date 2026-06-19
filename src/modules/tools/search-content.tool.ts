import { Inject, Injectable, Logger } from '@nestjs/common';
import { RETRIEVER } from '../retrieval/retrieval.constants';
import type { IRetriever, RetrievedChunk } from '../retrieval/retrieval.types';
import { InvalidToolInputException } from './exceptions/invalid-tool-input.exception';
import { searchContentInputSchema, type SearchContentInput } from './search-content.schema';
import { SEARCH_CONTENT_DEFAULT_TOP_K, SEARCH_CONTENT_MAX_TOP_K } from './tools.constants';
import type { SearchContentPassage, SearchContentResult } from './tools.types';

/**
 * Phase 5.2.1 — the `search_content` tool's execution logic.
 *
 * A self-managed information-retrieval tool that wraps the existing Phase 4
 * hybrid retrieval (vector + BM25 + RRF + ±1 neighbor expansion). It injects the
 * **`RETRIEVER` token** — the exact seam `QaChainService` uses — so it honors the
 * `HYBRID_RETRIEVAL_ENABLED` toggle and is byte-identical to the live retrieval
 * path. Purely additive: the Phase 4 path is not modified.
 *
 * This file is the executable function + its output shaping ONLY. Binding it to
 * Gemini (`bindTools`) and the routing loop are Phase 5.3 — no LLM here.
 *
 * Trust boundary: `execute()` revalidates input with the Zod schema (the same
 * schema 5.3 binds) and clamps `top_k`, because the model produces untyped args.
 */
@Injectable()
export class SearchContentToolService {
  private readonly logger = new Logger(SearchContentToolService.name);

  constructor(@Inject(RETRIEVER) private readonly retriever: IRetriever) {}

  async execute(input: SearchContentInput): Promise<SearchContentResult> {
    const parsed = searchContentInputSchema.safeParse(input);
    if (!parsed.success) {
      throw new InvalidToolInputException(
        `search_content: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
      );
    }
    const { query } = parsed.data;
    // Clamp top_k: hybrid does not cap the fused outputTopK, so the tool must.
    const topK = Math.min(
      parsed.data.top_k ?? SEARCH_CONTENT_DEFAULT_TOP_K,
      SEARCH_CONTENT_MAX_TOP_K,
    );

    const startTime = Date.now();
    // Returns the EXPANDED list (Phase 4 caps it at MAX_EXPANDED_CHUNKS); order is
    // the neighbor-adjacency order — preserved, not re-sliced to top_k.
    const chunks = await this.retriever.retrieve(query, { topK });
    const passages = chunks.map((chunk) => this.toPassage(chunk));
    const context = this.formatContext(passages);

    this.logger.log(
      `search_content query_len=${query.length} top_k=${topK} ` +
        `returned=${passages.length} duration_ms=${Date.now() - startTime}`,
    );

    return { passages, context };
  }

  /** Shape one chunk → passage: keep text/title/episodeId (+ guestName if non-empty). */
  private toPassage(chunk: RetrievedChunk): SearchContentPassage {
    const metadata = chunk.metadata;
    const passage: SearchContentPassage = {
      text: chunk.document,
      title: this.asString(metadata.title),
      episodeId: this.asString(metadata.episode_id),
    };
    const guestName = this.asString(metadata.guest_name);
    if (guestName.length > 0) {
      passage.guestName = guestName;
    }
    return passage;
  }

  /**
   * Mirrors `QaChainService.formatContext()` — the `[Source N]` numbered-block,
   * blank-line-joined convention the LLM already reads in the QA path — enriched
   * with a one-line attribution header for the kept fields. This is the
   * LLM-facing rendering the 5.3 ToolMessage will carry.
   */
  private formatContext(passages: SearchContentPassage[]): string {
    return passages
      .map((passage, idx) => {
        const guest = passage.guestName ? ` guest="${passage.guestName}"` : '';
        return `[Source ${idx + 1}] episode=${passage.episodeId} title="${passage.title}"${guest}\n${passage.text}`;
      })
      .join('\n\n');
  }

  private asString(value: unknown): string {
    if (typeof value === 'string') return value;
    // Chroma/ES metadata values are primitives (flattenMetadata keeps only
    // string/number/boolean); anything else (null/undefined/object) → ''.
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    return '';
  }
}
