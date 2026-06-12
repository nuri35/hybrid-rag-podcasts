/**
 * Constants for the Elasticsearch keyword-retrieval layer (Phase 4).
 *
 * The cluster URL is env-driven (`ELASTICSEARCH_URL` via ConfigService) — these
 * are the values that are fixed by the index design, not the deployment, so
 * they live as code constants rather than env vars.
 */

/** Index created by `scripts/elasticsearch/create-index.py` (sub-phase 4.1). */
export const INDEX_NAME = 'podcast_chunks';

/**
 * Default number of hits per search. Symmetric with the vector side's notion of
 * top-K; the eventual RRF fusion (4.3) pulls a list from each retriever.
 */
export const DEFAULT_TOP_K = 10;

/**
 * Per-call request timeout for `search()`. A keyword query against a local
 * single-node cluster is ~10-50 ms; 3 s is a generous ceiling that converts a
 * stalled/partitioned cluster into a fast failure → graceful degradation to
 * vector-only, never a hung request.
 */
export const SEARCH_TIMEOUT_MS = 3000;

/**
 * Shorter timeout for the cluster-health probe — health must answer fast so it
 * never becomes the slow path in the aggregate `/health` check.
 */
export const HEALTH_TIMEOUT_MS = 2000;

/**
 * DI token for the singleton `@elastic/elasticsearch` `Client`. Provided by a
 * factory in `ElasticsearchModule`; injected into `ElasticsearchService`. The
 * token indirection is what lets unit tests inject a mock client.
 */
export const ELASTICSEARCH_CLIENT = 'ELASTICSEARCH_CLIENT';
