/**
 * Constants for Reciprocal Rank Fusion (Phase 4.3).
 *
 * These are ALGORITHM constants, not deployment config — deliberately NOT env
 * vars. Changing them changes ranking behaviour and must be backed by
 * evaluation evidence (4.5), not a deployment knob.
 */

/**
 * RRF damping constant `k` in `1 / (k + rank)`. 60 is the standard value from
 * the original RRF paper (Cormack, Clarke & Büttcher, SIGIR 2009). A larger `k`
 * flattens the contribution curve (rank position matters less); a smaller `k`
 * sharpens it (top ranks dominate). **Do not tune without eval evidence.**
 */
export const RRF_K = 60;

/**
 * Default number of fused chunks returned (what the LLM receives downstream).
 * Input list sizes are the caller's concern — 4.4 passes top-10 from each
 * retriever so dual-list agreement can surface chunks that sit mid-list in both.
 */
export const FUSION_OUTPUT_TOP_K = 5;
