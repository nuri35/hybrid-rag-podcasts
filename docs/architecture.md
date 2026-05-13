# Architecture — hybrid-rag-podcasts

This document is the technical companion to CLAUDE.md. CLAUDE.md captures the **decisions**; this file captures the **diagrams** that make those decisions easier to reason about.

---

## High-level system view

```mermaid
flowchart LR
    Client[Client / curl / Postman]
    Nest[NestJS App<br/>single service]
    Chroma[(Chroma<br/>vector store)]
    Neo4j[(Neo4j<br/>entity graph)]
    OpenAI[OpenAI API<br/>embeddings + chat]

    Client -->|POST /api/v1/questions| Nest
    Nest -->|similarity search<br/>+ metadata filter| Chroma
    Nest -.->|Cypher queries<br/>Phase 3+| Neo4j
    Nest -->|embed query<br/>generate answer| OpenAI
    Nest -->|JSON answer<br/>+ sources| Client

    style Neo4j stroke-dasharray: 5 5
```

The Neo4j path is dashed because it is not in Phase 1. Vector retrieval is the only active path until Phase 3.

---

## Module dependency graph

```mermaid
flowchart TD
    AppModule

    AppModule --> ConfigModule
    AppModule --> HealthModule
    AppModule --> IngestionModule
    AppModule --> RagModule
    AppModule --> QuestionsModule

    IngestionModule --> ChromaRepository
    IngestionModule --> Neo4jRepository
    IngestionModule --> ConfigModule

    RagModule --> ChromaRepository
    RagModule --> Neo4jRepository
    RagModule --> ConfigModule

    QuestionsModule --> RagModule

    ChromaRepository[Common/<br/>ChromaRepository]
    Neo4jRepository[Common/<br/>Neo4jRepository]

    style Neo4jRepository stroke-dasharray: 5 5
```

`QuestionsModule` is the only module exposing HTTP endpoints. `IngestionModule` exposes CLI commands. `RagModule` is purely internal — consumed by `QuestionsModule`.

---

## Ingestion flow (Phase 1 — vector only)

```mermaid
sequenceDiagram
    participant CLI as CLI<br/>(nest-commander)
    participant Pipe as IngestionPipelineService
    participant Loader as CsvLoaderService
    participant Chunker as ChunkerService
    participant Embed as EmbedderService
    participant Repo as ChromaRepository

    CLI->>Pipe: run({ csv, reset })
    opt reset flag
        Pipe->>Repo: resetCollection()
    end
    Pipe->>Loader: load(csv)
    Loader-->>Pipe: Document[]
    Pipe->>Chunker: split(documents, 800, 100)
    Chunker-->>Pipe: chunks[] (metadata preserved)
    Pipe->>Embed: embedBatch(chunks)
    loop batched
        Embed->>Embed: OpenAI embeddings (batched + retry)
    end
    Embed-->>Pipe: vectors[]
    Pipe->>Repo: addDocuments(chunks, vectors)
    Pipe-->>CLI: summary (rows, chunks, tokens, duration, cost)
```

Ingestion is one-shot. Each chunk has a deterministic ID (`{episode_id}_chunk_{idx}`) so re-running without `--reset` is a no-op for unchanged data.

---

## Ingestion flow (Phase 3+ — vector + graph)

```mermaid
sequenceDiagram
    participant CLI
    participant Pipe as IngestionPipelineService
    participant Loader
    participant Chunker
    participant Embed
    participant ChromaRepo
    participant DetExt as DeterministicExtractorService
    participant LlmExt as LlmExtractorService
    participant Neo4jRepo

    CLI->>Pipe: run({ csv, reset })
    Pipe->>Loader: load(csv)
    Loader-->>Pipe: Document[]

    par Vector path
        Pipe->>Chunker: split
        Chunker-->>Pipe: chunks
        Pipe->>Embed: embedBatch
        Embed-->>Pipe: vectors
        Pipe->>ChromaRepo: addDocuments
    and Graph path — deterministic
        Pipe->>DetExt: extractFromColumns(documents)
        DetExt-->>Pipe: nodes + edges (Episode, Person, Company)
        Pipe->>Neo4jRepo: writeNodes + writeEdges
    and Graph path — LLM-based
        Pipe->>LlmExt: extractFromTranscripts(chunks)
        LlmExt-->>Pipe: nodes + edges (WORKED_AT, COLLABORATED_WITH, MENTIONED_IN)
        Pipe->>Neo4jRepo: mergeNodes + writeEdges
    end

    Pipe-->>CLI: summary
```

Three parallel paths write to two stores. Entity resolution by `name` ensures the deterministic and LLM-based paths converge on the same Person nodes.

---

## Query flow — Phase 1 (vector only)

```mermaid
sequenceDiagram
    participant Client
    participant Ctrl as QuestionsController
    participant QS as QuestionsService
    participant Chain as QaChainService
    participant Retriever as VectorRetrieverService
    participant ChromaRepo
    participant LLM as ChatOpenAI

    Client->>Ctrl: POST /api/v1/questions { question }
    Ctrl->>QS: answer(question)
    QS->>Chain: build().invoke({ question })
    Chain->>Retriever: invoke({ question })
    Retriever->>ChromaRepo: similaritySearch(query, k=5)
    ChromaRepo-->>Retriever: Document[]
    Retriever-->>Chain: Document[]
    Chain->>Chain: formatContext(docs)
    Chain->>LLM: prompt(context, question)
    LLM-->>Chain: AIMessage
    Chain->>Chain: outputParser(message)
    Chain-->>QS: { answer, sources }
    QS-->>Ctrl: QuestionResponseDto
    Ctrl-->>Client: 200 { answer, sources, retrievalPath: "vector" }
```

Single retrieval branch. LCEL chain is composed once at service construction; `.invoke()` is the only per-request call.

---

## Query flow — Phase 4 (hybrid)

```mermaid
sequenceDiagram
    participant Client
    participant Chain as QaChainService
    participant VR as VectorRetriever
    participant GR as GraphRetriever
    participant Merge as MergeStrategy
    participant LLM

    Client->>Chain: invoke({ question })

    par Parallel retrieval
        Chain->>VR: invoke
        VR-->>Chain: Document[]
    and
        Chain->>GR: invoke
        GR-->>Chain: GraphResult
    end

    Chain->>Merge: combine(docs, graphResult)
    Merge-->>Chain: mergedContext
    Chain->>LLM: prompt(mergedContext, question)
    LLM-->>Chain: answer
    Chain-->>Client: { answer, sources, retrievalPath: "hybrid" }
```

`RunnableParallel` runs both branches concurrently. The `MergeStrategy` is a `RunnableLambda` deciding how to weave vector chunks and graph results into a single context string. Sequential variant (graph filters → vector searches inside subset) is a second `MergeStrategy` selected per query in Phase 5.

---

## Bridge between stores

```mermaid
flowchart LR
    subgraph Chroma
        Chunk[Chunk<br/>id: ep_001_chunk_3<br/>metadata.episode_id: ep_001<br/>metadata.guest_name: Sarah Chen]
    end

    subgraph Neo4j
        Episode[Episode<br/>episode_id: ep_001]
        Person[Person<br/>name: Sarah Chen]
        Company[Company<br/>name: Stanford]
        Episode -->|FEATURES_GUEST| Person
        Person -->|AFFILIATED_WITH| Company
    end

    Chunk -. shared identifier .-> Episode
    Chunk -. shared identifier .-> Person
```

Stores are linked by **shared identifier values**, not by foreign keys at the storage layer. Hybrid retrieval relies on these identifiers to filter Chroma based on Neo4j query results (e.g., "give me chunks where `guest_name` is in this list of names returned by Cypher").

---

## Phase progression overview

```mermaid
flowchart LR
    P1[Phase 1<br/>Vector + CLI + endpoint] --> P2[Phase 2<br/>Evaluation harness]
    P2 --> P3[Phase 3<br/>Graph layer]
    P3 --> P4[Phase 4<br/>Hybrid retrieval]
    P4 --> P5[Phase 5<br/>Query routing<br/>via tool use]
    P5 -.-> P6[Phase 6 (future)<br/>Queue-based ingestion]
```

Each phase ends with a shippable artifact. The dashed Phase 6 is opt-in based on portfolio strategy, not a hard dependency.