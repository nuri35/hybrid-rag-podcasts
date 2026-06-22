import type { z } from 'zod';
import { DynamicStructuredTool } from '@langchain/core/tools';
import type { ChatGoogleGenerativeAI } from '@langchain/google-genai';
import type { AIMessageChunk } from '@langchain/core/messages';
import type { BaseLanguageModelInput } from '@langchain/core/language_models/base';
import type { Runnable } from '@langchain/core/runnables';
import type { SearchContentToolService } from './search-content.tool';
import type { QueryMetadataToolService } from './query-metadata.tool';
import {
  searchContentBindingSchema,
  type SearchContentBindingInput,
} from './search-content.binding-schema';
import {
  queryMetadataBindingSchema,
  type QueryMetadataBindingInput,
} from './query-metadata.binding-schema';
import {
  QUERY_METADATA_DESCRIPTION,
  QUERY_METADATA_TOOL_NAME,
  SEARCH_CONTENT_DESCRIPTION,
  SEARCH_CONTENT_TOOL_NAME,
} from './tools.constants';

/**
 * Phase 5.3.1 — tool factory.
 *
 * Wraps the existing Phase 5.2 tool services as LangChain `tool()` objects so the
 * LLM can call them via `bindTools` (5.3.2 routing). Each builder pairs a locked
 * name/description (`tools.constants.ts`) with the Gemini **binding-safe** schema
 * and a thin `func` that delegates 1:1 to `service.execute()` — NO logic is
 * duplicated here. All validation (strict schema), the flat→union map, retrieval/
 * aggregation, and output shaping live in the service (Phase 5.2); the func just
 * forwards the model's args and returns the LLM-facing string (`context` /
 * `summary`) that becomes the ToolMessage content in 5.3.2.
 *
 * Pure functions (no DI/state) — the router constructs them once with the injected
 * services. No invoke flow / no routing here (that is 5.3.2).
 *
 * Implementation note: we construct `DynamicStructuredTool` directly (rather than
 * the `tool()` helper) with explicit generics, and widen `SchemaT` to a plain
 * `z.ZodType<Input>`. The `tool()` overloads (and a literal `typeof schema`
 * generic) make TS infer/expand the full `ZodObject` internal type, which blows
 * up to a TS2589 ("excessively deep") instantiation; the runtime `schema` value
 * is the real binding schema — only its static type is widened.
 */
export function buildSearchContentTool(service: SearchContentToolService): DynamicStructuredTool {
  const built = new DynamicStructuredTool<
    z.ZodType<SearchContentBindingInput>,
    SearchContentBindingInput,
    SearchContentBindingInput,
    string
  >({
    name: SEARCH_CONTENT_TOOL_NAME,
    description: SEARCH_CONTENT_DESCRIPTION,
    schema: searchContentBindingSchema as z.ZodType<SearchContentBindingInput>,
    func: async (input) => {
      const { context } = await service.execute(input);
      return context;
    },
  });
  // Widen the specific instantiation to the broad type without a deep
  // (invariant) generic-compatibility check — that comparison is what triggers
  // TS2589 here. Runtime value is unchanged. (eslint's checker thinks the cast is
  // redundant, but full `tsc` needs it — a known no-unnecessary-type-assertion vs
  // TS2589 conflict.)
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
  return built as unknown as DynamicStructuredTool;
}

export function buildQueryMetadataTool(service: QueryMetadataToolService): DynamicStructuredTool {
  const built = new DynamicStructuredTool<
    z.ZodType<QueryMetadataBindingInput>,
    QueryMetadataBindingInput,
    QueryMetadataBindingInput,
    string
  >({
    name: QUERY_METADATA_TOOL_NAME,
    description: QUERY_METADATA_DESCRIPTION,
    schema: queryMetadataBindingSchema as z.ZodType<QueryMetadataBindingInput>,
    func: async (input) => {
      const { summary } = await service.execute(input);
      return summary;
    },
  });
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
  return built as unknown as DynamicStructuredTool;
}

/** Build both routing tools (order is the `bindTools` order). */
export function buildRoutingTools(
  searchContentService: SearchContentToolService,
  queryMetadataService: QueryMetadataToolService,
): DynamicStructuredTool[] {
  return [
    buildSearchContentTool(searchContentService),
    buildQueryMetadataTool(queryMetadataService),
  ];
}

/**
 * Bind the routing tools to a tool-calling model (Gemini AUTO function-calling).
 * Returns the bound `Runnable`. Kept separate from the builders so 5.3.2 can bind
 * once and reuse. AUTO mode (the default) lets the model decide whether AND which
 * tool(s) to call — see PHASE_5_3_PLAN.md D2.
 */
export function bindRoutingTools(
  model: ChatGoogleGenerativeAI,
  tools: DynamicStructuredTool[],
): Runnable<BaseLanguageModelInput, AIMessageChunk> {
  return model.bindTools(tools);
}
