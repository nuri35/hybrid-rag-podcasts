---
name: langchain-js-lcel
description: Use when writing or modifying any LangChain.js chain, retriever, runnable, or LCEL composition in the hybrid-rag-podcasts project. Triggers on tasks involving RunnableSequence, RunnableParallel, RunnableLambda, RunnablePassthrough, the .pipe() operator, retriever factories, prompt templates, model invocation patterns, streaming, batching, or chain composition. Also use when debugging chain execution issues, designing new retriever pipelines, or refactoring imperative LLM code into LCEL. Do NOT use for NestJS module/service/DTO conventions — that is covered by the nestjs-rag-conventions skill.
---

# LangChain.js LCEL Patterns for hybrid-rag-podcasts

LCEL is the orchestration backbone. Every retrieval, prompting, and generation operation must be composed as a `Runnable`. Imperative chaining is forbidden in this project.

---

## Core principle: services return Runnables, not values

```typescript
// WRONG — imperative
async retrieve(question: string): Promise<Document[]> {
  return this.chromaRepo.similaritySearch(question);
}

// CORRECT — returns a Runnable factory
build(options: VectorRetrievalOptions): Runnable<{ question: string }, Document[]> {
  return RunnableSequence.from([
    new RunnableLambda({
      func: ({ question }) => this.chromaRepo.similaritySearch(question, options.k),
    }),
  ]);
}
```

### Why

Downstream code composes this retriever into bigger chains using `.pipe()` without breaking the LCEL contract. Streaming, retry, batching, and observability come for free. Imperative methods lose all of that.

---

## Composition primitives

### RunnableSequence — linear pipeline

```typescript
const chain = RunnableSequence.from([
  retriever, // input → Document[]
  formatContext, // Document[] → string
  prompt, // string → PromptValue
  model, // PromptValue → AIMessage
  outputParser, // AIMessage → string
]);
```

Each step's output type must match the next step's input type. TypeScript will catch mismatches if generics are declared properly.

### RunnableParallel — fan-out

```typescript
const parallel = RunnableParallel.from({
  vectorContext: vectorRetriever,
  graphContext: graphRetriever,
  question: new RunnablePassthrough(),
});
// Output shape:
// { vectorContext: Document[], graphContext: GraphResult, question: { question: string } }
```

Use when multiple branches need the same input AND outputs combine for the next step. This is the primary tool for hybrid retrieval (Phase 4).

### RunnableLambda — wrap a custom function

```typescript
const formatContext = new RunnableLambda({
  func: (docs: Document[]) =>
    docs.map((d) => `[${d.metadata.source}] ${d.pageContent}`).join('\n\n'),
});
```

Use for transformations that cannot be expressed by other primitives. Keep them small and pure.

### RunnablePassthrough — pass input through (with optional enrichment)

```typescript
RunnablePassthrough.assign({
  context: (input) => retriever.invoke(input.question),
});
// Output keeps original keys AND adds `context`
```

Use to enrich input without losing original fields. Useful when downstream prompts need both `question` and `context`.

---

## Standard QA chain pattern

This is the shape the `QaChainService.build()` should produce in Phase 1:

```typescript
const qaChain = RunnableSequence.from([
  RunnableParallel.from({
    context: RunnableSequence.from([
      ({ question }: { question: string }) => question,
      vectorRetriever,
      formatContext,
    ]),
    question: ({ question }: { question: string }) => question,
  }),
  prompt,
  model,
  new StringOutputParser(),
]);

await qaChain.invoke({ question: 'What did guests say about consciousness?' });
```

Read top to bottom: extract question → retrieve → format docs into a string → fill prompt → call LLM → parse to plain string.

---

## Hybrid pattern (Phase 4 preview)

```typescript
const hybridContext = RunnableParallel.from({
  vector: vectorRetriever,
  graph: graphRetriever,
});

const merge = new RunnableLambda({
  func: ({ vector, graph }) => mergeContexts(vector, graph),
});

const hybridChain = hybridContext.pipe(merge).pipe(prompt).pipe(model);
```

Two retrievers in parallel, results merged by a Lambda, then the standard prompt → model.

---

## Common pitfalls

- **Forgetting input/output type alignment.** Sequence steps must chain types. Declare generics: `Runnable<InputType, OutputType>`.
- **Calling `.invoke()` inside another Runnable's function.** Breaks streaming, retry, observability. Use composition (`.pipe()` or `RunnableParallel`) instead.
- **Hardcoding model or prompt config in the chain factory.** Inject via constructor; pull from `ConfigService`.
- **Storing chain state.** Chains must be stateless. If state is needed, use a state-aware pattern (LangGraph in Phase 5).
- **Mocking inside the chain for tests.** If you need to mock deep inside a chain, the chain is structured wrong. Mock at construction time instead.

---

## Streaming

LCEL supports streaming for free if every step is a Runnable.

```typescript
const stream = await chain.stream({ question });
for await (const chunk of stream) {
  // chunk is partial output, e.g. incremental token text
}
```

In NestJS controllers, return an `Observable` or use SSE for streaming responses. This is a Phase 5 concern, not Phase 1.

---

## Retry and fallback

Built into LCEL — use these, do not hand-roll retry logic:

```typescript
const robustChain = chain
  .withRetry({ stopAfterAttempt: 3, factor: 2 })
  .withFallbacks([fallbackChain]);
```

Use `withRetry` for transient failures (network, rate limits). Use `withFallbacks` for model fallback (e.g., gpt-4o-mini → gpt-3.5-turbo if the primary fails).

---

## Observability

Every Runnable invocation emits a trace. If LangSmith env vars are set, traces are auto-captured.

- Do NOT add `console.log` or manual logging inside chain steps.
- Rely on tracing + LangSmith for chain-level observability.
- Service-level logging (NestJS `Logger`) is fine OUTSIDE chain steps.

Env vars to enable LangSmith:

- `LANGCHAIN_TRACING_V2=true`
- `LANGCHAIN_API_KEY=<key>`
- `LANGCHAIN_PROJECT=hybrid-rag-podcasts`

---

## Testing chains

Mock the model and retriever at construction time, not inside the chain:

```typescript
const mockModel = new FakeChatModel({ responses: ['mocked answer'] });
const testChain = qaChainService.build({ model: mockModel });
expect(await testChain.invoke({ question: 'test' })).toBe('mocked answer');
```

If you find yourself mocking deep inside a chain, refactor — the chain composition is wrong.

For retriever tests, use `FakeRetriever` or mock the underlying repository, not the Runnable itself.

---

## Structured output with Zod

For LLM calls that need structured output (e.g., entity extraction in Phase 3):

```typescript
import { z } from 'zod';

const entitySchema = z.object({
  persons: z.array(z.object({ name: z.string(), role: z.string().optional() })),
  companies: z.array(z.object({ name: z.string() })),
  relationships: z.array(
    z.object({
      source: z.string(),
      type: z.enum(['WORKED_AT', 'COLLABORATED_WITH', 'MENTIONED']),
      target: z.string(),
    }),
  ),
});

const structuredModel = model.withStructuredOutput(entitySchema);
const result = await structuredModel.invoke(transcriptChunk);
// result is strongly typed
```

This is the project's substitute for `LLMGraphTransformer` (Python-only).

---

## Checklist when writing a new chain

- [ ] Service method named `build*` and returns a `Runnable<Input, Output>` with explicit generics
- [ ] Configuration injected via constructor (`ConfigService`, repositories)
- [ ] No `.invoke()` calls inside the chain itself
- [ ] All side effects encapsulated in Runnables, not bare functions
- [ ] Streaming-friendly (every step is composable)
- [ ] Mockable via constructor injection
- [ ] No `any` types in the generic signatures
