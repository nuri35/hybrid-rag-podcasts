/**
 * Phase 1.6 Sprint Prompt-Security — pattern tables for the Layer 1
 * input sanitizer.
 *
 * High-confidence injection patterns trigger a hard reject (400);
 * medium-confidence patterns flag the question for downstream logging
 * but allow the request to proceed (Layer 2 prompt hardening + Layer
 * 3 output validation provide the rest of the defense).
 *
 * Rationale for the partition:
 *   - hard: phrases that have no legitimate use in a podcast Q&A
 *     ("ignore previous instructions", "reveal your prompt"). Zero
 *     false-positive risk for benign questions about Lex's content.
 *   - soft: phrases that could be a legitimate question OR a coaxing
 *     injection ("you are now", "pretend to be"). Rejecting them
 *     outright would hurt UX; flagging gives operator visibility
 *     without blocking the user.
 *
 * Add new patterns at the END so existing IDs stay stable for log
 * aggregation.
 */

export const HARD_REJECT_PATTERNS: ReadonlyArray<{ id: string; regex: RegExp }> = [
  { id: 'ignore_previous', regex: /\bignore\s+(all\s+)?(previous|prior|above)\s+instructions?\b/i },
  { id: 'disregard_system', regex: /\bdisregard\s+(the\s+)?(system|previous|above)\b/i },
  {
    id: 'forget_instructions',
    regex: /\bforget\s+(all\s+)?(your\s+)?(previous\s+)?instructions?\b/i,
  },
  { id: 'role_marker_system', regex: /^\s*system\s*:/im },
  { id: 'role_marker_assistant', regex: /^\s*assistant\s*:/im },
  {
    id: 'reveal_prompt',
    regex: /\b(reveal|show|repeat|output|print)\s+(your\s+)?(system\s+)?(prompt|instructions?)\b/i,
  },
  { id: 'admin_mode', regex: /\b(admin|developer|debug|root|jailbreak)\s+mode\b/i },
  { id: 'new_instructions', regex: /\b(new|updated?|revised)\s+instructions?\s*:/i },
  { id: 'end_of_context', regex: /---\s*end\s+of\s+(context|prompt|system)\s*---/i },
];

export const SOFT_FLAG_PATTERNS: ReadonlyArray<{ id: string; regex: RegExp }> = [
  {
    id: 'embedded_brackets_instruction',
    regex: /\[(?:at\s+the\s+end|also\s+output|additionally|secretly)\b[^\]]{0,200}\]/i,
  },
  { id: 'markdown_code_fence', regex: /```\s*(system|instruction|prompt)/i },
  { id: 'you_are_now', regex: /\byou\s+are\s+(now|from\s+now\s+on)\b/i },
  {
    id: 'pretend_roleplay',
    regex: /\b(pretend|roleplay|act\s+as|simulate)\s+(to\s+be\s+|that\s+you\s+are\s+)?/i,
  },
];

/**
 * Unicode classes stripped silently from input. The danger isn't the
 * characters themselves (most are invisible); it's that they let an
 * attacker hide instructions inside what LOOKS like benign text in the
 * browser, while the LLM sees the embedded payload.
 *
 * Each entry uses explicit \uXXXX escapes so the source file stays
 * pure ASCII — copy-paste-safe across editors and reviewers.
 *
 * The ASCII control-char range excludes \n (0x0A), \r (0x0D), and
 * \t (0x09) — those are legitimate whitespace.
 */
// Built via `new RegExp(...)` so the source file stays pure ASCII —
// regex literals containing zero-width / bidi chars look like normal
// brackets to readers and can be silently broken by editors. The
// escape strings are unambiguous and copy-paste safe.
export const UNICODE_STRIP_RANGES: ReadonlyArray<RegExp> = [
  new RegExp('[\\u200B-\\u200F]', 'g'), // zero-width spaces, RTL/LTR marks
  new RegExp('[\\u202A-\\u202E]', 'g'), // bidi overrides
  new RegExp('[\\u2060-\\u2064]', 'g'), // word joiner, invisible operators
  new RegExp('[\\uFEFF]', 'g'), // BOM / zero-width no-break space
  // eslint-disable-next-line no-control-regex
  /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, // ASCII control chars except \n, \r, \t
];

export const MAX_QUESTION_LENGTH = 1000;
