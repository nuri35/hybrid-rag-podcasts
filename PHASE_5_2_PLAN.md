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
