import { Logger } from '@nestjs/common';
import type { BaseCallbackHandler } from '@langchain/core/callbacks/base';
import type { LLMResult } from '@langchain/core/outputs';
import { TokenUsageService } from './token-usage.service';

/**
 * Build an `LLMResult` carrying token usage in the OpenAI-style
 * `llmOutput.tokenUsage` shape.
 */
function makeResultLlmOutput(
  promptTokens: number,
  completionTokens: number,
  totalTokens?: number,
): LLMResult {
  return {
    generations: [[]],
    llmOutput: { tokenUsage: { promptTokens, completionTokens, totalTokens } },
  };
}

/**
 * Build an `LLMResult` carrying token usage in the Gemini-style
 * `generations[0][0].message.usage_metadata` shape.
 */
function makeResultUsageMetadata(input: number, output: number, total?: number): LLMResult {
  return {
    generations: [
      [
        {
          text: 'mock',
          message: {
            usage_metadata: {
              input_tokens: input,
              output_tokens: output,
              total_tokens: total,
            },
          },
        },
      ],
    ],
    llmOutput: {},
  } as unknown as LLMResult;
}

function makeResultEmpty(): LLMResult {
  return { generations: [[]], llmOutput: {} };
}

/**
 * Calls the (optional) `handleLLMEnd` method on a handler with the
 * minimum required args. The handler's runtime signature accepts more
 * args (runId, parentRunId, tags, extraParams); we pass empty defaults
 * since the implementation under test only inspects `output`.
 */
async function invokeHandleLLMEnd(handler: BaseCallbackHandler, output: LLMResult): Promise<void> {
  await handler.handleLLMEnd?.(output, 'test-run-id');
}

describe('TokenUsageService', () => {
  beforeAll(() => {
    Logger.overrideLogger(false);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('createCallback', () => {
    it('returns a handler with name TokenUsageCallback', () => {
      const service = new TokenUsageService();
      const handler = service.createCallback('corr-1');
      expect(handler.name).toBe('TokenUsageCallback');
    });

    it('handleLLMEnd captures usage from llmOutput.tokenUsage and stores it', async () => {
      const service = new TokenUsageService();
      const handler = service.createCallback('corr-llm-output');

      await invokeHandleLLMEnd(handler, makeResultLlmOutput(120, 45, 165));

      expect(service.consumeUsage('corr-llm-output')).toEqual({
        inputTokens: 120,
        outputTokens: 45,
        totalTokens: 165,
      });
    });

    it('handleLLMEnd derives totalTokens from sum when omitted (llmOutput path)', async () => {
      const service = new TokenUsageService();
      const handler = service.createCallback('corr-derive-1');

      await invokeHandleLLMEnd(handler, makeResultLlmOutput(100, 50));

      expect(service.consumeUsage('corr-derive-1')).toEqual({
        inputTokens: 100,
        outputTokens: 50,
        totalTokens: 150,
      });
    });

    it('handleLLMEnd captures usage from generations[0].message.usage_metadata (Gemini path)', async () => {
      const service = new TokenUsageService();
      const handler = service.createCallback('corr-gemini');

      await invokeHandleLLMEnd(handler, makeResultUsageMetadata(800, 200, 1000));

      expect(service.consumeUsage('corr-gemini')).toEqual({
        inputTokens: 800,
        outputTokens: 200,
        totalTokens: 1000,
      });
    });

    it('handleLLMEnd derives totalTokens from sum when omitted (Gemini path)', async () => {
      const service = new TokenUsageService();
      const handler = service.createCallback('corr-derive-2');

      await invokeHandleLLMEnd(handler, makeResultUsageMetadata(800, 200));

      expect(service.consumeUsage('corr-derive-2')).toEqual({
        inputTokens: 800,
        outputTokens: 200,
        totalTokens: 1000,
      });
    });

    it('handleLLMEnd logs a warning and stores nothing when neither shape carries usage', async () => {
      const service = new TokenUsageService();
      const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

      const handler = service.createCallback('corr-empty');
      await invokeHandleLLMEnd(handler, makeResultEmpty());

      expect(service.consumeUsage('corr-empty')).toBeNull();
      const warnLine = warnSpy.mock.calls
        .map((args) => String(args[0]))
        .find((msg) => msg.startsWith('token_usage_missing'));
      expect(warnLine).toBeDefined();
      expect(warnLine).toContain('correlation_id=corr-empty');

      warnSpy.mockRestore();
    });
  });

  describe('consumeUsage', () => {
    it('returns and removes the captured entry (single-use)', async () => {
      const service = new TokenUsageService();
      const handler = service.createCallback('corr-consume');
      await invokeHandleLLMEnd(handler, makeResultLlmOutput(10, 5));

      const first = service.consumeUsage('corr-consume');
      const second = service.consumeUsage('corr-consume');

      expect(first).not.toBeNull();
      expect(second).toBeNull();
    });

    it('returns null when no entry exists for the correlation id', () => {
      const service = new TokenUsageService();
      expect(service.consumeUsage('never-captured')).toBeNull();
    });

    it('prunes entries older than 60 s on access', async () => {
      jest.useFakeTimers();
      const service = new TokenUsageService();
      const handler = service.createCallback('corr-expire');
      await invokeHandleLLMEnd(handler, makeResultLlmOutput(10, 5));

      // Just before TTL — still readable (but we don't consume here so
      // the entry stays for the next access).
      jest.advanceTimersByTime(59_000);
      // Past TTL — pruneExpired runs on next consumeUsage and drops it.
      jest.advanceTimersByTime(2_000);

      expect(service.consumeUsage('corr-expire')).toBeNull();
    });
  });

  describe('getRollingTotals', () => {
    it('increments totals across multiple captures (sums + counts)', async () => {
      const service = new TokenUsageService();

      await invokeHandleLLMEnd(service.createCallback('a'), makeResultLlmOutput(100, 50));
      await invokeHandleLLMEnd(service.createCallback('b'), makeResultUsageMetadata(200, 30));
      await invokeHandleLLMEnd(service.createCallback('c'), makeResultLlmOutput(50, 10));

      const totals = service.getRollingTotals();
      expect(totals.totalInputTokens).toBe(350);
      expect(totals.totalOutputTokens).toBe(90);
      expect(totals.totalRequests).toBe(3);
    });

    it('does NOT increment when extraction returns null', async () => {
      const service = new TokenUsageService();
      await invokeHandleLLMEnd(service.createCallback('empty'), makeResultEmpty());

      const totals = service.getRollingTotals();
      expect(totals.totalInputTokens).toBe(0);
      expect(totals.totalOutputTokens).toBe(0);
      expect(totals.totalRequests).toBe(0);
    });

    it('exposes a non-null sinceTimestamp set at construction', () => {
      const service = new TokenUsageService();
      const ts = service.getRollingTotals().sinceTimestamp;
      expect(typeof ts).toBe('string');
      expect(Number.isNaN(Date.parse(ts))).toBe(false);
    });
  });
});
