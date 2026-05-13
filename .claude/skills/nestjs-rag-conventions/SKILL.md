---
name: nestjs-rag-conventions
description: Use when creating, modifying, or reviewing NestJS modules, controllers, services, DTOs, or any backend TypeScript file in the hybrid-rag-podcasts project. Triggers on tasks involving NestJS scaffolding, module structure decisions, naming conventions, dependency injection patterns, exception handling, configuration access via ConfigService, repository pattern implementation, or CLI commands via nest-commander. Also use when reviewing code for SOLID violations or NestJS anti-patterns. Do NOT use for pure LangChain composition logic — that is covered by the langchain-js-lcel skill.
---

# NestJS Conventions for hybrid-rag-podcasts

These rules are enforced project-wide. Deviations require an ADR in `docs/ADR/`.

## Module organization

One module per feature concern. Each module exposes:

- `<feature>.module.ts` — declaration with explicit `imports`, `providers`, `exports`
- `<feature>.controller.ts` — only when the module exposes HTTP endpoints
- `<feature>.service.ts` — primary business logic entry point for the module
- `services/` — additional services if the module has more than one
- `dto/` — input and output DTOs with class-validator decorators
- `commands/` — nest-commander CLI commands (e.g., `IngestionCommand`)

### Never

- Put services in `controllers/`
- Mix two unrelated concerns in one module (e.g., ingestion + retrieval)
- Export internal services unless another module truly needs them (encapsulation default)

---

## Service patterns

Services are stateless and injectable. Three categories used in this project:

1. **Domain services** — business logic
   Example: `IngestionPipelineService` orchestrates load → chunk → embed → write.

2. **Wrapper / Repository services** — adapter over an external library or client
   Example: `ChromaRepository` wraps `ChromaClient` so domain code never touches the raw client.

3. **Factory services** — return Runnables for LCEL composition
   Example: `VectorRetrieverService.build()` returns a `Runnable<{ question }, Document[]>`.

### Naming

- Files: kebab-case (`vector-retriever.service.ts`)
- Classes: PascalCase (`VectorRetrieverService`)
- Methods: verb-first camelCase (`buildRetriever`, `loadDocuments`)
- Avoid generic names (`Manager`, `Handler`, `Helper`). Be specific.

---

## Controller patterns

Controllers are thin. Maximum responsibility:

1. Receive the HTTP request
2. Validate the DTO (class-validator runs via a global `ValidationPipe`)
3. Call **one** service method
4. Return the response (let interceptors transform if needed)

### Forbidden in controllers

- Business logic
- Direct LangChain or chain invocation
- Direct DB access (no `ChromaClient` calls in controllers)
- Multiple service calls chained together — that orchestration belongs in a service

### Canonical example

```typescript
@Controller('questions')
export class QuestionsController {
  constructor(private readonly questionsService: QuestionsService) {}

  @Post()
  async ask(@Body() dto: AskQuestionDto): Promise<QuestionResponseDto> {
    return this.questionsService.answer(dto.question);
  }
}
```

---

## DTO conventions

Every DTO uses class-validator. No exceptions.

```typescript
export class AskQuestionDto {
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  question!: string;
}
```

### Rules

- Use `!` for required fields (TypeScript strict mode)
- Input DTOs and output DTOs are separate classes (`AskQuestionDto` ≠ `QuestionResponseDto`)
- Place each DTO in its own file under `dto/`
- Use class-transformer (`@Type`) for nested objects
- Output DTOs include only what the client needs; never leak internal fields

---

## Configuration access

NEVER read `process.env` outside `ConfigModule`. Use `ConfigService`:

```typescript
// CORRECT
constructor(private readonly config: ConfigService) {}
const model = this.config.get<string>('OPENAI_MODEL');

// WRONG
const model = process.env.OPENAI_MODEL;
```

The env schema is validated at boot (Zod or Joi). Missing required env = app fails fast at startup.

Required env for this project (minimum):

- `OPENAI_API_KEY`
- `OPENAI_MODEL` (default `gpt-4o-mini`)
- `EMBEDDING_MODEL` (default `text-embedding-3-small`)
- `CHROMA_PATH` (local persistence directory)
- `CHROMA_COLLECTION` (default `podcasts`)

---

## Exception handling

Custom domain exceptions. Map to HTTP via a global exception filter.

```typescript
// common/exceptions/retrieval-failed.exception.ts
export class RetrievalFailedException extends Error {
  constructor(public readonly reason: string) {
    super(`Retrieval failed: ${reason}`);
  }
}

// common/filters/all-exceptions.filter.ts maps:
//   RetrievalFailedException → 503 Service Unavailable
//   ValidationError          → 400 Bad Request
//   default                  → 500 Internal Server Error
```

### Never

- Throw raw `Error`
- Throw `HttpException` directly from services (services know the domain, not HTTP)
- Catch and swallow exceptions silently — always log

---

## Repository pattern

External clients (Chroma, Neo4j, OpenAI) are wrapped in repository services.

```typescript
@Injectable()
export class ChromaRepository {
  // Encapsulates ChromaClient
  async add(documents: Document[]): Promise<void> {
    /* ... */
  }
  async similaritySearch(
    query: string,
    k: number,
    filter?: object,
  ): Promise<Document[]> {
    /* ... */
  }
  async deleteCollection(name: string): Promise<void> {
    /* ... */
  }
}
```

Domain services depend on `ChromaRepository`, never on `ChromaClient` directly. This makes tests trivial — mock the repository.

---

## CLI commands (nest-commander)

CLI lives inside the same NestJS app and reuses modules via DI.

```typescript
@Command({ name: 'ingest', description: 'Load CSV into vector store' })
export class IngestCommand extends CommandRunner {
  constructor(private readonly pipeline: IngestionPipelineService) {
    super();
  }

  async run(_passedParams: string[], options: IngestOptions): Promise<void> {
    await this.pipeline.run(options);
  }

  @Option({ flags: '-c, --csv <path>', description: 'CSV file path' })
  parseCsv(val: string): string {
    return val;
  }

  @Option({
    flags: '-r, --reset',
    description: 'Reset collection before ingest',
  })
  parseReset(): boolean {
    return true;
  }
}
```

CLI entry point is `src/cli.ts`, separate from `src/main.ts` (HTTP app).

---

## Forbidden patterns

- Service-locator pattern (manually pulling instances from the DI container)
- Circular module dependencies
- Long-lived stateful modules (use proper lifecycle hooks if state is needed)
- `as any` type casts (use `unknown` and narrow with type guards)
- Imperative LLM/chain invocation in services (must be Runnable factories — see langchain-js-lcel skill)
- Hardcoded paths, model names, or magic values anywhere in business code

---

## Scaffolding checklist

When creating a new feature module:

1. Create folder `src/modules/<feature>/`
2. Create `<feature>.module.ts` declaring providers and imports
3. Add the module to `app.module.ts` imports
4. Create service(s) and DTO(s) as needed
5. Add controller ONLY if the module exposes HTTP endpoints
6. Wire repositories from `common/repositories/` via DI
7. Add CLI command in `commands/` if relevant
8. Update CLAUDE.md if a new convention emerges from this work
