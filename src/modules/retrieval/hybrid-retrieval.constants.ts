/**
 * Constants for hybrid retrieval (Phase 4.4).
 *
 * Algorithm constants, NOT env vars — changing them changes retrieval behaviour
 * and must be backed by 4.5 evaluation evidence, not a deployment knob.
 */

/**
 * How many results to request from EACH source (vector + keyword) before
 * fusion. 10 is wide enough for dual-list agreement to surface a chunk that
 * sits mid-list in both retrievers (the q014 rescue), while fusion trims the
 * union down to `FUSION_OUTPUT_TOP_K` for the LLM.
 */
export const SOURCE_TOP_K = 10;
