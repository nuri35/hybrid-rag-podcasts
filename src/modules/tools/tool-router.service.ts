import { Injectable, Logger } from '@nestjs/common';
import {
  HumanMessage,
  SystemMessage,
  ToolMessage,
  type AIMessageChunk,
  type BaseMessage,
} from '@langchain/core/messages';

/** One entry of an `AIMessage.tool_calls` (derived to avoid a deep-subpath import). */
type RoutedToolCall = NonNullable<AIMessageChunk['tool_calls']>[number];
/** A message's content (string | content-part array) — derived, same reason. */
type RoutedMessageContent = BaseMessage['content'];
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { BaseLanguageModelInput } from '@langchain/core/language_models/base';
import type { Runnable } from '@langchain/core/runnables';
import type { DynamicStructuredTool } from '@langchain/core/tools';
import { LlmService } from '../llm/llm.service';
import { SearchContentToolService } from './search-content.tool';
import { QueryMetadataToolService } from './query-metadata.tool';
import { InvalidToolInputException } from './exceptions/invalid-tool-input.exception';
import { bindRoutingTools, buildRoutingTools } from './tool-factory';
import {
  ROUTER_SYSTEM_PROMPT,
  TOOL_INVALID_INPUT_MESSAGE,
  UNKNOWN_TOOL_MESSAGE,
} from './tools.constants';
import type { RouteResult } from './tools.types';

/**
 * Phase 5.3.2 — single-shot tool router.
 *
 * Binds the two Phase 5.2 tools to Gemini (AUTO function-calling) and runs a
 * **single-shot** two-call flow:
 *   1. invoke the TOOLS-BOUND model on [system, human];
 *   2a. no `tool_calls` → that message IS the answer (return directly, no 2nd call);
 *   2b. a `tool_call` → dispatch it to the matching tool, feed the result back as a
 *       `ToolMessage`, then invoke the **UNBOUND** model to force a text answer.
 *
 * The final invoke uses the unbound model (`createChatModel`, no `bindTools`), so a
 * second tool round is **structurally impossible** — single-shot, not agentic. NO
 * serial loop.
 *
 * Scope of 5.3.2: single-tool + no-tool only. Parallel multi-tool execution is
 * 5.3.4; the real routing prompt is 5.3.3; full fallback/error handling + rich
 * logging are 5.3.5. The tool builders/binding are reused verbatim from 5.3.1
 * (`buildRoutingTools`/`bindRoutingTools`) — we do NOT re-derive tool generics
 * (avoids the 5.3.1 TS2589 blow-up).
 */
@Injectable()
export class ToolRouterService {
  private readonly logger = new Logger(ToolRouterService.name);

  /** Tools-bound model — call 1 (the model decides whether/which tool, AUTO). */
  private readonly boundModel: Runnable<BaseLanguageModelInput, AIMessageChunk>;
  /** Unbound model — call 2 (no tools → cannot emit tool_calls → single-shot). */
  private readonly unboundModel: BaseChatModel;
  /** tool_call name → tool. Keyed by the locked tool names (no magic strings). */
  private readonly dispatchMap: Map<string, DynamicStructuredTool>;

  constructor(
    llmService: LlmService,
    searchContentService: SearchContentToolService,
    queryMetadataService: QueryMetadataToolService,
  ) {
    const tools = buildRoutingTools(searchContentService, queryMetadataService);
    this.dispatchMap = new Map(tools.map((tool) => [tool.name, tool]));
    this.boundModel = bindRoutingTools(llmService.createToolCallingModel(), tools);
    this.unboundModel = llmService.createChatModel();
  }

  /**
   * Route a question through the single-shot flow and return the grounded answer.
   * `toolUsed` is `[]` (direct answer) or `[name]` (single tool — 5.3.2 scope).
   */
  async route(question: string): Promise<RouteResult> {
    const startTime = Date.now();
    const messages: BaseMessage[] = [
      new SystemMessage(ROUTER_SYSTEM_PROMPT),
      new HumanMessage(question),
    ];

    // Call 1 — tools-bound (AUTO): the model decides whether/which tool to call.
    const ai = await this.boundModel.invoke(messages);
    const toolCalls = ai.tool_calls ?? [];

    // 2a. No tool chosen → the model answered directly. No second call.
    if (toolCalls.length === 0) {
      const answer = this.extractText(ai.content);
      this.logger.log(
        `tool_routing tool_used=none direct=true latency_ms=${Date.now() - startTime}`,
      );
      return { answer, toolUsed: [], latency: Date.now() - startTime };
    }

    // 2b. ONE round, ALL tool_calls in parallel (single-shot ≠ single-tool).
    //     `Promise.allSettled` so one tool's failure does not lose another tool's
    //     successful result. Each settled result is then routed by exception TYPE
    //     (`settledResultToToolMessage`): a fulfilled call → its ToolMessage; bad
    //     LLM args (`InvalidToolInputException`) → a controlled-error ToolMessage
    //     (graceful, single-shot preserved); a system/infra error
    //     (`MetadataQueryFailedException`, anything else) → rethrow (fail-loud) so
    //     route() propagates and Call 2 never happens. Gemini requires one
    //     ToolMessage per tool_call id, which both the fulfilled and graceful paths
    //     satisfy. The final answer is then forced on the UNBOUND model.
    const settled = await Promise.allSettled(
      toolCalls.map((toolCall) => this.dispatchAndExecute(toolCall)),
    );
    const toolMessages = settled.map((outcome, index) =>
      this.settledResultToToolMessage(toolCalls[index], outcome),
    );

    const final = await this.unboundModel.invoke([...messages, ai, ...toolMessages]);
    const answer = this.extractText(final.content);
    const toolUsed = toolCalls.map((toolCall) => toolCall.name);

    this.logger.log(
      `tool_routing tool_used=${toolUsed.join(',')} direct=false latency_ms=${Date.now() - startTime}`,
    );
    return { answer, toolUsed, latency: Date.now() - startTime };
  }

  /**
   * Look the tool_call name up in the dispatch map and execute the tool, returning
   * a `ToolMessage` carrying the result string + the `tool_call_id` (so Gemini
   * matches the result to its call). `tool.invoke(args)` returns `any`, so the
   * result is bound to `string` explicitly. An unknown tool name is handled safely
   * here (a controlled note, never throws). Per-tool telemetry (name + latency +
   * status) is logged here; the exception is rethrown so `allSettled` captures it
   * and `settledResultToToolMessage` routes it by type. NO retry/timeout (5.4).
   */
  private async dispatchAndExecute(toolCall: RoutedToolCall): Promise<ToolMessage> {
    const startTime = Date.now();
    const toolCallId = toolCall.id ?? '';
    const tool = this.dispatchMap.get(toolCall.name);
    if (!tool) {
      this.logger.warn(
        `tool_dispatch name=${toolCall.name} status=unknown_tool latency_ms=${Date.now() - startTime}`,
      );
      return new ToolMessage({ content: UNKNOWN_TOOL_MESSAGE, tool_call_id: toolCallId });
    }
    try {
      const result = (await tool.invoke(toolCall.args)) as string;
      this.logger.log(
        `tool_dispatch name=${toolCall.name} status=success latency_ms=${Date.now() - startTime}`,
      );
      return new ToolMessage({ content: result, tool_call_id: toolCallId });
    } catch (error) {
      const status = error instanceof InvalidToolInputException ? 'invalid_input' : 'failed';
      this.logger.warn(
        `tool_dispatch name=${toolCall.name} status=${status} latency_ms=${Date.now() - startTime}`,
      );
      throw error;
    }
  }

  /**
   * Route one settled tool result to a `ToolMessage`, by exception TYPE (5.3.5):
   *   - fulfilled → the tool's `ToolMessage` (its `tool_call_id` already set);
   *   - rejected `InvalidToolInputException` (bad LLM args) → a controlled-error
   *     `ToolMessage` so the final invoke still has a valid response per tool_call
   *     and answers honestly (graceful, single-shot — no loop);
   *   - rejected anything else (`MetadataQueryFailedException` / infra) → RETHROW
   *     (fail-loud); route() propagates and Call 2 never happens.
   */
  private settledResultToToolMessage(
    toolCall: RoutedToolCall,
    outcome: PromiseSettledResult<ToolMessage>,
  ): ToolMessage {
    if (outcome.status === 'fulfilled') return outcome.value;

    const reason: unknown = outcome.reason;
    if (reason instanceof InvalidToolInputException) {
      return new ToolMessage({
        content: TOOL_INVALID_INPUT_MESSAGE,
        tool_call_id: toolCall.id ?? '',
      });
    }
    throw reason instanceof Error ? reason : new Error(String(reason));
  }

  /** Flatten a message's content (string or content-part array) to plain text. */
  private extractText(content: RoutedMessageContent): string {
    if (typeof content === 'string') return content;
    return content
      .map((part) => (part.type === 'text' && typeof part.text === 'string' ? part.text : ''))
      .join('');
  }
}
