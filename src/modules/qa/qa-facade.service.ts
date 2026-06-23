import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ToolRouterService } from '../tools/tool-router.service';
import { SEARCH_CONTENT_TOOL_NAME } from '../tools/tools.constants';
import type { Env } from '../../common/config/env.schema';
import { QaChainService } from './qa-chain.service';
import { OutputValidationService } from './services/output-validation.service';
import { PromptSanitizationService } from './services/prompt-sanitization.service';
import { OutputRejectedException } from './exceptions/output-rejected.exception';
import { QuestionRejectedException } from './exceptions/question-rejected.exception';
import { AnswerKind, OutputVerdict } from './types/output-validation.types';
import { SanitizationVerdict } from './types/sanitization.types';
import type { AnswerResponseDto } from './dto/answer-response.dto';
import type { QaOptions } from './qa.types';

/**
 * Phase 5.4 — QA-side facade. The controller's non-streaming endpoint calls ONLY
 * this; it picks the pipeline behind the `TOOL_USE_ENABLED` toggle and returns the
 * unified `AnswerResponseDto`.
 *
 *   toggle OFF (default) → `QaChainService.ask()` — the classic Phase 4 direct RAG
 *     path, byte-identical. `ask()` self-guards (lock, integrity, sanitization,
 *     output-validation, cache), so the facade delegates and does NOT re-run those
 *     guards — avoiding double-processing.
 *   toggle ON → `ToolRouterService.route()` — single-shot LLM tool routing. The
 *     router has NONE of `ask()`'s guards, so the facade runs the SHARED ones around
 *     it: integrity-check → sanitize → route → output-validation verdict.
 *
 * Asymmetry is deliberate and forced: `ask()`'s output-validation must run BEFORE
 * its cache write (rejected answers are never cached — CLAUDE.md decision 19), and
 * the RAG flow stays inside `ask()` (locked), so the direct path keeps its guards
 * internal while the tool-use path borrows the shared providers here. The two guard
 * implementations (sanitization, output-validation) are the SAME injected providers
 * `ask()`/`askStream()` use — one implementation, three call sites.
 *
 * Streaming is never routed here — the SSE endpoint still calls
 * `QaChainService.askStream()` directly (Phase 4 streaming unchanged). Resilience /
 * timeout / token telemetry around the router's invokes is the final 5.4 step.
 */
@Injectable()
export class QaFacadeService {
  private readonly logger = new Logger(QaFacadeService.name);
  private readonly toolUseEnabled: boolean;

  constructor(
    private readonly qaChainService: QaChainService,
    private readonly toolRouterService: ToolRouterService,
    private readonly promptSanitization: PromptSanitizationService,
    private readonly outputValidation: OutputValidationService,
    config: ConfigService<Env, true>,
  ) {
    this.toolUseEnabled = config.get('TOOL_USE_ENABLED', { infer: true });
  }

  async answer(question: string, options: QaOptions = {}): Promise<AnswerResponseDto> {
    if (this.toolUseEnabled) {
      return this.toolUsePath(question);
    }
    return this.directPath(question, options);
  }

  /**
   * Direct RAG path — delegate to the self-guarding `ask()`. Phase 4 behavior is
   * byte-identical; the facade only maps `QaResult` → the unified DTO.
   */
  private async directPath(question: string, options: QaOptions): Promise<AnswerResponseDto> {
    const startTime = Date.now();
    const result = await this.qaChainService.ask(question, options);
    this.logger.log(
      `qa_pipeline path=direct sources=${result.sources.length} latency_ms=${Date.now() - startTime}`,
    );
    return {
      answer: result.answer,
      sources: result.sources,
      retrievalMetadata: result.retrievalMetadata,
      path: 'direct',
    };
  }

  /**
   * Tool-use path — the router has none of `ask()`'s guards, so run the shared ones
   * around it. Integrity-check + sanitization are PRE-routing; the output-validation
   * verdict is POST-answer (the ACTION — throw — stays here, mirroring `ask()`).
   */
  private async toolUsePath(question: string): Promise<AnswerResponseDto> {
    const correlationId = randomUUID();
    const startTime = Date.now();

    // Ingestion-lock check (data-level guard, fail-open) — the tool-use path reads
    // the same Chroma/ES, so it gets the SAME shared seam ask() uses. PRE-routing,
    // and ordered lock → integrity exactly as ask() does (lock state owned by
    // DistributedLockService; we only query it).
    await this.qaChainService.assertIngestionNotInProgress();

    // Integrity-gate check (state owned by QaChainService; we only query readiness).
    this.qaChainService.assertDataIntegrity();

    // OWASP LLM01 Layer 1 — input sanitization (shared provider).
    const sanitization = this.promptSanitization.inspect(question, correlationId);
    if (sanitization.verdict === SanitizationVerdict.REJECTED) {
      throw new QuestionRejectedException();
    }
    const cleanedQuestion = sanitization.sanitizedQuestion;

    // Single-shot tool routing (router internals are 5.3 — unchanged).
    const route = await this.toolRouterService.route(cleanedQuestion);

    // OWASP LLM01 Layer 3 — CONTEXT-AWARE output-validation verdict (shared
    // provider): the facade passes the explicit AnswerKind for which tool produced
    // the answer, so the citation rule is relaxed where citations don't apply
    // (metadata / unsurfaced passages) while the empty/leakage floor still runs.
    // The throw-on-reject ACTION stays here (the facade is the caller).
    const verdict = this.outputValidation.validate(
      route.answer,
      correlationId,
      this.resolveAnswerKind(route.toolUsed),
    );
    if (verdict.verdict === OutputVerdict.REJECTED) {
      throw new OutputRejectedException();
    }

    this.logger.log(
      `qa_pipeline path=tool_use tool_used=${route.toolUsed.join(',') || 'none'} ` +
        `router_latency_ms=${route.latency} latency_ms=${Date.now() - startTime}`,
    );
    return {
      answer: route.answer,
      sources: [],
      toolUsed: route.toolUsed,
      latency: route.latency,
      path: 'tool_use',
    };
  }

  /**
   * Map the tools the router invoked → the `AnswerKind` the validator branches on.
   * Both tool kinds relax the citation requirement identically in 5.4 v1; the
   * distinction is kept explicit/typed for when TOOL_SEARCH_CONTENT tightens later.
   * search_content present (incl. parallel) → content kind; metadata-only or a
   * no-tool direct router answer → metadata kind (no passages, citations N/A).
   */
  private resolveAnswerKind(toolUsed: string[]): AnswerKind {
    return toolUsed.includes(SEARCH_CONTENT_TOOL_NAME)
      ? AnswerKind.TOOL_SEARCH_CONTENT
      : AnswerKind.TOOL_QUERY_METADATA;
  }
}
