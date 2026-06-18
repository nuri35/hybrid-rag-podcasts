# Phase 5.1 Plan — Metadata Aggregation Foundation (`MetadataQueryService`)

> Sign-off gate. This is the deliverable required **before any code** (Part 4 of the
> Phase 5 brief). It records the confirmed architecture, the closed set of
> aggregation types with their exact Elasticsearch mapping, the
> `MetadataQueryService` public interface, and the test plan. Implementation starts
> only after you approve this document.

**Goal of 5.1.** Build a *deterministic, exact* aggregation engine that turns
"how many / how many distinct / which / what range / group by" questions into exact
Elasticsearch aggregations, and prove it in isolation — before any tool wrapper
(5.2) or LLM routing (5.3). The model will only ever orchestrate a tool that already
returns the right answer.

---

## 1. Research findings (live `podcast_chunks`, 53,427 docs / 319 episodes)

Measured against the running index — not assumed.

**Aggregatable fields:**

| Field | ES type | Populated | Usable for |
|---|---|---|---|
| `episode_id` | keyword | 100% (319 distinct) | count, count_distinct, filter, group_by |
| `guest_name` | keyword | 100% (281 distinct) | count_distinct, filter, group_by |
| `title` | keyword | 100% (317 distinct¹) | count_distinct, filter, group_by |
| `duration_min` | integer | 100% (range 33–315) | min, max, avg |
| `total_chunks` | integer | 100% | min, max, avg (per-episode) |
| `date` | keyword | **0% — empty in all docs** | ❌ excluded (empty *and* `min/max` 400s on keyword) |
| `guest_affiliation` | keyword | **0% — empty** | ❌ excluded |
| `guest_role` | keyword | **0% — empty** | ❌ excluded |

¹ 317 distinct titles for 319 episodes — 2 collision-disambiguated episodes share a title.

**The decisive finding — grain.** The index is **chunk-grained** (1 doc per chunk).
Raw `doc_count` aggregations are therefore biased by chunk count per episode.
"Which guest appears most often?" returns *different answers* by grain:

- by **chunk** count: Michael Malice (985), Stephen Wolfram (948), Andrew Huberman (731)
- by **episode** count: Eric Weinstein (4), Manolis Kellis (4), Michael Malice (4)

The episode-grained numbers are the correct ones for metadata questions, and
`avg(duration_min)` over chunks is chunk-count-weighted (wrong). This is why we are
building a dedicated episode-grained index rather than aggregating over chunks.

---

## 2. Confirmed architecture decisions (Step 0)

1. **Episode-grained index — `podcast_episodes` (319 docs, 1 per episode).** A new,
   small, derived/rebuildable index for aggregations. Counts, `group_by`, and `avg`
   are then *structurally* correct (`doc_count` = episode count), with no
   chunk-count bias and no cardinality gymnastics. Retrieval (`search_content`) is
   untouched and continues to use `podcast_chunks`. Same "derived from Chroma /
   rebuildable, dev-time Python sync" pattern as the chunk index — Chroma stays the
   source of truth.

2. **Separate `metadata` NestJS module.** New `MetadataModule` + `MetadataQueryService`,
   sharing the existing singleton ES client via DI — **no new client** (constraint).
   Mechanism: `ElasticsearchModule` adds `ELASTICSEARCH_CLIENT` to its `exports`;
   `MetadataModule` imports `ElasticsearchModule` and injects the
   `ELASTICSEARCH_CLIENT` token (mirrors how `ElasticsearchService` injects it).
   SRP: keyword *search* and structured *aggregation* are different responsibilities.

3. **Empty fields scoped out for 5.1.** `date`, `guest_affiliation`, `guest_role`
   are empty across all 53,427 docs → not supported. The "date range" aggregation is
   deferred (would need re-ingestion with populated, `date`-typed values — a Phase 1
   ingestion change, out of scope). Documented as a data limitation.

**Exactness contract (important design choice).** Unlike `ElasticsearchService.search()`,
which *fails open* to `[]` (a missing keyword hit is tolerable), metadata answers are
**exactness-critical** — a silently wrong/empty count would let the LLM state a false
fact. So `MetadataQueryService` **fails loud**: any ES error or malformed response
throws a custom exception; it never returns a guessed or degraded number.

---

## 3. Closed set of supported aggregation types → ES query mapping

All aggregations run against **`podcast_episodes`**. Field categories: **keyword**
= {`episode_id`, `guest_name`, `title`}; **numeric** = {`duration_min`, `total_chunks`}.

| Type | Meaning | Allowed field | ES query (on `podcast_episodes`) |
|---|---|---|---|
| `count` | # episodes (optionally filtered) | (optional keyword filter) | `_count` / `{size:0}` with `bool.filter:[{term:{field:value}}]` → `hits.total` |
| `count_distinct` | # distinct values of a field | keyword | `{size:0, aggs:{d:{cardinality:{field}}}}` → `aggregations.d.value` |
| `filter` | episodes where `field == value` | keyword | `{query:{bool:{filter:[{term:{field:value}}]}}, size:limit}` → count + episode refs |
| `min` / `max` | numeric extreme (+ which episode) | numeric | `{size:0, aggs:{m:{min|max:{field}}}}` (+ `top_hits` sort for the episode) |
| `avg` | numeric average | numeric | `{size:0, aggs:{a:{avg:{field}}}}` → `aggregations.a.value` |
| `group_by` | episode count per value, top-N | keyword | `{size:0, aggs:{g:{terms:{field, size}}}}` → buckets `{key, doc_count}` (=episodes) |

Notes:
- `avg` added beyond the brief's named set (count/count_distinct/filter/max/min/group_by)
  because the episode grain makes it correct and "average episode length" is a natural
  metadata question. Flag for your confirmation; trivial to drop if unwanted.
- **Out-of-scope boundary (flagged):** *content-conditioned* counts like "how many
  episodes **mention** X?" (Part 2 example) are NOT pure structured-metadata — they need
  a **text filter** and so must run on the **chunk** index as
  `cardinality(episode_id)` within a `match` query. That bridges metadata + content
  and is **deferred** (recommend adding as a follow-up capability in 5.2+, or a future
  sub-phase). 5.1's closed set is *structured fields only*.

---

## 4. `MetadataQueryService` public interface

Single typed entry point (maps 1:1 to the future `query_metadata` tool schema in 5.2),
internally dispatched to one private builder per type. Discriminated union on `type`
enforces field-category correctness at compile time; runtime validation re-checks for
the tool's untyped input.

```ts
// metadata.types.ts  (closed allow-lists — no magic strings)
export enum MetadataAggregation {
  COUNT = 'count',
  COUNT_DISTINCT = 'count_distinct',
  FILTER = 'filter',
  MIN = 'min',
  MAX = 'max',
  AVG = 'avg',
  GROUP_BY = 'group_by',
}
export type KeywordField = 'episode_id' | 'guest_name' | 'title';
export type NumericField = 'duration_min' | 'total_chunks';

export interface EpisodeRef { episodeId: string; title: string; guestName: string; }

export type MetadataQueryRequest =
  | { type: MetadataAggregation.COUNT; filter?: { field: KeywordField; value: string } }
  | { type: MetadataAggregation.COUNT_DISTINCT; field: KeywordField }
  | { type: MetadataAggregation.FILTER; field: KeywordField; value: string; limit?: number }
  | { type: MetadataAggregation.MIN | MetadataAggregation.MAX; field: NumericField }
  | { type: MetadataAggregation.AVG; field: NumericField }
  | { type: MetadataAggregation.GROUP_BY; field: KeywordField; size?: number };

export type MetadataQueryResult =
  | { type: 'count'; value: number; filter?: { field: string; value: string } }
  | { type: 'count_distinct'; field: string; value: number }
  | { type: 'filter'; field: string; value: string; count: number; episodes: EpisodeRef[] }
  | { type: 'min' | 'max'; field: string; value: number | null; episode: EpisodeRef | null }
  | { type: 'avg'; field: string; value: number | null }
  | { type: 'group_by'; field: string; buckets: { key: string; count: number }[] };
```

```ts
// metadata-query.service.ts
@Injectable()
export class MetadataQueryService {
  constructor(@Inject(ELASTICSEARCH_CLIENT) private readonly client: Client) {}

  /** Single entry point. Validates, builds the ES aggregation, maps the typed result.
   *  Throws InvalidMetadataQueryException (400) on bad type/field/value;
   *  MetadataQueryFailedException (500) on ES error / malformed response (fail-loud). */
  async aggregate(request: MetadataQueryRequest): Promise<MetadataQueryResult>;
}
```

- **Validation** (`InvalidMetadataQueryException`, extends `BadRequestException`): unknown
  `type`; field not in the keyword/numeric allow-list for that type (e.g. `avg` on a
  keyword field, `group_by` on a numeric field, any excluded/empty field); empty filter value.
- **Constants** (`metadata.constants.ts`): `METADATA_INDEX = 'podcast_episodes'`,
  the keyword/numeric field allow-lists, `DEFAULT_FILTER_LIMIT` (e.g. 50),
  `DEFAULT_GROUP_BY_SIZE` (e.g. 10), `MAX_*` caps. No magic strings/numbers.
- **Module structure** (per CLAUDE.md):
  ```
  src/modules/metadata/
    metadata-query.service.ts
    metadata.types.ts
    metadata.constants.ts
    metadata.module.ts            # imports ElasticsearchModule; provides+exports MetadataQueryService
    exceptions/
      invalid-metadata-query.exception.ts
      metadata-query-failed.exception.ts
  ```

---

## 5. Episode index — build tooling (prerequisite, dev-time Python)

Mirrors `scripts/elasticsearch/` (idempotent, `--force`, `ELASTICSEARCH_URL`, fail-with-guidance):

- `scripts/elasticsearch/mappings/podcast_episodes.json` — keyword `episode_id`/`title`/
  `guest_name`, integer `duration_min`/`total_chunks`. No `text` analyzer, no empty fields.
- `scripts/elasticsearch/create-episode-index.py` — create from mapping (idempotent + `--force`).
- `scripts/elasticsearch/build-episode-index.py` — derive 1 doc/episode **from the existing
  `podcast_chunks` index** (a `terms(episode_id)` + `top_hits size:1` scan, or composite
  paginate; the metadata is constant per episode), bulk-index into `podcast_episodes`,
  verify count == 319. Idempotent (`episode_id` as `_id`). Chroma remains source of truth;
  this index is rebuildable.
- Update `scripts/elasticsearch/README.md` with the episode-index ops.

---

## 6. Test plan

**Unit (`metadata-query.service.spec.ts`, mock ES `Client` — no network):**
1. Query construction — for each of the 7 types, assert the exact ES body built
   (index, `size:0`/query, the right `terms`/`cardinality`/`min`/`max`/`avg`/`filter`).
2. Result mapping — given a canned ES response per type, assert the typed
   `MetadataQueryResult` (values, buckets `key→count`, episode refs, null-on-empty).
3. Validation — `InvalidMetadataQueryException` for: unknown type; `avg`/`min`/`max` on a
   keyword field; `count_distinct`/`group_by`/`filter` on a numeric field; field not in
   the allow-list (incl. the excluded empty fields `date`/`affiliation`/`role`); empty filter value.
4. Fail-loud — ES client throws → `MetadataQueryFailedException` (never a degraded result).
5. Default/cap handling — `limit`/`size` defaults applied and capped.

**Integration (`*.integration.spec.ts`, real `podcast_episodes`, skipped by default like
Phase 4's integration tests) — asserts against the REAL measured data:**
- `count` (no filter) → **319**
- `count_distinct guest_name` → **281**; `count_distinct title` → **317**
- `group_by guest_name` top buckets → **Eric Weinstein / Manolis Kellis / Michael Malice, 4 each**
- `max duration_min` → **315**; `min duration_min` → **33**
- `filter guest_name = "<a known guest>"` → expected episode count + refs
- `count` with filter `guest_name = "Michael Malice"` → **4**

Run the full backend suite after — zero regressions.

---

## 7. Out of scope for 5.1 (explicit)

- No tool definitions (5.2), no LLM routing (5.3), no agentic/serial loop — pure
  service-layer work, no LLM involvement.
- No change to the retrieval path (`search_content` / hybrid pipeline).
- `date` / `guest_affiliation` / `guest_role` aggregations (empty data).
- Content-conditioned counts ("how many episodes mention X") — needs a text filter on
  the chunk index; flagged in §3 as a deferred follow-up.

---

## 8. Open confirmations for you

1. **`avg` included** (beyond the brief's named set) — keep it? (Recommend yes; episode
   grain makes it correct, natural for "average episode length".)
2. **`total_chunks` as a numeric aggregatable field** — keep it (enables "longest episode
   by chunk count")? Or restrict numeric aggregations to `duration_min` only?
3. **"How many episodes mention X" deferral** — agree to defer the content-conditioned
   count to a later capability (it's additive, chunk-index-based), and keep 5.1 to pure
   structured-metadata facts?

On your sign-off (with answers to §8), I implement in this order: episode index tooling
(§5) → `MetadataModule` + `MetadataQueryService` (§4) → unit + integration tests (§6).
