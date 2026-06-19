# Phase 5.2 Plan — Tool Definitions (`search_content` + `query_metadata`)

> WORK IN PROGRESS. Part 1 below is the **5.2.1 Step-0 research report** (read-only,
> no code). Input schema, output shaping, and the tool descriptions are decided
> jointly AFTER this report and signed off before any code.

---

## Part 1 — Research findings: the Phase 4 retrieval path we'll wrap (`search_content`)

All findings read from the actual code / live index — not assumed.

### 1. The retrieval service & method to wrap

- **Active path:** `HybridRetrievalService` — `src/modules/retrieval/hybrid-retrieval.service.ts`.
  It `implements IRetriever` and is bound to the **`RETRIEVER` DI token** by the
  `selectRetriever` factory (`src/modules/qa/retriever.provider.ts`,
  `HYBRID_RETRIEVAL_ENABLED` default true; false → `VectorRetrieverService`).
- **Contract (`src/modules/retrieval/retrieval.types.ts`):**
  ```ts
  interface IRetriever {
    retrieve(query: string, options?: RetrievalOptions): Promise<RetrievedChunk[]>;
  }
  interface RetrievalOptions {
    topK?: number;
    scoreThreshold?: number;                 // NOT honored by hybrid (see §4)
    filter?: Record<string, unknown>;        // NOT honored by hybrid (see §4)
    captureFusedTopK?: (fused: RetrievedChunk[]) => void;  // eval side-channel
  }
  ```
- **Recommended wrap point:** inject the **`RETRIEVER` token (`IRetriever`)** — the
  exact same seam the QA chain uses — and call `retrieve(query, { topK })`. That keeps
  `search_content` byte-identical to the Phase 4 path and additive (Phase 4 untouched),
  and it automatically honors the hybrid/vector toggle.

### 2. Return type — `RetrievedChunk` (one result)

```ts
interface RetrievedChunk {
  id: string;              // chunk_id, e.g. "269_chunk_306"
  document: string;        // the chunk text (~800 chars — see §7)
  score: number;           // SEE WARNING below
  metadata: Record<string, unknown>;   // keys below
  chunkIndex: number;      // mirrors metadata.chunk_index
}
```
- **`metadata` keys** (live-verified; `_source` minus `text`):
  `chunk_id, episode_id, chunk_index, total_chunks, title, guest_name,
  guest_affiliation, guest_role, date, duration_min`.
  ⚠️ `guest_affiliation`, `guest_role`, `date` are **empty strings** in the current
  dataset (same finding as 5.1). Useful keys: `episode_id`, `title`, `guest_name`,
  `chunk_index`, `total_chunks`, `duration_min`.
- ⚠️ **`score` is NOT cosine on the hybrid path.** The `RetrievedChunk` doc comment
  ("cosine [0,1]") is stale for hybrid: `RrfFusionService.fuse()` **overwrites `score`
  with the RRF score** (tiny, ~0.0159–0.033 in practice), and **neighbor-expanded
  chunks carry `score = 0`**. So `score` magnitude is meaningless to an LLM — for the
  tool output we should expose **rank/order** (and maybe `episode_id`/`title`), not the
  raw RRF number. Decision deferred to the joint design step.

### 3. Result-count control (top-k)

- `retrieve(query, { topK })`: `outputTopK = options.topK ?? FUSION_OUTPUT_TOP_K`.
- Constants: `FUSION_OUTPUT_TOP_K = 5` (fused output), `SOURCE_TOP_K = 10`
  (per-source, fixed — hybrid always asks vector+ES for 10 each), `RRF_K = 60`.
- QA pipeline default: `QA_DEFAULT_TOP_K = 5` → hybrid `outputTopK = 5`.
- **Cap:** the internal `vector.retrieve({ topK: SOURCE_TOP_K=10 })` is bounded by
  `RETRIEVAL_MAX_TOP_K = 50` (vector validation). But the **fused `outputTopK`
  (caller's `topK`) is NOT capped by the hybrid service** — it is passed straight to
  `fuse()`. So the `search_content` tool MUST cap its own `top_k` argument.

### 4. Filtering — query-only today

- `HybridRetrievalService.retrieve` calls `vector.retrieve(query, { topK: SOURCE_TOP_K })`
  and `es.search(query, SOURCE_TOP_K)` — it **does not forward `options.filter` or
  `scoreThreshold`**. So hybrid retrieval is **query-string-only**; there is **no
  metadata/structured filter** (by episode, guest, date) on the hybrid path today.
  (`VectorRetrieverService` alone has a `sanitizeFilter()` allow-list, but it's bypassed
  in the hybrid orchestration.)
- Implication: `search_content` is naturally a pure semantic+keyword content search.
  Structured filtering is `query_metadata`'s job; a filtered content search
  (e.g. "what did **guest X** say about Y") would be a *new* capability — flag as
  additive/out-of-scope for 5.2 unless we decide to plumb `filter` through hybrid.

### 5. ±1 neighbor expansion — inside `retrieve()`, post-fusion

- Expansion happens **inside `HybridRetrievalService.retrieve()`**, AFTER fusion, behind
  `NEIGHBOR_EXPANSION_ENABLED` (default true). `captureFusedTopK` fires with the
  pre-expansion fused list; then `NeighborExpansionService.expand(fused)` runs.
- **What the caller actually receives:** the **expanded** `RetrievedChunk[]` — up to
  `MAX_EXPANDED_CHUNKS = 12` chunks (`NEIGHBOR_WINDOW = 1`), ordered by the expansion
  adjacency algorithm (each fused parent's ±1 neighbors glued adjacent, in `chunk_index`
  order), NOT pure score order. Parents keep their RRF score; **injected neighbors have
  `score = 0`**. So a default `top_k=5` call typically returns ~10–12 chunks to the caller.

### 6. Current call site (the integration point)

- `QaChainService.ask()` (`src/modules/qa/qa-chain.service.ts:246`):
  ```ts
  const chunks = await this.retriever.retrieve(cleanedQuestion, {
    topK,                                   // = options.topK ?? QA_DEFAULT_TOP_K(5)
    captureFusedTopK: (fused) => { fusedTopK = fused; },
  });
  ```
  `askStream()` (line ~593): `await this.retriever.retrieve(cleanedQuestion, { topK })`.
  `retriever` is the injected `RETRIEVER` token. → `search_content` wrapping the same
  token is **purely additive**; the Phase 4 QA path is untouched.

### 7. Passage size (token-budget input)

- Chunker: `CHUNK_SIZE = 800`, `CHUNK_OVERLAP = 100` (`chunker.service.ts`).
- Live measurement (200-chunk sample): text length **min 397 / median 796 / mean 792 /
  max 799 chars** → ~**200 tokens per chunk**. A default `search_content` call returning
  the expanded set (~10–12 chunks) ≈ **2,000–2,400 tokens** of passage text before the
  model's answer — relevant for whether the tool returns full text vs. excerpts.

### 8. Existing tool wiring — **5.2 is the first tool**

- No `bind_tools` / `bindTools` / `tool()` / `DynamicStructuredTool` /
  `withStructuredOutput` anywhere in `src/` (grep hits only in `CLAUDE.md`,
  `docs/ADR/0007`, and the `langchain-js-lcel` skill — docs, not code).
- LLM today: `LlmService.createChatModel()` → `ChatGoogleGenerativeAI`
  (`@langchain/google-genai`, model `gemini-2.5-flash-lite`, used by `QaChainService`
  via the LCEL `prompt | llm | StringOutputParser` chain). There is **no tool-calling
  setup yet** — 5.2 (tool defs) + 5.3 (`bindTools` + routing) introduce it for the first
  time. Gemini function calling is supported by `ChatGoogleGenerativeAI.bindTools()`.

---

## Open design questions for the joint step (NOT decided here)

1. **Output shape of `search_content`:** expose full chunk text or excerpts? include
   `episode_id`/`title`/`guest_name` per result? **Drop the meaningless RRF `score`**
   and expose **rank** instead? Return the expanded set (~12) or just the fused top-k?
2. **Token budget:** ~200 tokens/chunk × ~12 ≈ 2.4k tokens — acceptable for a single
   tool result, or cap the returned chunk count / truncate text?
3. **Input schema:** `query` (required) + optional `top_k` (with a hard cap, since hybrid
   doesn't cap `outputTopK`). Any structured filter? (Hybrid is query-only today — adding
   `filter` would be a new, additive capability; recommend deferring to keep 5.2 clean.)
4. **Tool description:** how to tell the model `search_content` = "what was *said* about a
   topic" vs `query_metadata` = "exact facts/counts over episodes" — the routing hinge.
5. **Wrap seam:** confirm wrapping the `RETRIEVER` token (additive, honors the toggle)
   vs. `HybridRetrievalService` directly.

---

## Part 2 — 5.2.1 `search_content` — LOCKED decisions & implementation

**Module:** new `src/modules/tools/` (Phase 5.2 Tool Definitions). Cycle-free: it
imports `RetrievalModule` and re-declares the `RETRIEVER` binding via the existing
`retrieverProvider` (from `qa/retriever.provider.ts`) — it does NOT import `QaModule`
(which would cycle once 5.4 wires routing into QA). The Phase 4 QA path is untouched.

1. **Wrap seam.** `SearchContentToolService` injects the **`RETRIEVER` token**
   (`IRetriever`) and calls `retrieve(query, { topK })` — the exact seam
   `QaChainService` uses, so the hybrid/vector toggle keeps working and the tool is
   byte-identical to Phase 4 retrieval. Additive.

2. **Input schema** (`search-content.schema.ts`, Zod — for runtime validation now +
   `bindTools` in 5.3): `{ query: string (required, non-empty), top_k?: number }`.
   The service **clamps** `top_k` to `[1, SEARCH_CONTENT_MAX_TOP_K=10]`
   (default 5) before calling `retrieve` — hybrid does not cap the fused `outputTopK`,
   so the tool must. Empty/whitespace `query` → `InvalidToolInputException` (400),
   thrown BEFORE touching the retriever. No structured filter (query-only; deferred).

3. **`top_k` semantics.** `top_k` is the **fused `topK` passed to `retrieve()`**
   (the knob hybrid leaves uncapped), default 5, cap 10. The tool returns the
   retriever's **expanded** output in order (Phase 4 already caps it at
   `MAX_EXPANDED_CHUNKS=12`); it does NOT slice the expanded set to `top_k`, because
   that would cut the ±1 neighbor context the expansion exists to provide. So
   `top_k=5` typically yields ~10–12 passages; `top_k=10` yields ≤12.

4. **Output shaping.** Per passage: `{ text, title, episodeId, guestName? }`
   (`guestName` included only when non-empty). **Dropped:** RRF `score` (meaningless
   magnitude; neighbors are 0), `id`/`chunk_id`, `chunkIndex`/`total_chunks`, and the
   empty fields (`guest_affiliation`, `guest_role`, `date`). Order preserved
   (neighbor-adjacency), full passage text.

5. **Mirror (what I aligned to).** `QaChainService.formatContext()` renders context as
   `` `[Source ${idx+1}]\n${chunk.document}` `` joined by `\n\n`. The tool reproduces
   that **`[Source N]` numbered-block, blank-line-joined convention** in its `context`
   string (the LLM-facing rendering the 5.3 ToolMessage will carry), enriched with a
   one-line attribution header for the kept fields:
   ```
   [Source 1] episode=269 title="…"[ guest="…"]
   {full passage text}

   [Source 2] …
   ```
   The structured `passages[]` (decision-3 fields) is the testable contract; `context`
   is the mirrored string. (I reproduced the convention rather than refactoring
   `formatContext` out of `QaChainService`, to keep Phase 4 untouched — extracting a
   shared formatter is a noted future cleanup.)

6. **Return shape.** `execute(input): Promise<{ passages: SearchContentPassage[];
   context: string }>`.

7. **Description (provisional, finalized jointly in 5.2.2).** "Search the podcast
   transcripts for passages about a topic. Use for questions about what was *said* or
   *discussed* in the episodes (opinions, explanations, quotes, arguments) — NOT for
   counts/lists/exact facts about the collection."

**Tests:** unit (mock `RETRIEVER`: fields kept/dropped, `guestName` presence, `top_k`
default & clamp-to-10, order preserved, `[Source N]` context format, empty-query
rejection, empty-result handling) + skippable integration (real `RETRIEVER` via
`AppModule`).

---

## Part 3 — 5.2.2 `query_metadata` — Step-0 research & PROPOSAL (for sign-off)

`query_metadata` is the symmetric twin of `search_content`: it wraps
`MetadataQueryService.aggregate(request)` (Phase 5.1) as an LLM-callable tool.
**No code yet** — this is the proposal.

### A. The engine we wrap (`MetadataQueryService`, verbatim)

- Entry: `aggregate(request: MetadataQueryRequest): Promise<MetadataQueryResult>`.
- **Request = discriminated union on `type`:**
  - `count` — optional `filter: { field: keyword, value: string }`
  - `count_distinct` — `field: keyword`
  - `filter` — `field: keyword`, `value: string`, optional `limit`
  - `min` / `max` — `field: numeric`
  - `avg` — `field: numeric`
  - `group_by` — `field: keyword`, optional `size`
- **Field allow-lists:** keyword = `episode_id | guest_name | title`; numeric =
  `duration_min` (only). Empty fields (`date`, `guest_affiliation`, `guest_role`)
  and `total_chunks` are NOT aggregatable.
- **Result per type:** `count → {value, filter?}`, `count_distinct → {field,value}`,
  `filter → {field,value,count,episodes: EpisodeRef[]}`, `min|max →
  {field,value:number|null,episode:EpisodeRef|null}`, `avg → {field,value:number|null}`,
  `group_by → {field, buckets:[{key,count}]}` (count = episodes, episode grain).
- **Caps (constants):** `DEFAULT_FILTER_LIMIT 50 / MAX 200`,
  `DEFAULT_GROUP_BY_SIZE 10 / MAX 100`.
- **Fail-loud:** bad input → `InvalidMetadataQueryException` (400) *before* ES;
  ES error/malformed → `MetadataQueryFailedException` (500). Never a guessed value.

### B. Schema shape — FLAT, not the discriminated union (evidence)

**Recommendation: a FLAT single-object LLM-facing schema, mapped to the strict
`MetadataQueryRequest` union in code.** Evidence (read from the installed deps):

- `@langchain/google-genai` **0.2.18**, `@langchain/core` ^0.3.0, `zod` 3.23.8.
- Its converter `schemaToGenerativeAIParameters()`
  (`utils/zod_to_genai_parameters.js`) only strips `$schema`,
  `additionalProperties`, `strict` — it does **NOT** transform/flatten
  `anyOf`/`oneOf`. A Zod **discriminated union** → `toJsonSchema()` emits a
  top-level `{ anyOf: [...] }` (no top-level `type:"object"`/`properties`), passed
  straight to Gemini's function `parameters`. Gemini's FunctionDeclaration schema
  is an OpenAPI **OBJECT-with-properties** subset; `convertToGenerativeAITools`
  even branches on `jsonSchema.type === "object"`. So a union is rejected/unreliable.
- Even where `anyOf` is tolerated, union function-calling is error-prone (the model
  must pick a variant AND fill the right per-variant fields). The robust, conventional
  pattern is **flat object + enum discriminator**, which converts cleanly to a Gemini
  OBJECT schema and is what `search_content` already does (flat `{query, top_k}`).

**Proposed flat LLM-facing schema** (Zod → bound in 5.3):
```ts
{
  type:  enum('count','count_distinct','filter','min','max','avg','group_by')  // required
  field?: enum('episode_id','guest_name','title','duration_min')
          // the field to operate on. Required for every type EXCEPT 'count'
          // (where it is the OPTIONAL filter field).
  value?: string
          // exact value to match. Required for 'filter'; optional for 'count'
          // (counts episodes where field == value). Ignored otherwise.
  limit?: integer
          // 'group_by' → number of buckets (default 10, max 100);
          // 'filter'   → max episodes returned (default 50, max 200). Ignored otherwise.
}
```
- `type` and `field` are **enums** (Gemini supports STRING enums) — they constrain the
  vocabulary at the schema level. The enum can't encode the keyword-vs-numeric pairing
  (e.g. `avg` needs `duration_min`); that is enforced at runtime by
  `MetadataQueryService` (fail-loud) — the schema stays permissive, the service is the
  trust boundary (already built in 5.1).
- **Tool-level validation** (`Zod .superRefine`): `field` required unless `type='count'`;
  `value` required when `type='filter'`. Flat-shape failures → `InvalidToolInputException`.
- **Mapping flat → union:** `count` (field&value → `{type:count, filter:{field,value}}`
  else `{type:count}`); `filter` → `{type:filter, field, value, limit}`; `group_by` →
  `{type:group_by, field, size:limit}`; others → `{type, field}`.

### C. How the LLM expresses filters

- **Exact keyword equality** — `guest_name = "X"`, `title = "Y"`, `episode_id = "Z"`:
  expressible as `type='filter'` (list matching episodes) or `type='count'` with
  `field`+`value` (count them). ✓ supported.
- **Numeric comparison** — `duration_min > 60`: ⚠️ **NOT supported.** The 5.1 engine's
  `filter` is an exact `term` on a **keyword** field only; there is no range/comparison
  aggregation in the closed set. Numeric questions are answered via `min`/`max`/`avg`
  (e.g. "longest episode" = `max duration_min`), not range filters. So "how many
  episodes longer than 60 min" is not answerable today. **Recommend: scope numeric-range
  filtering OUT of 5.2.2, log as a deferred extension** (it needs a `range` aggregation
  added to `MetadataQueryService` — a 5.1 change), mirroring the deferred "episodes
  mentioning X" item. The tool description will say filters are exact-match only.

### D. Output shaping — symmetric to `search_content`

Return **`{ result, summary }`** (mirrors `search_content`'s `{ passages, context }`):
- `result: MetadataQueryResult` — the structured, typed `aggregate()` output (the
  testable contract).
- `summary: string` — a one-line natural-language rendering (the LLM-facing string the
  5.3 ToolMessage carries), e.g.:
  - count → `"There are 319 episodes."` / `"4 episodes match guest_name = \"Michael Malice\"."`
  - count_distinct → `"There are 281 distinct guest_name values."`
  - filter → `"4 episodes match guest_name = \"Michael Malice\": <title> (ep 269), …"`
  - min/max → `"The maximum duration_min is 315 (episode \"<title>\", ep 7)."`
  - avg → `"The average duration_min is 59.75."`
  - group_by → `"Top guest_name by episode count: Eric Weinstein (4), Manolis Kellis (4), Michael Malice (4)."`
- **Fail-loud preserved:** flat-shape errors → `InvalidToolInputException`; map →
  `aggregate()`. **Proposed:** re-wrap `InvalidMetadataQueryException` →
  `InvalidToolInputException` (uniform "model gave bad args" signal for the 5.3 router),
  but let `MetadataQueryFailedException` (500, infra) **propagate** untouched. (Open for
  discussion — alternative is to let both metadata exceptions propagate as-is.)

### E. DRAFT joint descriptions (lock the wording together)

The routing hinge. Drafted as a contrasting pair:

> **`search_content`** — "Search the podcast transcripts and return passages about a
> topic. Use this when the user asks about the SUBSTANCE of what was said or discussed —
> opinions, explanations, definitions, quotes, arguments, or any subject matter inside
> the conversations (e.g. 'What did Lee Cronin say about constructors?', 'How do guests
> describe consciousness?'). Returns relevant transcript passages with episode/title
> attribution. Do NOT use it to count, list, rank, or compute exact facts about the
> collection — use query_metadata for that."

> **`query_metadata`** — "Answer EXACT factual questions about the COLLECTION of episodes,
> not the transcript content. Use this when the answer is a number, a list, a ranking, or
> an exact-match lookup over structured fields (episode_id, guest_name, title,
> duration_min). Operations: count (how many episodes), count_distinct (how many distinct
> guests/titles), filter (which episodes feature a given guest/title), min/max/avg
> (longest/shortest/average episode duration), group_by (episodes per guest — e.g. which
> guest appears most). Examples: 'How many episodes are there?', 'How many distinct
> guests?', 'Which guest appears in the most episodes?', 'What is the longest episode?',
> 'List episodes with guest Michael Malice'. Filters are exact-match only (e.g.
> guest_name = 'X') — it cannot do numeric comparisons like 'duration > 60'. Do NOT use
> it for what was SAID about a topic — use search_content for that."

### F. Conventions to mirror from 5.2.1 (locked)

Same `src/modules/tools/` module; `QueryMetadataToolService.execute(input)`; Zod schema
file (`query-metadata.schema.ts`); `tools.types.ts` for the result shape;
`InvalidToolInputException`; `tools.constants.ts` for the tool name + description; **no
LLM / no bindTools here** (that's 5.3). `ToolsModule` adds the new service (imports
`MetadataModule`, already in the app) and exports it. Unit tests (mock
`MetadataQueryService`) + skippable integration (real service via `AppModule`).

### Open items to confirm before the build prompt
1. Flat schema shape (B) — approve `{type, field?, value?, limit?}` and the enum/refine plan.
2. Numeric-range filtering (C) — confirm DEFER (out of 5.2.2).
3. Exception policy (D) — re-wrap `InvalidMetadataQueryException` → `InvalidToolInputException`, propagate `MetadataQueryFailedException`? Or propagate both?
4. **Final joint description wording (E)** — the routing boundary; lock both together.

---

## Part 4 — 5.2.2 LOCKED (build) ✅

All four open items resolved; `query_metadata` built.

1. **Flat schema** `{ type: enum(7), field?: enum(4), value?: string, limit?: int }`
   with `.superRefine` (per-type requiredness: field required for everything except
   `count`; `value` required for `filter`; `count`'s field+value are all-or-nothing).
   Flat→strict-union mapping per §B; the service enforces keyword↔numeric pairing
   (fail-loud). `query-metadata.schema.ts`.
2. **Numeric-range filtering DEFERRED** (out of 5.2.2). Filters = exact keyword
   equality only.
3. **Exception policy:** flat-shape error → `InvalidToolInputException`;
   `InvalidMetadataQueryException` (e.g. `avg` on a keyword field) → re-wrapped to
   `InvalidToolInputException` (uniform bad-args signal for the 5.3 router);
   `MetadataQueryFailedException` (500, infra) **propagates** untouched (fail-loud).
4. **Output:** `{ result: MetadataQueryResult, summary: string }` (symmetric to
   `search_content`'s `{ passages, context }`).

### FINAL tool descriptions (both locked)

- **`search_content`** — "Use for questions about WHAT was said or discussed in the
  episodes — opinions, explanations, arguments, topics, anything from the spoken
  content. Returns relevant passages. Examples: 'What did X say about Y?', 'How did
  they explain Z?'"
- **`query_metadata`** — "Use for EXACT factual questions about the collection —
  counts, distinct counts, ranges (min/max/average), groupings, and exact-match
  filters over episode metadata (episode, guest, title, duration). Returns precise
  computed values, not passages. Examples: 'How many episodes?', 'How many distinct
  guests?', 'Longest/average episode?', 'Which guest appears most?', 'How many
  episodes feature guest X?'"

### Deferred additive extensions (logged — do not lose)

- **Numeric-range filtering** (e.g. `duration_min > 60`) — needs a `range` aggregation
  added to `MetadataQueryService` (5.1 closed set). Out of 5.2.2.
- **"How many episodes mention X"** — content-conditioned count; needs a text filter on
  the chunk index (`cardinality(episode_id)` within a `match`). Carried from 5.1.
- Both belong to a future metadata-capability sprint; flagged for 5.3 routing / 5.5 eval.
