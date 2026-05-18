import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../../common/config/env.schema';

// --- Regex constants (named so reviewers and future maintainers see intent at a glance) ---
// We use \uXXXX escapes rather than literal characters so the source file is lint-safe
// (no-irregular-whitespace) and the intent is explicit.

const NBSP = /\u00A0/g;
const SMART_DOUBLE_QUOTES = /[“”]/g;
const SMART_SINGLE_QUOTES = /[‘’]/g;
const REPEATED_SPACES = / {2,}/g;
const TRIPLE_PLUS_NEWLINES = /\n{3,}/g;
const REPEATED_BANG = /!{2,}/g;
const REPEATED_QUESTION = /\?{2,}/g;
const FOUR_PLUS_DOTS = /\.{4,}/g;
// Split on sentence terminator followed by whitespace, immediately followed by uppercase letter.
// Lookbehind preserves the terminator with the previous sentence.
const SENTENCE_SPLIT = /(?<=[.!?])\s+(?=[A-Z])/;
// Match the FIRST sentence-ending punctuation in a substring (used after intro anchor).
const FIRST_SENTENCE_TERMINATOR = /[.!?]/;

// --- Lex Fridman anchor phrases. Case-insensitive matching; declared as readonly tuples. ---

const LEX_INTRO_ANCHORS = [
  "And now, dear friends, here's",
  "And now, here's my conversation with",
  'Now, here is my conversation with',
  'And now, here is my conversation with',
] as const;

const LEX_OUTRO_ANCHORS = [
  'Thank you for listening to this conversation with',
  'Thanks for listening to this conversation with',
  'Thank you for listening, and',
  'Hope to see you next time',
] as const;

// Whitespace-and-case-insensitive normalization used for sentence comparison.
function normalizeForComparison(sentence: string): string {
  return sentence.trim().toLowerCase().replace(/\s+/g, ' ');
}

@Injectable()
export class TextCleanerService {
  private readonly logger = new Logger(TextCleanerService.name);
  private readonly removeIntroEnabled: boolean;
  private readonly removeOutroEnabled: boolean;
  private readonly removeSponsorsEnabled: boolean;
  private readonly removeFillersEnabled: boolean;

  constructor(config: ConfigService<Env, true>) {
    this.removeIntroEnabled = config.get('CLEANING_REMOVE_INTRO', { infer: true });
    this.removeOutroEnabled = config.get('CLEANING_REMOVE_OUTRO', { infer: true });
    this.removeSponsorsEnabled = config.get('CLEANING_REMOVE_SPONSORS', { infer: true });
    this.removeFillersEnabled = config.get('CLEANING_REMOVE_FILLERS', { infer: true });
  }

  clean(text: string): string {
    if (text.length === 0) {
      return text;
    }

    let result = text;
    result = this.normalizeUnicode(result);
    result = this.normalizeQuotes(result);
    result = this.normalizeSpaces(result);
    result = this.normalizeNewlines(result);
    result = this.collapseRepeatedPunctuation(result);
    result = result.trim();
    result = this.dedupeRepeatedSentences(result);

    if (this.removeIntroEnabled) {
      result = this.removeIntro(result);
    }
    if (this.removeOutroEnabled) {
      result = this.removeOutro(result);
    }
    if (this.removeSponsorsEnabled) {
      result = this.removeSponsors(result);
    }
    if (this.removeFillersEnabled) {
      result = this.removeFillers(result);
    }

    return result;
  }

  // --- Level 1: always applied ---

  private normalizeUnicode(text: string): string {
    return text.normalize('NFC');
  }

  private normalizeQuotes(text: string): string {
    return text.replace(SMART_DOUBLE_QUOTES, '"').replace(SMART_SINGLE_QUOTES, "'");
  }

  private normalizeSpaces(text: string): string {
    return text.replace(NBSP, ' ').replace(REPEATED_SPACES, ' ');
  }

  private normalizeNewlines(text: string): string {
    return text.replace(TRIPLE_PLUS_NEWLINES, '\n\n');
  }

  private collapseRepeatedPunctuation(text: string): string {
    return text
      .replace(REPEATED_BANG, '!')
      .replace(REPEATED_QUESTION, '?')
      .replace(FOUR_PLUS_DOTS, '...');
  }

  private dedupeRepeatedSentences(text: string): string {
    const sentences = text.split(SENTENCE_SPLIT);
    if (sentences.length <= 1) {
      return text;
    }

    const kept: string[] = [];
    let i = 0;
    while (i < sentences.length) {
      const current = sentences[i];
      const normalized = normalizeForComparison(current);
      let run = 1;
      while (
        i + run < sentences.length &&
        normalizeForComparison(sentences[i + run]) === normalized
      ) {
        run += 1;
      }

      if (run >= 3 && normalized.length > 0) {
        kept.push(current);
      } else {
        for (let k = 0; k < run; k += 1) {
          kept.push(sentences[i + k]);
        }
      }
      i += run;
    }

    return kept.join(' ');
  }

  // --- Level 2: config-gated, anchor-phrase based ---

  private removeIntro(text: string): string {
    const lower = text.toLowerCase();
    for (const anchor of LEX_INTRO_ANCHORS) {
      const idx = lower.indexOf(anchor.toLowerCase());
      if (idx === -1) {
        continue;
      }
      const afterAnchor = text.slice(idx + anchor.length);
      const terminatorMatch = afterAnchor.match(FIRST_SENTENCE_TERMINATOR);
      if (terminatorMatch && terminatorMatch.index !== undefined) {
        return afterAnchor.slice(terminatorMatch.index + 1).trimStart();
      }
      return afterAnchor.trimStart();
    }
    return text;
  }

  private removeOutro(text: string): string {
    const lower = text.toLowerCase();
    for (const anchor of LEX_OUTRO_ANCHORS) {
      const idx = lower.indexOf(anchor.toLowerCase());
      if (idx === -1) {
        continue;
      }
      return text.slice(0, idx).trimEnd();
    }
    return text;
  }

  // --- Level 3: deferred to Phase 2; stubs preserve config plumbing. ---

  private removeSponsors(text: string): string {
    this.logger.warn('Sponsor removal not implemented yet (CLEANING_REMOVE_SPONSORS is on)');
    return text;
  }

  private removeFillers(text: string): string {
    this.logger.warn('Filler removal not implemented yet (CLEANING_REMOVE_FILLERS is on)');
    return text;
  }
}
