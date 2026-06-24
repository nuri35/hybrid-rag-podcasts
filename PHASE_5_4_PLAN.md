# Phase 5.4 Plan — Wire the router into the QA pipeline

> **Status: ✅ COMPLETE.** QA-side facade (C3) integration + shared-provider extraction
> (sanitization, output-validation, integrity-check, ingestion-lock) + context-aware
> output validation (`AnswerKind`) + lock/integrity parity across both paths — all done,
> `557 passed / 46 skipped, 0 regressions`. **Tool-use-path resilience (retry / timeout /
> circuit-breaker + token telemetry) is consciously DEFERRED** — see "Resilience deferral"
> at the end of Part 3.

> **Part 1 — Step-0 research ONLY (read-only, no code, no design decisions).** This
> records how the QA pipeline works today so we can choose the integration approach
> together. No wiring option is proposed or picked here.

---

## 1. Entry path — how a question flows today

Two endpoints, both on `QaController` (`src/modules/qa/qa.controller.ts`,
`@Controller({ path: 'questions', version: '1' })` → mounted at `/api/v1/questions`):

**Non-streaming (POST):**
```
POST /api/v1/questions
  → QaController.ask(@Body() dto: AskQuestionDto): Promise<QaResponseDto>
      → QaChainService.ask(dto.question, { topK: dto.topK }): Promise<QaResult>
  → returns QaResult (serialized as QaResponseDto)
```
Controller is a **thin pass-through** (one line: `return this.qaChainService.ask(dto.question, { topK: dto.topK })`). `@HttpCode(200)`, `@SkipThrottle({ stream: true })` (so only the `default` 30/min throttler binds).

**Streaming (GET, SSE):**
```
GET /api/v1/questions/stream?question=…&topK=…
  → QaController.askStream(@Query() query: AskQuestionStreamQuery): Observable<MessageEvent>
      → wraps QaChainService.askStream(query.question, { topK }): AsyncGenerator<StreamEvent>
  → SSE (text/event-stream)
```
`@Sse('stream')` (forces GET), `@SkipThrottle({ default: true })` (only the stricter `stream` 5/min throttler binds). The controller adds a 15 s heartbeat `setInterval`, iterates the generator into `subscriber.next({ data: JSON.stringify(event) })`, and tears down the generator on disconnect.

App bootstrap (`main.ts`, mirrored in `qa.controller.integration.spec.ts`): ExpressAdapter w/ 10 KB body limit, URI versioning (`api/v`), global `ValidationPipe` (whitelist + forbidNonWhitelisted + transform), `AllExceptionsFilter`, Swagger at `/api/docs`, `trust proxy`.

## 2. `QaChainService` public surface

`src/modules/qa/qa-chain.service.ts` (`@Injectable`, `implements OnModuleInit`). Exported by `QaModule`.

```ts
async ask(question: string, options: QaOptions = {}): Promise<QaResult>
async *askStream(question: string, options: QaOptions = {}): AsyncGenerator<StreamEvent, void, void>
```
- `QaOptions = { topK?: number }` (default from `QA_DEFAULT_TOP_K`).
- **`QaResult` (`qa.types.ts`):**
  ```ts
  interface QaResult {
    answer: string;
    sources: QaSource[];                 // { chunkId, score, excerpt, metadata } — the (expanded) chunks the LLM saw
    retrievalMetadata?: RetrievalMetadata; // { fusedTopK: { chunkId, rrfScore, rank }[] } — eval only; omitted on cache hit / empty retrieval
  }
  ```
- **What `ask()` does around the LLM call** (all the cross-cutting work lives here, NOT in the controller): ① ingestion-lock check (fail-open), ② startup integrity gate, ③ prompt sanitization (Layer 1, can reject → 400), ④ retrieve via the `RETRIEVER` token (+ `captureFusedTopK`), ⑤ empty-retrieval canned fallback (no LLM), ⑥ exact-match Redis response cache lookup, ⑦ `formatContext` → LCEL chain through `ResilientLlmService` (circuit + retry + token callback) inside a `Promise.race` timeout, ⑧ output validation (Layer 3, can reject → 500), ⑨ map chunks → `QaSource[]`, ⑩ cache write, ⑪ `qa_complete` structured log with token usage.
- **Error policy:** known domain exceptions pass through (mapped to 4xx/5xx by `AllExceptionsFilter`); unknown → `QaChainFailedException` (500) with a correlation ID.

## 3. Streaming today

- `askStream()` is an **`AsyncGenerator<StreamEvent>`** (not RxJS, not raw SSE). Event ordering: exactly one `sources` → zero+ `token` → one terminator (`done` | `error`). Types in `dto/stream-event.types.ts`.
- Same entry guards as `ask()` (lock + integrity + sanitization) run BEFORE the first yield (so they surface as proper HTTP errors). Mid-stream resilience is **initiation-only** (`ResilientLlmService.streamChain` protects the first chunk; consumption is unprotected). Unknown mid-stream errors become an SSE `error` event; known exceptions propagate.
- The controller (`askStream`) is the only consumer — wraps the generator in `Observable<MessageEvent>` with heartbeats + teardown.

## 4. `ToolRouterService.route()` shape vs `QaResult`

`src/modules/tools/tool-router.service.ts` (exported by `ToolsModule`):
```ts
async route(question: string): Promise<RouteResult>
// RouteResult (tools.types.ts) = { answer: string; toolUsed: string[]; latency: number }
```
Distance from the QA contract (facts, not a recommendation):
- **`answer: string`** — present in both. ✔ direct match.
- **No `sources`** — `route()` does **not** surface citations. `search_content`'s passages are formatted into the `context` string fed to the LLM **inside the tool**, but `route()` returns only the final text; the `QueryMetadataResult`/`SearchContentResult` structures are not propagated out of `route()`. The QA endpoint contract (`QaResponseDto.sources: QaSourceDto[]`) currently has **no producer on the router path**.
- **No `retrievalMetadata`** — router has no `fusedTopK` equivalent (no `captureFusedTopK` plumbing).
- **Extra fields** `toolUsed: string[]` and `latency: number` have **no home** in `QaResponseDto`.
- **No `topK`/`QaOptions`** — `route()` takes only `question`; `top_k` is a per-tool arg the LLM fills, not a route-level knob.
- **No streaming** — `ToolRouterService` has only `route()` (non-streaming). There is **no router equivalent of `askStream()`** (the two-call bound→unbound flow doesn't map onto the current SSE generator).
- **None of the `ask()` cross-cutting guards** (§2: lock, integrity, sanitization, cache, output-validation, resilience/timeout, token usage) exist on `route()` — it is bare routing (per ADR 0020, resilience explicitly deferred to 5.4).

→ A unifying DTO / wiring would have to reconcile: where `sources` come from on the router path (or that they're empty), where `toolUsed`/`latency` go (surface or drop), the streaming gap, and which `ask()` guards the router path inherits. **(Noted as facts to decide — not decided here.)**

## 5. Module / DI layout & cycle analysis

- **QA entry owned by `QaModule`** (`src/modules/qa/qa.module.ts`): declares `QaController` + `QaChainService` (+ resilience/sanitization/validation/cache services + `retrieverProvider`). Imports: **`RetrievalModule`, `LlmModule`, `RedisModule`, `VectorStoreModule`**. Exports `QaChainService` (+ several services). **Does NOT import `ToolsModule`.**
- **`ToolsModule`** (`src/modules/tools/tools.module.ts`): declares `SearchContentToolService`, `QueryMetadataToolService`, `ToolRouterService` (+ its own `retrieverProvider`). Imports: **`RetrievalModule`, `MetadataModule`, `LlmModule`**. Exports all three services incl. `ToolRouterService`. **Does NOT import `QaModule`** (deliberately, per 5.2/5.3 — "no cycle once routing wires back into QA").
- **Cycle check:** `QaModule` importing `ToolsModule` (to inject `ToolRouterService`) is **acyclic today** — `ToolsModule` does not import `QaModule`. The reverse (`ToolsModule` importing `QaModule`) would cycle. Both modules independently re-declare the `RETRIEVER` token via `retrieverProvider` (separate module-scoped instances — no conflict).
- Both modules already imported by `AppModule` (`QaModule` before `ToolsModule`).

## 6. Config / flag convention

- Read via `ConfigService<Env, true>` + `config.get('KEY', { infer: true })`. Schema is Zod (`src/common/config/env.schema.ts`), validated at boot.
- **Boolean toggles use `enum(['true','false']).default(...).transform(v => v === 'true')`**, NOT `z.coerce.boolean()` (which maps `"false"` → `true`). Precedent: `HYBRID_RETRIEVAL_ENABLED`, `NEIGHBOR_EXPANSION_ENABLED`. A `TOOL_USE_ENABLED` flag would follow this exact pattern (default value is a 5.4 decision, not made here).
- Toggle wiring precedent (`retriever.provider.ts`): a named `selectRetriever(config, …)` factory binds a DI token (`RETRIEVER`) to one of two implementations based on the flag — `QaChainService` injects the token, so the call site is unchanged and there are no scattered `if`s. (This is the existing "one seam" pattern; whether 5.4 reuses it is a decision.)

## 7. Existing endpoint test setup (to mirror)

- **No `*.e2e-spec.ts` files exist.** The endpoint-level tests are:
  - `qa.controller.spec.ts` — **unit**, mocks `QaChainService`, asserts the controller pass-through.
  - `qa.controller.integration.spec.ts` — **skippable HTTP integration** (`describe.skip`), boots `AppModule` via `Test.createTestingModule`, mirrors the `main.ts` bootstrap (ExpressAdapter + 10 KB limit + ValidationPipe + versioning + Swagger + filter), drives real HTTP via **supertest** (`request(httpServer).post('/api/v1/questions')…`). Documents enable steps (needs Chroma + GOOGLE_API_KEY).
  - `qa-chain.integration.spec.ts` — service-pipeline integration (skippable).
- → 5.4 endpoint tests would mirror this: a controller **unit** test (mocked) + a **skippable supertest** integration test, same bootstrap. (Mirroring is a fact about convention, not a decision on what to test.)

---

## Open items to decide together (NOT decided here)
1. **Wiring seam** — toggle inside `QaChainService.ask()` (router as an alternate path behind a token/flag, inheriting its guards) vs. a separate controller path vs. a `selectRetriever`-style factory. (§5 says either direction is acyclic with `QaModule` importing `ToolsModule`.)
2. **`sources` on the router path** — surface tool results as `QaSource[]`, return empty, or a new shape (§4 gap).
3. **`toolUsed`/`latency`** — surface in the response/logs or drop.
4. **Streaming** — whether the router path supports `askStream()` at all (no router equivalent exists, §3/§4).
5. **Which `ask()` guards** (lock, integrity, sanitization, cache, output-validation, resilience/timeout, token usage) the router path inherits (resilience was explicitly deferred to 5.4 in ADR 0020).
6. **`TOOL_USE_ENABLED` default** and exact flag name (§6 convention is fixed; the value is open).

**Stop — research only. Wiring design + option selection is the next step, to be done together.**

---

# Part 2 — Classification of `ask()`'s cross-cutting concerns (Step 0.5)

> Read-only. Goal: know EXACTLY which concerns are **path-independent** (run for both
> the tool-use and direct RAG paths → extraction candidates) vs **`ask()`-specific**
> (tied to the classic RAG flow → must stay) vs **ambiguous** (flag to decide). Line
> numbers are `src/modules/qa/qa-chain.service.ts`.

## Bucket table

| # | Concern | `ask()` lines | `askStream()` lines | Bucket | Pre-routing / Post-answer |
|---|---|---|---|---|---|
| 1 | Ingestion-lock check | 197–208 | 558–569 | **SHARED** | Pre-routing |
| 2 | Integrity gate | 212–214 | 572–574 | **SHARED** (state caveat) | Pre-routing |
| 3 | Prompt sanitization (OWASP L1) | 231–235 | 579–583 | **SHARED** | Pre-routing |
| 4 | Output validation (OWASP L3) | 327–330 | 643–658 | **SHARED** (divergent failure) | Post-answer |
| 5 | `correlationId` generation | 223 | 553 | **SHARED** (trivial) | Pre-routing |
| 6 | Resilient LLM wrap (circuit+retry) | 310–318 | 621–629 | **AMBIGUOUS** | (around LLM call) |
| 7 | LLM timeout (`invokeWithTimeout`) | 310/505–522 | 621/723–750 | **AMBIGUOUS** | (around LLM call) |
| 8 | Token-usage telemetry | 373, 380–382 | 661–666 | **AMBIGUOUS** | Post-answer |
| 9 | Retrieval + `captureFusedTopK` | 245–251 | 593 | **ask()-SPECIFIC** | — |
| 10 | Empty-retrieval canned fallback | 257–260 | 599–607 | **ask()-SPECIFIC** | — |
| 11 | Exact-match response cache (lookup+write) | 269–297, 344–362 | — (not cached) | **ask()-SPECIFIC** | — |
| 12 | `formatContext` + Phase-4 QA prompt chain | 300, 310–319 | 618, 621–641 | **ask()-SPECIFIC** | — |
| 13 | `mapChunksToSources` + `buildRetrievalMetadata` | 333, 336 | 611 (sources only) | **ask()-SPECIFIC** | — |
| 14 | Score stats + `qa_complete` log | 366–382 | 660–667 | **ask()-SPECIFIC** | Post-answer |

## SHARED items — extraction detail

**1. Ingestion-lock check** — refuses queries while an ingestion run holds
`REDIS_KEYS.INGESTION_LOCK`; **fail-open** (Redis error → WARN + proceed). Throws
`IngestionInProgressException` (503). **Depends on:** `DistributedLockService`,
`REDIS_KEYS`. **Pre-routing.** **Coupling:** none — pure guard, no `ask()` state read.
Duplicated near-verbatim in both methods → clean extraction candidate.

**2. Integrity gate** — `if (!this.integrityState.healthy) throw DataIntegrityMismatchException`
(503). **Depends on:** `this.integrityState` — instance state set ONCE at
`onModuleInit → verifyIntegrityOnStartup()` (138–191), which itself depends on
`RedisService` + `ChromaRepository.count()`. **Pre-routing.** **⚠️ Coupling/risk:** the
*check* is path-independent, but the *state + the startup verification that sets it* are
owned by `QaChainService` (module-init lifecycle). Extracting the gate cleanly means
moving `verifyIntegrityOnStartup` + `integrityState` into the shared owner too — otherwise
the provider has nothing to read. This is the only SHARED item with non-trivial extraction
risk.

**3. Prompt sanitization (OWASP L1)** — `promptSanitization.inspect(question, correlationId)`;
`REJECTED` → `QuestionRejectedException` (400); otherwise yields `cleanedQuestion`
(`FLAGGED` is non-fatal, already warn-logged). **Depends on:** `PromptSanitizationService`,
`correlationId`. **Pre-routing.** **Coupling:** none — pure function of `(question,
correlationId)`; its output `cleanedQuestion` is what every downstream step consumes.
Strongest extraction candidate (the router would route on the *cleaned* question).

**4. Output validation (OWASP L3)** — `outputValidation.validate(answer, correlationId)`;
`REJECTED` blocks the answer. **Depends on:** `OutputValidationService`, the final
`answer` string, `correlationId`. **Post-answer.** **Coupling:** low (pure function of the
answer string — the router produces an `answer` string too). **⚠️ Divergent failure
handling:** `ask()` THROWS `OutputRejectedException` (500); `askStream()` instead yields an
SSE `error` event (643–658) because tokens already shipped. A shared validator can centralize
the verdict, but the two call sites must keep their own throw-vs-emit reaction.

**5. `correlationId`** — `randomUUID()` per request; threaded into sanitization, the
resilient invoke callback, cache logs, and the `qa_failed` wrap path. Path-independent and
trivial; naturally facade/owner-level (one ID per request, shared by guards + LLM call).

## AMBIGUOUS items — flagged for decision

**6 + 7. Resilient-LLM wrap + timeout** — `ask()` wraps **its own LCEL chain**
(`promptTemplate | llm | StringOutputParser`, built in the constructor, 129–135) through
`ResilientLlmService.invokeChain(chain, …)` inside a `Promise.race` timeout. The **router has
its own two `invoke`s (bound + unbound) with NO resilience** (ADR 0020 explicitly deferred
resilience to 5.4). Conceptually both paths call Gemini and *should* be protected, but the
current wrap is bound to `ask()`'s `chain` object, not a generic model call. **Decision:**
does the router path get wrapped by the same circuit/retry/timeout (shared), and if so at
what granularity (per-`invoke` vs per-`route()`)? `streamChain` is initiation-only — a router
streaming path (if any) would need its own story.

**8. Token-usage telemetry** — `tokenUsageService.createCallback(correlationId)` is passed
*into* `ResilientLlmService.invokeChain`, and `consumeUsage(correlationId)` is read at
completion for the `qa_complete`/`qa_stream_complete` log. Entangled with the specific LLM
call (the callback rides the chain invocation). The router's invokes don't register it today.
**Decision:** shared (route the callback through the router's invokes too) vs `ask()`-only.

## `ask()`-SPECIFIC items — why they must stay

- **9 Retrieval / 10 empty-fallback / 12 context+QA-prompt / 13 sources+fusedTopK / 14 score
  stats:** these ARE the classic RAG flow. The tool-use path does its own retrieval *inside*
  `search_content`, has no single "context string" (it has tool results), and surfaces no
  chunks to map — so none of these transfer. (#13 is the source of the §4 `sources` gap.)
- **11 Response cache:** the key folds in the **retrieved chunk IDs** + the QA prompt hash +
  `topK` + model (269–280) — inherently RAG-specific; the router has no chunk-id-keyed notion,
  and `askStream()` already opts out of caching entirely.

## Confirmations requested

- **Does `askStream()` share the same concerns?** Yes for the four SHARED guards (lock,
  integrity, sanitization, output-validation) — they appear **duplicated** in both methods,
  which is itself evidence they're path-independent. **Differences:** `askStream()` does NOT
  use the response cache (#11) and does NOT capture `fusedTopK`/`retrievalMetadata` (#13); its
  output-validation failure is an SSE `error` event, not a thrown exception (#4 caveat).
- **Is the integrity gate invoked inside `ask()` or higher up?** **Inside** both `ask()`
  (212–214) and `askStream()` (572–574) — there is no guard/middleware above the service. The
  *state* is set at `onModuleInit` (`verifyIntegrityOnStartup`). So today the service owns both
  the check and the state; a facade/provider extraction must decide who owns the startup check.

## Proposed extraction set (for sign-off — NOT locked)

Extract the **path-independent guards** into shared provider(s) the tool-use facade and the
direct RAG path both run:

- ✅ **Prompt sanitization (#3)** — clean, zero coupling; yields the `cleanedQuestion` both
  paths route on. *(highest-confidence extract)*
- ✅ **Ingestion-lock check (#1)** — clean, zero coupling, fail-open guard.
- ✅ **Output validation (#4)** — extract the *verdict*; each call site keeps its own
  throw-vs-SSE-emit reaction.
- ⚠️ **Integrity gate (#2)** — extract ONLY together with `verifyIntegrityOnStartup` +
  `integrityState` ownership (the one risky move); otherwise leave in place and have the
  facade call the existing service.
- ➕ **`correlationId` (#5)** — facade-owned, threaded into all of the above.

**Defer to the wiring decision (do not extract yet):** resilient-LLM wrap + timeout (#6/#7)
and token telemetry (#8) — these hinge on whether the router's `invoke`s get the same
protection, which is a 5.4 design choice, not a mechanical extraction.

**Keep in `ask()` untouched:** all `ask()`-SPECIFIC items (#9–#14) — extracting any of them
would alter the Phase-4 RAG path.

**Stop — classification + proposal only. No extraction, no code, nothing locked.**

---

# Part 3 — Build: pipeline integration via a QA-side facade (Option C3) — ✅ SHIPPED (resilience step pending)

> Implemented. Resilience/timeout/token around the router's invokes is the FINAL 5.4
> step (separate). Streaming gets NO tool-use.

## What shipped
- **`TOOL_USE_ENABLED`** (env, `enum(['true','false']).transform`, **default false**) — same
  toggle convention as `HYBRID_RETRIEVAL_ENABLED`.
- **`QaFacadeService`** (`qa-facade.service.ts`, in `QaModule`; `QaModule` now imports
  `ToolsModule` — acyclic) — the controller's non-streaming endpoint calls ONLY this.
  - OFF → `QaChainService.ask()` → maps `QaResult` → DTO (`path:'direct'`). `ask()`
    self-guards (lock, integrity, sanitize, output-validation, cache); the facade does
    NOT re-run them → **no double-processing**.
  - ON → integrity-check → sanitize → `ToolRouterService.route()` → **context-aware**
    output-verdict → DTO (`path:'tool_use'`, `sources:[]`, `toolUsed`, `latency`).
  - Pipeline log: `qa_pipeline path=… tool_used=… latency_ms=…`.
- **Asymmetry is forced, not a shortcut:** `ask()`'s output-validation must run BEFORE its
  cache write (rejected answers are never cached) and the RAG flow stays inside `ask()`
  (locked) — so the direct path keeps its guards internal while the tool-use path borrows
  the SAME injected providers (`PromptSanitizationService`, `OutputValidationService`).
  One implementation, multiple call sites.
- **Integrity-check extracted** to `QaChainService.assertDataIntegrity()` (state +
  `verifyIntegrityOnStartup` stay owned there); `ask()`/`askStream()` now call it instead
  of the inline check (behavior identical).
- **Unified `AnswerResponseDto`** — superset of the legacy body: `answer`, `sources`
  (always; `[]` on tool-use), `retrievalMetadata?` (direct only), `toolUsed?`/`latency?`
  (tool-use only), `path:'direct'|'tool_use'`. Additive → existing clients unaffected.
- **Streaming untouched** — the SSE endpoint still calls `QaChainService.askStream()`
  directly (no tool-use); it still uses the shared providers.

## Context-aware output validation (locked correction)
The citation gate would wrongly 500 a long uncited `query_metadata` answer. Fix: the
validator is **parameterized by an explicit typed `AnswerKind`** (`DIRECT`,
`TOOL_QUERY_METADATA`, `TOOL_SEARCH_CONTENT`) — it never infers the path or matches
strings. Policy, branched in ONE place (`citationRequired`):
- **DIRECT** → strict `[Source N]` rule **unchanged** (Phase 4 + q007/q024 fix preserved).
- **TOOL_QUERY_METADATA** → citation NOT required (computed value, no passages).
- **TOOL_SEARCH_CONTENT** → citation not mandatory in 5.4 v1 (matches `sources:[]`; can
  tighten later).
- **Universal floor on EVERY kind** (NOT a loosening): a genuinely empty/whitespace answer
  → `empty_answer` REJECTED; leakage → `prompt_leakage` REJECTED. The citation relaxation
  only skips the citation gate. The facade passes the kind via `resolveAnswerKind(toolUsed)`
  (search_content present → content kind, else metadata kind).
- ⚠️ **Note (DIRECT strengthening):** the new empty-answer floor also applies to DIRECT —
  a genuinely empty LLM answer now 500s (was silently VALID). An empty answer is malformed;
  Phase 4 never produced one in practice (the empty-retrieval path returns `NO_INFO_ANSWER`
  before validation), so no behavior change for real traffic.

## Tests / verification
- `tsc` + `eslint` clean. Existing QA tests **green** (Phase 4 direct path identical):
  `qa-chain.service.spec.ts`, the leakage/citation/refusal matrix in
  `output-validation.service.spec.ts` (now `AnswerKind.DIRECT`).
- New: `qa-facade.service.spec.ts` (toggle ON/OFF DTO shapes, no-double-processing,
  integrity-not-ready blocks, sanitize-reject, output-reject, kind mapping per tool);
  per-kind validator tests (DIRECT rejects vs tool kinds accept the same uncited answer;
  universal empty/whitespace/leakage floor on every kind); controller unit updated to the
  facade; skippable `qa-facade.integration.spec.ts` (both toggle states e2e).
- Full suite **555 passed / 46 skipped, 0 regressions** (was 537).

## Known test-harness limitation — `qa-facade.integration.spec.ts` toggle
`qa-facade.integration.spec.ts` flips `TOOL_USE_ENABLED` by mutating `process.env` in
`beforeAll`. Because `ConfigModule.forRoot({ cache: true })` snapshots env **once at process
startup**, runtime mutation is NOT honored — so when this spec is un-skipped as-is, the two
`TOOL_USE_ENABLED=true` blocks report `path:'direct'` (~2 failures). This is a **TEST-HARNESS
limitation, not a product defect**: verified via a shell-set flag (`TOOL_USE_ENABLED=true`)
that the tool-use path routes correctly, returns `sources:[]`/`toolUsed`/`319`, and the
context-aware citation relaxation returns **200** for a long uncited metadata answer. To run
the tool-use blocks cleanly, set the env var in the shell **before** jest starts (and/or split
the ON/OFF blocks into separate processes) rather than relying on in-process `beforeAll`
mutation. Pre-flight (all 6 Phase-5 live specs) confirmed **20/20 in-scope assertions pass and
all three 5.4 critical behaviors hold**.

## Follow-up shipped — ingestion-lock on the tool-use path
The ingestion-LOCK check (data-level guard) is now applied to the tool-use branch via the
SAME shared seam, completing the data-level-guard parity. Extracted the existing fail-open
lock check into `QaChainService.assertIngestionNotInProgress()` (lock ownership unchanged —
`DistributedLockService` still owns it; this only reads it); `ask()`, `askStream()`, and the
facade's tool-use path all call it (one implementation, three call sites). PRE-routing,
ordered lock → integrity exactly as `ask()`. Lock engaged → `IngestionInProgressException`
(503), identical to the direct path; Redis error → WARN `qa_lock_check_failed` + proceed
(fail-open, unchanged). `askStream()`'s fail-open log label unified to `qa_lock_check_failed`
(was `qa_stream_lock_check_failed` — no test asserted it; semantics identical). +2 facade
tests (engaged → blocked; free → proceeds + lock not re-run on the direct path). Full suite
**557 passed / 46 skipped, 0 regressions**.

## Resilience deferral (CLOSED — deliberately deferred, not pending)
Tool-use path resilience (retry / timeout / circuit-breaker + token telemetry around
`ToolRouterService`'s two Gemini invokes — the AMBIGUOUS Part-2 items #6/#7/#8) is
**deliberately DEFERRED.** Rationale: `ask()` already implements and demonstrates the full
resilient-LLM pattern (`ResilientLlmService` = circuit + retry + timeout + token callback);
duplicating it for the router is not warranted in this repo (YAGNI). It is **REQUIRED before
enabling `TOOL_USE_ENABLED` in production**, and is planned for the **agentic phase** where
multi-step loops make it essential. Until then, the **direct (ask) path remains fully
protected**; the tool-use path's two invokes are **unprotected by design**. With
`TOOL_USE_ENABLED` defaulting to `false`, no production traffic hits the unprotected path.

**Phase 5.4 is COMPLETE** — integration + shared-provider extraction + context-aware
validation + lock/integrity parity all done; resilience consciously deferred as above.
