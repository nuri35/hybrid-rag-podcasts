# ADR 0008 — HTTP endpoint, DTO validation, and Swagger UI

- **Status:** Accepted
- **Date:** 2026-05-20
- **Phase:** 1.7 (HTTP endpoint — Phase 1 closeout)
- **Related:** ADR 0007 (LlmModule + QaChainService — the layer this ADR exposes), CLAUDE.md decisions #6 (no upstream API gateway) and #16 (URI versioning + global ValidationPipe)

> **Numbering note.** The Phase 1.7 plan referred to "ADR-0005" for this work; `0005-segment-chronological-ordering.md` already occupies that slot. ADR numbers in this repo are append-only, so this file is `0008`.

---

## Context

Phases 1.1 → 1.6 produced everything needed to answer a question end-to-end:

1. CSV → cleaned → chunked → embedded → Chroma (1.2 / 1.3.a-e / 1.3.d).
2. Query → top-K chunks via `VectorRetrieverService` (1.5).
3. Top-K chunks → grounded answer + sources via `QaChainService.ask()` (1.6).

Phase 1.7's job was to expose `(3)` as an HTTP endpoint that:

- A `curl` user can hit (smoke test, demo).
- A future Phase 2 evaluation harness can hit programmatically (Ragas-style metrics).
- A recruiter clicking through the portfolio repo can see Swagger UI for.
- A future Phase 4 hybrid retrieval client can call without leaking module internals.

Three concrete questions shaped the decisions:

1. **How are versions cut?** This is a portfolio artifact, but the same surface area must survive Phase 4's hybrid endpoints without breaking earlier curls.
2. **How is input validated?** The `QaChainService` layer already validates *retrieval* inputs (empty / too short / too long). The DTO layer must validate *HTTP* inputs (presence of `question`, type of `topK`, etc.) before the service is even called.
3. **How are errors classified into HTTP status codes?** `QaChainService.ask()` already throws a stratified set of exceptions; the controller must not flatten them, nor write a giant `try/catch` ladder.

## Decision

### 1. URI versioning (`/api/v<N>/...`) via NestJS `enableVersioning`

```ts
app.enableVersioning({ type: VersioningType.URI, prefix: 'api/v' });

@Controller({ path: 'questions', version: '1' })
```

Mounts under `/api/v1/questions`. Considered alternatives:

| Variant | Why rejected |
|---|---|
| Header versioning (`X-API-Version: 1`) | Invisible in curl, browser dev tools, server logs, and Swagger UI without manual setup. Bad for a portfolio repo where the README is supposed to be obvious to a recruiter. |
| Media-type versioning (`Accept: application/vnd.app.v1+json`) | Same visibility problem, plus client noise. |
| No versioning, just `/questions` | Phase 4 will add hybrid retrieval. A `v2` namespace lets old curls keep working while the response shape evolves (e.g. `retrievalPath: 'hybrid' \| 'vector' \| 'graph'`). Not adopting versioning *now* costs nothing but means a breaking-change story later. |

URI versioning is also the variant Swagger UI renders natively — each `version: 'N'` controller produces a path entry like `/api/v1/questions` in the OpenAPI document without further work.

### 2. Global `ValidationPipe` with strict mode

```ts
new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
  transformOptions: { enableImplicitConversion: true },
});
```

Each flag is a deliberate call:

- **`whitelist: true`** — drops properties not decorated on the DTO. Without it, unknown fields would silently survive into service code.
- **`forbidNonWhitelisted: true`** — *rejects* requests with unknown fields rather than silently stripping. Decision: a client that sends `{ "topK": 5, "topKK": 100 }` (typo) should get a 400 ("property topKK should not exist"), not silently fall back to the default `topK`. Silent stripping makes typos invisible bugs.
- **`transform: true`** — DTO classes are instantiated, not left as plain objects. Required for `@IsInt` etc. to run against actual numeric types after JSON parsing.
- **`enableImplicitConversion: true`** — allows `?topK=5` (query string, always strings) to coerce to a number before `@IsInt` runs. Costs nothing for body-based JSON (already typed) but future-proofs query-string endpoints.

The validation surface is in two layers:

- **DTO layer (this ADR)** — HTTP wire validation. Catches missing/too-short/too-long `question` and out-of-range `topK` *before* the service ever runs. Returns 400.
- **Service layer (ADR 0007 + ADR 0003)** — domain validation. Catches whitespace-only questions, queries past 2000 chars (where embedding cost spikes), invalid retrieval options. Returns 400 via `BadRequestException` subclasses, mapped by `AllExceptionsFilter`.

The two layers overlap deliberately. A request with `question: "hi"` is rejected by the DTO (`@MinLength(3)`); a request with `question: "   "` would pass DTO but be rejected by the service (`QueryTooShortException`). Both return 400 with a clean message — the user does not need to know which layer caught them.

### 3. Thin controller pattern

```ts
@Post()
@HttpCode(HttpStatus.OK)
async ask(@Body() dto: AskQuestionDto): Promise<QaResponseDto> {
  return this.qaChainService.ask(dto.question, { topK: dto.topK });
}
```

The controller does three things and only three things:

1. Declare the route (`@Controller + @Post + @HttpCode`).
2. Bind input via DTO + `ValidationPipe`.
3. Hand off to the service and return its result.

No `try/catch`. No manual error mapping. No business logic. The reasoning:

- **Exception filter does the mapping.** `AllExceptionsFilter` (Phase 1.1) inspects the thrown exception's type and produces a clean JSON envelope. `QaChainFailedException` extends `InternalServerErrorException` (→ 500). `EmptyQueryException`, `QueryTooShort/Long`, `InvalidRetrievalOptions` extend `BadRequestException` (→ 400). `ChromaUnreachableException` falls through the unknown-error branch (→ 500). Adding a `try/catch` in the controller would either duplicate this logic or re-throw — both useless.
- **`@HttpCode(200)` is explicit.** NestJS defaults `POST` to 201; here the resource is not being created (idempotent read), so 200 is the right code. Documented in the Swagger annotation too.
- **Return type is `QaResponseDto`, not `QaResult`.** They are structurally identical (`{ answer, sources }`) so TypeScript accepts the assignment, but declaring the DTO makes the OpenAPI document show the right schema reference.

### 4. Swagger UI at `/api/docs`, OpenAPI JSON at `/api/docs-json`

```ts
const swaggerConfig = new DocumentBuilder()
  .setTitle('Hybrid RAG Podcasts API')
  .setDescription('RAG-based Q&A over Lex Fridman podcast transcripts.')
  .setVersion('1.0')
  .addTag('questions', 'Q&A endpoints')
  .build();
SwaggerModule.setup('api/docs', app, SwaggerModule.createDocument(app, swaggerConfig));
```

The OpenAPI document is generated entirely from controller and DTO decorators:

- `@ApiTags`, `@ApiOperation`, `@ApiBody`, `@ApiResponse` on the controller — operations and response codes.
- `@ApiProperty` on each DTO field — request and response schemas (including `minLength`, `maxLength`, `minimum`, `maximum` constraints that mirror the class-validator decorators).

This produces a self-documenting endpoint with zero handwritten OpenAPI YAML. When Phase 4 adds hybrid endpoints, the same decorator-driven approach picks up new controllers automatically; nobody edits a central OpenAPI file.

The `--legacy-peer-deps` install for `@nestjs/swagger@^11.4.3` follows the same justification as the `@google/generative-ai` install (CLAUDE.md decision #9): a transitive peer dep is stale relative to the current root install, but it does not affect actual usage.

### 5. Module location: extend `QaModule`, do not create `QuestionsModule`

Phase 1 plan listed a `QuestionsModule` separate from the chain layer. The actual implementation puts the controller in `QaModule` alongside `QaChainService` because:

- The controller is one file, two methods.
- A separate `QuestionsModule` would import `QaModule` and re-export nothing — a wrapper with no behaviour.
- Tests live next to the code they exercise (`qa.controller.spec.ts` next to `qa.controller.ts`).
- Future Phase 4 (hybrid retrieval) will register a *new* controller, not a wrapper around this one; the structural split happens then, not now.

The plan's module name is recorded in CLAUDE.md "Module structure" but as `qa/` not `questions/`. Drift between plan and code is documented in CLAUDE.md so the plan does not mislead future work.

### 6. Test strategy — unit tests at both layers, no e2e in this phase

Phase 1.7 ships two spec files (16 tests total):

- `qa.controller.spec.ts` (6 tests) — `Test.createTestingModule` with `QaChainService` mocked via `useValue`. Asserts delegation (question + topK passed correctly), undefined-topK passthrough so the service applies its own default, no-info shape preservation, and unchanged propagation of three exception types. Does **not** boot an HTTP server, does **not** use `supertest` — those would re-test NestJS itself rather than this project's behavior.
- `ask-question.dto.spec.ts` (10 tests) — `plainToInstance + validate()` from class-transformer/class-validator with the same options as the global `ValidationPipe`. Tests boundary cases (`topK = 1` and `topK = 50` accepted, `0` and `51` rejected), type errors (non-integer `topK`), and the `whitelistValidation` constraint that `forbidNonWhitelisted` produces.

Live HTTP smoke probes (curl) confirm wire-level behaviour (Swagger UI HTML, OpenAPI schemas, validation 400s, happy-path 200) but are *not* committed as automated tests because they require Chroma + Gemini both alive. They are listed in CHANGELOG and re-runnable from the manual smoke section.

## Alternatives considered (and rejected)

- **Express router + manual validation.** Would have meant re-implementing class-validator + Swagger generation by hand. The NestJS scaffolding is already paid for by Phase 1.1.
- **GraphQL.** Overkill for one endpoint with one input and one output. Adds schema definition + resolver overhead with no benefit at the current shape.
- **gRPC.** Wrong protocol for a portfolio-facing API; nobody hits a gRPC endpoint with curl.
- **Returning `QaResult` and mapping in a separate `QuestionsService`.** The DTO is structurally identical to `QaResult`; an intermediate service would be an empty layer.
- **Try/catch in the controller mapping exceptions to HTTP codes.** `AllExceptionsFilter` already does this globally. Controller-level try/catch would either duplicate the filter or stop the filter from working consistently.

## Consequences

- Adding new endpoints (Phase 4 hybrid, Phase 5 query routing) needs only a new controller; ValidationPipe + Swagger + versioning are already wired.
- Phase 4 can introduce `v2` controllers without touching `v1` paths — old curls and integration tests keep working through the transition.
- Breaking-change story: any change that drops a field from `QaResponseDto` or tightens a DTO constraint requires a new version, not a path edit.
- Future Phase 6 (queue-based ingestion) will likely add a `POST /api/v1/ingest` admin endpoint; the same module pattern (`IngestionModule` already exists, gain a controller) applies, with admin-only auth bolted on top (not in scope here).
- Tests for new endpoints follow the same two-layer pattern: controller unit test with the service mocked, DTO unit test with `plainToInstance + validate`. No e2e harness needed until Phase 2 establishes one.

---

## Phase 1.7 hardening notes (post-ship) — 2026-05-21

Three commits applied after Phase 1.7 closed (`2068adc..8d60430`). The DX character of this pass contrasts intentionally with the Phase 1.5 and 1.6 hardening passes, which were production-safety-first (correlation IDs, timeout enforcement, prompt strengthening). Phase 1.7's hardening surface lives entirely above the service: OpenAPI metadata richness, an explicit error-response schema, two production-grade defaults at the HTTP server boundary (body-size limit, dev CORS), and the project's first HTTP-level integration tests.

### DTO-level OpenAPI enrichment

`AskQuestionDto`, `QaResponseDto`, `QaSourceDto` all carry richer `@ApiProperty` descriptions covering embedding model + retrieval scope, score formula (`1 − L²/2`), excerpt truncation rule, and the metadata-as-opaque-dict caveat. A new `ValidationErrorResponseDto` documents the 400 response envelope. The 400 `@ApiResponse` on `QaController.ask()` now references it via `type:`, so the OpenAPI document includes the validation-error schema explicitly.

`ValidationErrorResponseDto` is intentionally a mirror of the NestJS-default `{ statusCode, message[], error }` envelope — *not* RFC 7807 — because RFC 7807 migration would be a wire-format breaking change. That migration is Phase 1.7.5 work; the DTO will be replaced wholesale at that point, not amended.

### Three named Swagger examples on `@ApiBody`

`philosophy` (default topK), `techQuestion` (topK=3), `multiPerspective` (default topK) cover the three common request shapes a frontend developer would prototype. Examples are pure metadata; runtime behaviour is unchanged.

### HTTP body-size limit — 10 KB

The plan's literal pattern was:

```ts
app.use(json({ limit: '10kb' }));
app.use(urlencoded({ extended: true, limit: '10kb' }));
```

after `NestFactory.create()`. Empirical Express test (`json({ limit: '10kb' })` registered before vs after a router): **only the BEFORE form enforces the limit**. NestJS's `registerParserMiddleware` (called inside `init()` during `NestFactory.create()`) registers the default 100 KB parser ahead of the router; any subsequent `app.use(json())` lands behind the route stack and never parses bodies before route handlers. Even with `{ bodyParser: false }` the user's parser lands behind the router because `init()` also runs `registerRouter()` before returning.

The only reliable pattern: build a custom `express()` instance, pre-register the parsers on it, pass it via `new ExpressAdapter(...)` to `NestFactory.create(..., { bodyParser: false })`. NestJS then mounts its router on the already-parser-configured Express app, parsers run first, body-size limit is enforced. This is the pattern shipped in `main.ts`.

10 KB rationale: a 1000-char `question` plus a 50-or-so-char `topK` field produces a ~1–2 KB JSON envelope; 10 KB is generous headroom for malformed / escape-heavy inputs (e.g. heavily-escaped Unicode sequences) without being permissive. Configurable env var (`HTTP_BODY_LIMIT`) is Phase 1.7.5 work.

### Dev-only CORS

`NODE_ENV !== 'production'` gates the entire CORS block. Origins limited to the three common frontend dev-server ports (Vite 5173, Next.js / CRA 3000, Angular 4200). Methods `GET` + `POST`, allowed headers `Content-Type` only. Production CORS — real frontend origin allow-list, credentials, preflight max-age — stays deferred to Phase 1.7.5 alongside the rest of the security pack.

This is dev DX, not a security boundary. Without it, a Vite-served local frontend cannot fetch this API; with it, the developer is unblocked without reading CORS docs. In production (`NODE_ENV=production`) the controller is unreachable from browsers unless / until Phase 1.7.5 lands the production allow-list — matching the planned 1.7.5 surface.

### First HTTP integration test

`qa.controller.integration.spec.ts` exercises the wire layer above `QaChainService` via supertest. Six tests: happy-path 200, three validation 400s, Swagger HTML, OpenAPI JSON schema presence. The bootstrap mirrors `main.ts` faithfully (custom ExpressAdapter + 10 KB body limit + ValidationPipe + URI versioning + AllExceptionsFilter + Swagger setup) so toggling `describe.skip` → `describe` tests the same wire production uses.

Skip-by-default discipline mirrors the Phase 1.5 / 1.6 integration specs: tests require live Chroma + Gemini, are too heavy for CI without environment provisioning, and the unit tests (`qa.controller.spec.ts` + `ask-question.dto.spec.ts`) cover the controller-mocked path and DTO validation at the granularity CI needs.

The Phase 1.6 integration spec validates the service pipeline; this new one validates only the HTTP boundary above it.

### Confirmed out of scope (remains deferred)

The following remain Phase 1.7.5 or later, not addressed in this pass:

- Request logging interceptor (correlation ID, request ID echo, structured request/response logs)
- Health check enrichment (Chroma readiness, Gemini liveness)
- Production CORS allow-list + credentials handling
- helmet, ThrottlerGuard, rate limiting
- RFC 7807 problem-details error envelope
- Streaming response support (`chain.stream()` over SSE)
- Observability hooks (OpenTelemetry, Prometheus)
- Response caching, retry policy, token-usage accounting
- Response post-processing / citation enrichment (Phase 1.7.5 / Phase 2)
- Question preprocessing — HyDE, query expansion (Phase 4)
- Env-configurable body-size limit
