# Phase 5.3 Plan — Tool Routing (`bindTools` + `ToolRouterService`)

> **Status: LOCKED — ready to build, one sub-phase at a time.** Step-0 research is
> confirmed (read from code + a live end-to-end Gemini check, script since deleted). The
> 7 decisions are final; the 6 sub-phases (Part 3) are the build units. **No production
> code is written from this doc** — each sub-phase gets its own build prompt, starting
> with 5.3.1.

**Scope boundary (locked).** Single-shot chain — single OR parallel tool call in **one**
round, then a final text answer. **NO serial loop, NOT agentic.** The model never gets a
second chance to call a tool within one request. Reuse the existing `LlmService` (no new
client). **Do NOT wire into the QA pipeline — that is 5.4.**

---

## Part 1 — Research findings (read from code + live runtime)

### 1. The LLM we reuse (`LlmService`)
- `LlmService.createChatModel()` (`src/modules/llm/llm.service.ts`) returns a **fresh**
  `ChatGoogleGenerativeAI` per call (`model=gemini-2.5-flash-lite`, `temperature=0`,
  `maxOutputTokens`, `apiKey=GOOGLE_API_KEY`), typed as `BaseChatModel`. Comment already
  anticipates "future … query-routing services". **We reuse this — no new client.**
  `LlmModule` exports `LlmService`.
- ⚠️ `createChatModel()`'s return type is `BaseChatModel`, which does **not** statically
  expose `.bindTools()`. `ChatGoogleGenerativeAI` implements it at runtime (confirmed). →
  5.3.1 adds a typed `LlmService.createToolCallingModel(): ChatGoogleGenerativeAI`.

### 2. The tools we bind (`ToolsModule`)
- `ToolsModule` (`src/modules/tools/tools.module.ts`) **provides + exports**
  `SearchContentToolService` and `QueryMetadataToolService`. Each exposes
  `async execute(input): Promise<{…}>` (`{ passages, context }` / `{ result, summary }`).
  The LLM-facing strings are `context` (search) and `summary` (metadata).
- Names + descriptions are LOCKED constants in `tools.constants.ts`
  (`SEARCH_CONTENT_TOOL_NAME`, `SEARCH_CONTENT_DESCRIPTION`, `QUERY_METADATA_TOOL_NAME`,
  `QUERY_METADATA_DESCRIPTION`). The router reuses them verbatim — no re-wording.
- DI: `ToolRouterService` lives in the same module, injects both services directly, and
  `ToolsModule` additionally `imports: [LlmModule]`. **No `QaModule` import** (cycle — same
  reason 5.2 avoided it; 5.4 wires the other direction).

### 3. ⭐ bindTools END-TO-END — confirmed, with one blocker found and fixed
Ran the **real** flat schemas through `model.bindTools([...]).invoke(question)` against
live Gemini:

- ✅ `bindTools` **accepts both tools** (incl. the `query_metadata` `.superRefine`
  `ZodEffects` — the flat object converts cleanly; the 5.2.2 "union is unreliable"
  decision is vindicated).
- ❌ **BLOCKER:** invoking 400s with `Unknown name "exclusiveMinimum" … Cannot find
  field`. Root cause: `top_k`/`limit` use Zod `.int().positive()`, which emit
  `exclusiveMinimum` in JSON Schema; Gemini's `FunctionDeclaration.parameters` is a
  restricted OpenAPI subset that rejects it, and the `@langchain/google-genai` converter
  strips `$schema`/`additionalProperties`/`strict` but **NOT** `exclusiveMinimum`.
- ✅ **FIX confirmed:** with **binding-safe** schemas — `z.number()` **without**
  `.int()/.positive()` (enums, strings, `.optional()`, `.describe()`, `.superRefine` all
  fine) — every routing case worked:

  | Question | Gemini emitted |
  |---|---|
  | "What did Lee Cronin say about constructor theory?" | `search_content {query:"Lee Cronin constructor theory"}` |
  | "How many episodes are there?" | `query_metadata {type:"count", field:"episode_id"}` ⚠️ (see §4) |
  | "Which guest appears in the most episodes?" | `query_metadata {type:"group_by", field:"guest_name"}` |
  | "List episodes with guest Michael Malice" | `query_metadata {type:"filter", field:"guest_name", value:"Michael Malice"}` |
  | "Hello, how are you?" | **no tool call** → direct text answer |

  → AUTO routing works; content vs. exact-fact split is clean; chit-chat correctly takes
  the no-tool direct-answer path.

### 4. ⚠️ Routing nuance found (handled in 5.3.3 + 5.3.4, not a blocker)
For "How many episodes are there?" Gemini set `field:"episode_id"` with **no** `value`.
The strict `queryMetadataInputSchema.superRefine` rejects `count` with field-XOR-value
(`count filter requires both field and value (or neither)`) → `InvalidToolInputException`
for a perfectly valid question. The system prompt steers against it (5.3.3) AND a mapping
tolerance absorbs it (5.3.4): on `count`, a lone `field` with no `value` is treated as an
**unfiltered count**.

### 5. Resilience + invocation pattern in the existing path (for reference)
`QaChainService` invokes its LCEL chain through `ResilientLlmService.invokeChain` =
circuit-breaker (outer) → retry (inner) → token callback, inside a `Promise.race` timeout
(`LLM_TIMEOUT_MS`). **Resolved:** 5.3 does **NOT** reuse this — retry/circuit/timeout reuse
is **deferred to 5.4** (pipeline integration). 5.3 stays **pure routing**: a bare two-call
flow, no timeout/retry wrapper. (Re-confirm only if a 5.3 integration test hangs.)

### 6. Test conventions (mirrored in 5.3.6)
- Unit specs instantiate services **directly** with plain mocks
  (`new SearchContentToolService(retrieverMock)`), `jest.spyOn(Logger.prototype,'log')`.
- Integration specs: `describe.skip(...)`, `Test.createTestingModule({imports:[AppModule]})`,
  documented enable steps.

---

## Part 2 — LOCKED DECISIONS (the 7)

### D1 — Tool factory + binding-safe schemas
- New `src/modules/tools/tool-factory.ts`: two pure builders,
  `buildSearchContentTool(svc)` / `buildQueryMetadataTool(svc)`, each returning a
  `StructuredTool` via `tool(func, { name, description, schema })` (`@langchain/core/tools`):
  - `name`/`description` ← LOCKED `tools.constants.ts` values.
  - `schema` ← **binding-safe** Zod (below) — NOT the strict service schemas.
  - `func` ← `async (args) => (await svc.execute(args)).<context|summary>` — delegates to
    `execute`, so the tool re-validates via the service's strict schema + clamping (trust
    boundary unchanged) and is independently invocable/testable.
- **Binding-safe schemas** (`search-content.binding-schema.ts` /
  `query-metadata.binding-schema.ts`): mirror the strict schemas **except**
  `top_k`/`limit` become `z.number().optional()` (drop `.int()/.positive()` → no
  `exclusiveMinimum`). `.describe()` still states "default 5, max 10". **The existing
  strict `*.schema.ts` files are unchanged** and remain the runtime trust boundary
  (`.int()/.positive()` enforced there, on `execute`). The Gemini-compat concern is
  isolated to the binding layer — this is the **only** schema change in 5.3.

### D2 — tool-choice = AUTO
Bind with the default `FunctionCallingMode.AUTO` — the model decides **whether** and
**which** tool(s) to call. Required for (a) chit-chat answerable with no tool, and
(b) parallel multi-tool. Never force `ANY`/a specific tool.

### D3 — single-shot enforcement (structural)
Exact two-call flow:
```
1. boundModel = toolModel.bindTools([searchTool, metadataTool])     // AUTO
2. ai = await boundModel.invoke([system, human])
3. if (ai.tool_calls is empty) → return ai.content                  // valid: direct answer
4. toolMessages = await Promise.all(ai.tool_calls.map(dispatchAndExecute))  // one round
5. final = await plainModel.invoke([system, human, ai, ...toolMessages])    // UNBOUND
6. return final.content
```
Step 5 uses the **UNBOUND** chat model (no `bindTools`). With no tools bound the model
**cannot** emit `tool_calls` again → a serial loop is **structurally impossible**, not
merely discouraged. (`plainModel` = `createChatModel()`; `toolModel` =
`createToolCallingModel()` — two instances, or `toolModel = base.bindTools(...)`.)

### D4 — parallel handling (single-shot ≠ single-tool)
If step-2 `ai.tool_calls` has >1 entry, execute **all** concurrently with `Promise.all`,
one `ToolMessage` per call (each carrying its `tool_call_id` so Gemini matches results to
calls). All `ToolMessage`s are appended (in `ai.tool_calls` order) before the single final
invoke. Still one round → in scope.

### D5 — routing system prompt
`ROUTER_SYSTEM_PROMPT` constant (in `tools.constants.ts` or a new `routing.constants.ts`):

> You are a Q&A assistant for a podcast transcript collection. Decide how to answer using
> the available tools:
> • Use **search_content** for questions about WHAT was said or discussed in the episodes
>   (opinions, explanations, arguments, topics, quotes).
> • Use **query_metadata** for EXACT facts about the collection — counts, distinct counts,
>   min/max/average, groupings, and exact-match filters over episode/guest/title/duration.
>   To count ALL episodes, call query_metadata with type="count" and NO field or value.
> You may call BOTH tools if a question needs content AND a fact. If no tool is needed
> (e.g. a greeting), answer directly and briefly.
> Ground your answer ONLY in the tool results provided. Do NOT invent facts, numbers,
> guests, or quotes. When answering from search_content passages, cite sources using the
> `[Source N]` markers exactly as they appear. If the tool results do not contain the
> answer, say so plainly ("Bu bilgi context'te yok." / "I don't have that information.")
> — never fabricate.

(The "count ALL → no field/value" line directly counters the §4 nuance.)

### D6 — fallback strategy
Per tool_call, inside `dispatchAndExecute` (try/catch + timing):
- **`InvalidToolInputException` (400, bad model args):** do NOT loop (single-shot). Feed a
  **controlled error string** back as that call's `ToolMessage` content
  (e.g. `"Tool error: invalid arguments (<reason>). No data returned."`). The final
  no-tools invoke answers gracefully / refuses.
- **`MetadataQueryFailedException` (500) / retrieval-infra errors
  (`RetrievalFailedException`, `ChromaUnreachableException`, `EmbeddingFailedException`,
  …):** **fail-loud — propagate.** Masking infra as a ToolMessage would invite a
  hallucinated answer. They surface to the caller; `AllExceptionsFilter` maps the status
  (5.1 exactness contract preserved).
- **No tool chosen:** valid — return the model's direct `content` (D3 step 3).
- **Logging:** per call → `tool_dispatch name=… latency_ms=… status=ok|invalid_input|error`;
  per request → `tool_routing tool_used=… count=N direct=true|false total_ms=… correlation_id=…`.

### D7 — placement + dispatch map (no magic strings)
- **`ToolRouterService`** in `src/modules/tools/tool-router.service.ts` (same module).
  Injects `SearchContentToolService`, `QueryMetadataToolService`, `LlmService`,
  `ConfigService`. Builds the two tool objects + the bound/unbound models once.
- **Dispatch map:** `Map<string, StructuredTool>` keyed by `SEARCH_CONTENT_TOOL_NAME` /
  `QUERY_METADATA_TOOL_NAME` (constants — no literals). `dispatchAndExecute(toolCall)`
  looks the name up; an unknown name (impossible under AUTO + 2 tools) →
  `UnknownToolException` / controlled-error ToolMessage. One map = the routing table;
  a 3rd tool later is one entry.

### Resolved open items
- **`route()` public shape** → returns a **rich object** `{ answer: string; toolUsed:
  string | null; latency: number }` (for D6 logging + 5.5 routing eval), **not** a bare
  string. `toolUsed` is the tool name (or a comma-joined list / array for parallel — pin
  in 5.3.2), `null` for the direct-answer path.
- **Resilience** → deferred to 5.4. 5.3 is pure routing (no retry/circuit/timeout).
- **Not wired into QA/HTTP in 5.3** — `route()` is standalone; 5.4 adapts it into the
  pipeline.

---

## Part 3 — SUB-PHASE BREAKDOWN (the build units)

Each sub-phase is a self-contained build prompt. Build in order; run the full suite after
each (zero regressions).

### 5.3.1 — Tool factory + binding-safe schemas + typed model accessor — ✅ SHIPPED
- **Files:** `tool-factory.ts`, `search-content.binding-schema.ts`,
  `query-metadata.binding-schema.ts`, `tool-factory.spec.ts`,
  `tool-factory.integration.spec.ts` (skipped); edited `llm.service.ts`
  (`llm.module.ts` already exported `LlmService` — unchanged).
- **Work (done):** binding-safe schemas (D1) — `top_k`/`limit` → `z.number()` (no
  `.int()/.positive()`); also dropped `query`'s `.trim().min(1)` (emits `minLength`) and
  `query_metadata`'s `.superRefine` from the BIND schema (adds no model-visible constraint;
  strict schema still enforces both at runtime). `LlmService.createToolCallingModel():
  ChatGoogleGenerativeAI` via a shared private `buildModel()` (no cast, no new client).
  `buildSearchContentTool` / `buildQueryMetadataTool` / `buildRoutingTools` +
  `bindRoutingTools`; `func` delegates 1:1 to `service.execute` → `context`/`summary`.
- **Tests (green):** 8 unit — names/descriptions/schema identity; `func` delegates to the
  mocked service and returns the string; bug-guard: binding schemas emit **no**
  `exclusiveMinimum` AND the strict schemas **do** (proves the guard meaningful). Full
  suite 512 → **520, 0 regressions**.
- **⚠️ Implementation findings (for 5.3.2):**
  1. **TS2589 "excessively deep"** — the `tool()` helper (and a literal `typeof schema`
     generic) blow up type instantiation on these Zod schemas. Workaround used:
     `new DynamicStructuredTool<z.ZodType<Input>, …>({…})` (widened `SchemaT`) + a
     `return built as unknown as DynamicStructuredTool` with a scoped
     `eslint-disable no-unnecessary-type-assertion` (eslint's checker thinks the cast
     redundant; full `tsc` needs it). 5.3.2 should reuse `buildRoutingTools()` and avoid
     re-deriving tool generics.
  2. `DynamicStructuredTool.invoke(args)` returns the `func`'s string (typed `any` →
     tests cast `as string`).
- **Done:** factory + schemas + accessor exist, unit-green, nothing wired into routing yet.

### 5.3.2 — `ToolRouterService` core: dispatch map + single-shot two-call flow — ✅ SHIPPED
- **Files:** `tool-router.service.ts`, `tool-router.service.spec.ts`,
  `tool-router.service.integration.spec.ts` (skipped); edited `tools.types.ts`
  (`RouteResult`), `tools.constants.ts` (`ROUTER_SYSTEM_PROMPT` placeholder),
  `tools.module.ts` (added `LlmModule`; provide+export `ToolRouterService`).
- **Work (done):** constructor builds both tools via `buildRoutingTools` (reused — no
  re-derived generics), a `Map<name, tool>` dispatch keyed by `tool.name`, the
  `bindRoutingTools(createToolCallingModel(), tools)` bound model, and the
  `createChatModel()` UNBOUND model. `route()`: call 1 on the bound model →
  no `tool_calls` ⇒ return content directly (no 2nd call); else dispatch
  `toolCalls[0]` → `ToolMessage` (string result + `tool_call_id`) → call 2 on the
  **UNBOUND** model. Returns `{ answer, toolUsed: string[], latency }`. Unknown tool name
  → controlled ToolMessage (minimal; full fallback is 5.3.5). Placeholder system prompt
  (real one 5.3.3). `extractText` flattens string|content-part content.
- **Tests (green):** 7 unit (mocked LLM) — tool path dispatches the right service, feeds
  the `ToolMessage` (content + `tool_call_id`) back, returns the answer; **single-shot
  guard**: bound invoked once, unbound once, `bindTools` called exactly once (construction)
  → final is unbound; no-tool path → direct content, **no 2nd invoke**; missing-`tool_calls`
  field handled; content-part array flattened; unknown tool safe. Skippable real-Gemini
  sanity test. Full suite 520 → **527, 0 regressions**.
- **⚠️ Scope boundary for 5.3.4:** `route()` currently executes only `toolCalls[0]`. If the
  model emits >1 tool_call, the others get no `ToolMessage` — Gemini requires a response
  per call, so a real multi-call would break the final invoke. **5.3.4 must `Promise.all`
  over ALL `tool_calls` and append a `ToolMessage` for each** (and set `toolUsed` to all
  names). Single-tool/no-tool (5.3.2 scope) is unaffected.

### 5.3.3 — Routing system prompt
- **Files:** `tools.constants.ts` (or `routing.constants.ts`) — add `ROUTER_SYSTEM_PROMPT`
  (D5); wire it as the leading `SystemMessage` in `route()`.
- **Tests:** unit — the prompt constant is included as message[0] on both invokes;
  (string-shape assertions only — routing-accuracy is 5.5).

### 5.3.4 — Parallel execution + result feedback + count-all tolerance
- **Files:** `tool-router.service.ts`; the `query_metadata` flat→union mapping layer
  (`query-metadata.tool.ts` `toRequest`, or the binding mapping) for the count tolerance.
- **Work:** D4 `Promise.all` over multiple `tool_calls`; append all `ToolMessage`s in
  order before the single final invoke; pin `toolUsed` for the multi-tool case. **Count
  tolerance (§4):** on `type="count"`, a lone `field` with no `value` → unfiltered count
  (chosen layer: the `count` mapping — keep the strict service contract pure; document the
  exact edit in the build prompt).
- **Tests:** unit — 2 tool_calls → both services called concurrently, both ToolMessages
  fed back in order; `count` + `field` + no `value` → unfiltered count (no
  `InvalidToolInputException`).

### 5.3.5 — Fallback + per-tool logging
- **Files:** `tool-router.service.ts`; maybe `exceptions/unknown-tool.exception.ts`.
- **Work:** D6 — `InvalidToolInputException` → controlled-error `ToolMessage` (flow
  continues); `MetadataQueryFailedException`/infra → propagate; unknown tool name →
  `UnknownToolException` / controlled error; the `tool_dispatch` + `tool_routing` log lines.
- **Tests:** unit — `InvalidToolInput` produces a controlled-error ToolMessage and the
  router still returns an answer (no throw); `MetadataQueryFailed`/retrieval-infra error
  **propagates** (router throws); log shape + `toolUsed` correctness.

### 5.3.6 — Tests round-out + doc/ADR closure
- **Work:** complete the mocked-LLM unit matrix; add a **skippable real-Gemini**
  integration spec (`tool-router.service.integration.spec.ts`, `describe.skip`, via
  `AppModule`): content Q → `search_content`; "how many episodes" → `query_metadata count`;
  "which guest most" → `group_by`; greeting → direct (no tool). Document enable steps
  (needs `GOOGLE_API_KEY` + live ES/Chroma). Write the ADR (routing layer / single-shot
  decision / `exclusiveMinimum` finding) and update CLAUDE.md (architectural decision +
  phase-tracking note). Full suite green, zero regressions.
- **Out of scope:** routing-accuracy eval over a labeled set → **5.5**. QA-pipeline wiring
  → **5.4**.

---

## Part 4 — Build order & guardrails
- Build 5.3.1 → 5.3.6 in sequence; each gets its own prompt and lands green before the
  next. No production code is written ahead of its sub-phase prompt.
- Invariants every sub-phase must keep: single-shot (final invoke unbound), reuse
  `LlmService` (no new client), strict `*.schema.ts` files untouched (binding schemas are
  separate), no magic strings (names/prompt/limits are constants), no `QaModule` import,
  Phase 4 retrieval + 5.1/5.2 services unmodified.
