import { Test } from '@nestjs/testing';
import type { BaseCallbackHandler } from '@langchain/core/callbacks/base';
import type { Runnable } from '@langchain/core/runnables';
import { CircuitOpenException } from '../exceptions/circuit-open.exception';
import { RetryExhaustedException } from '../exceptions/retry-exhausted.exception';
import { CircuitBreakerService } from './circuit-breaker.service';
import { ResilientLlmService } from './resilient-llm.service';
import { RetryPolicyService } from './retry-policy.service';
import { TokenUsageService } from './token-usage.service';
import type { RetryResult } from '../types/retry-policy.types';

const FAKE_CORR_ID = 'test-correlation-id';

/**
 * Integration tests for the composer service. Both underlying services
 * are MOCKED — RetryPolicyService and CircuitBreakerService have their
 * own specs that exercise the underlying patterns. The job of this
 * suite is to verify the composition: that ResilientLlmService calls
 * each in the right order and propagates results / errors correctly.
 */

interface MockRetryPolicyService {
  execute: jest.Mock<Promise<RetryResult<unknown>>, [() => Promise<unknown>]>;
}

interface MockCircuitBreakerService {
  execute: jest.Mock<Promise<unknown>, [() => Promise<unknown>]>;
}

interface MockTokenUsageService {
  createCallback: jest.Mock<BaseCallbackHandler, [string]>;
}

/** Stand-in for a real handler — only `name` is touched by these tests. */
const FAKE_HANDLER = { name: 'TokenUsageCallback' } as unknown as BaseCallbackHandler;

function makeMockTokenUsageService(): MockTokenUsageService {
  const mock = {
    createCallback: jest.fn<BaseCallbackHandler, [string]>(),
  };
  mock.createCallback.mockReturnValue(FAKE_HANDLER);
  return mock;
}

function makeMockRetryPolicyService(): MockRetryPolicyService {
  return {
    execute: jest.fn<Promise<RetryResult<unknown>>, [() => Promise<unknown>]>(),
  };
}

function makeMockCircuitBreakerService(): MockCircuitBreakerService {
  // Default: pass-through to the operation (no circuit logic). Tests
  // that exercise OPEN-state behaviour override with `mockRejectedValueOnce`.
  const mock = {
    execute: jest.fn<Promise<unknown>, [() => Promise<unknown>]>(),
  };
  mock.execute.mockImplementation((op) => op());
  return mock;
}

/**
 * Minimal Runnable shim — `.invoke(input, options?)` second arg carries
 * `{ callbacks: [...] }` after Sprint Token Step 2. The spy is typed
 * loosely (`unknown` options) so existing tests that ignore options
 * still type-check while new tests can assert on the callbacks key.
 */
function makeChain<TInput, TOutput>(
  invokeImpl: (input: TInput) => Promise<TOutput>,
): {
  chain: Runnable<TInput, TOutput>;
  invokeSpy: jest.Mock<Promise<TOutput>, [TInput, unknown?]>;
} {
  const invokeSpy = jest
    .fn<Promise<TOutput>, [TInput, unknown?]>()
    .mockImplementation((input) => invokeImpl(input));
  const chain = { invoke: invokeSpy } as unknown as Runnable<TInput, TOutput>;
  return { chain, invokeSpy };
}

async function build(): Promise<{
  service: ResilientLlmService;
  retry: MockRetryPolicyService;
  circuit: MockCircuitBreakerService;
  tokenUsage: MockTokenUsageService;
}> {
  const retry = makeMockRetryPolicyService();
  const circuit = makeMockCircuitBreakerService();
  const tokenUsage = makeMockTokenUsageService();
  const moduleRef = await Test.createTestingModule({
    providers: [
      ResilientLlmService,
      { provide: RetryPolicyService, useValue: retry },
      { provide: CircuitBreakerService, useValue: circuit },
      { provide: TokenUsageService, useValue: tokenUsage },
    ],
  }).compile();
  return { service: moduleRef.get(ResilientLlmService), retry, circuit, tokenUsage };
}

describe('ResilientLlmService', () => {
  // -----------------------------------------------------------------
  // Composition order — outer circuit, inner retry, innermost chain
  // -----------------------------------------------------------------
  describe('composition order', () => {
    it('wraps the chain invocation in retry inside circuit (circuit is outer)', async () => {
      const { service, retry, circuit } = await build();
      const { chain, invokeSpy } = makeChain<string, string>(() => Promise.resolve('result'));

      // Retry returns a RetryResult-success containing the operation's
      // resolved value. Default circuit mock pass-throughs to op().
      retry.execute.mockImplementation(async (op) => {
        const result = await op();
        return { success: true, result, attempts: 1, totalDurationMs: 1 };
      });

      const out = await service.invokeChain(chain, 'in', FAKE_CORR_ID);

      expect(out).toBe('result');
      expect(circuit.execute).toHaveBeenCalledTimes(1);
      expect(retry.execute).toHaveBeenCalledTimes(1);
      expect(invokeSpy).toHaveBeenCalledWith(
        'in',
        expect.objectContaining({ callbacks: [FAKE_HANDLER] }),
      );
    });
  });

  // -----------------------------------------------------------------
  // Retry / circuit pass-through behaviour
  // -----------------------------------------------------------------
  describe('retry behaviour (delegated to RetryPolicyService)', () => {
    it('returns the resolved value when retry reports success', async () => {
      const { service, retry } = await build();
      const { chain } = makeChain<string, string>(() => Promise.resolve('ok'));

      retry.execute.mockResolvedValueOnce({
        success: true,
        result: 'ok',
        attempts: 2,
        totalDurationMs: 250,
      });

      await expect(service.invokeChain(chain, 'in', FAKE_CORR_ID)).resolves.toBe('ok');
    });

    it('propagates RetryExhaustedException from retry policy untouched', async () => {
      const { service, retry } = await build();
      const { chain } = makeChain<string, string>(() => Promise.resolve('unused'));
      const exhausted = new RetryExhaustedException(3, 3_500, new Error('503'));
      retry.execute.mockRejectedValueOnce(exhausted);

      const caught = await service.invokeChain(chain, 'in', FAKE_CORR_ID).catch((e: unknown) => e);
      expect(caught).toBe(exhausted);
      expect(caught).toBeInstanceOf(RetryExhaustedException);
    });

    it('propagates non-retryable errors from retry policy untouched (no wrap)', async () => {
      const { service, retry } = await build();
      const { chain } = makeChain<string, string>(() => Promise.resolve('unused'));
      const badInput = new Error('400 Bad Request');
      retry.execute.mockRejectedValueOnce(badInput);

      const caught = await service.invokeChain(chain, 'in', FAKE_CORR_ID).catch((e: unknown) => e);
      expect(caught).toBe(badInput);
    });

    it('throws the programmer-error guard if retry resolves with no result', async () => {
      const { service, retry } = await build();
      const { chain } = makeChain<string, string>(() => Promise.resolve('unused'));
      retry.execute.mockResolvedValueOnce({
        success: false,
        result: undefined,
        attempts: 1,
        totalDurationMs: 0,
        finalError: undefined,
      });

      const caught = await service.invokeChain(chain, 'in', FAKE_CORR_ID).catch((e: unknown) => e);
      // Generic Error from the defensive guard (success:false + no result
      // + no finalError → fallback message).
      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).message).toContain('Retry policy returned no result');
    });
  });

  describe('circuit-breaker behaviour (delegated to CircuitBreakerService)', () => {
    it('propagates CircuitOpenException from the circuit untouched (chain never invoked)', async () => {
      const { service, retry, circuit } = await build();
      const { chain, invokeSpy } = makeChain<string, string>(() => Promise.resolve('unused'));

      const circuitErr = new CircuitOpenException(30);
      circuit.execute.mockRejectedValueOnce(circuitErr);

      const caught = await service.invokeChain(chain, 'in', FAKE_CORR_ID).catch((e: unknown) => e);
      expect(caught).toBe(circuitErr);
      // Critical: when circuit is OPEN, the retry policy is never given
      // a chance — and certainly the chain never runs.
      expect(retry.execute).not.toHaveBeenCalled();
      expect(invokeSpy).not.toHaveBeenCalled();
    });

    it('a RetryExhausted result counts as ONE circuit-level failure', async () => {
      // White-box on the contract: when retry exhausts, it throws inside
      // the function the circuit ran — so the circuit sees a single
      // rejection regardless of how many retry attempts happened.
      const { service, retry, circuit } = await build();
      const { chain, invokeSpy } = makeChain<string, string>(() => Promise.resolve('unused'));

      const exhausted = new RetryExhaustedException(3, 3_500, new Error('503'));
      retry.execute.mockRejectedValueOnce(exhausted);

      const caught = await service.invokeChain(chain, 'in', FAKE_CORR_ID).catch((e: unknown) => e);
      expect(caught).toBe(exhausted);

      // circuit.execute was called once, the function it was given
      // rejected once — that's one circuit-level failure to record.
      expect(circuit.execute).toHaveBeenCalledTimes(1);
      // The default circuit mock pass-throughs to the operation, so
      // retry was indeed invoked inside.
      expect(retry.execute).toHaveBeenCalledTimes(1);
      // The chain itself was NOT directly called by ResilientLlmService —
      // retry would have invoked it under normal conditions.
      expect(invokeSpy).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------
  // streamChain — initiation-only protection (Sprint Streaming)
  // -----------------------------------------------------------------
  describe('streamChain (Phase 1.6 Sprint Streaming)', () => {
    /** Builds a fresh async iterator each call so retry-style re-invocations work. */
    function makeStreamingChain(makeIterator: () => AsyncGenerator<string, void, void>): {
      chain: Runnable<string, string>;
      streamSpy: jest.Mock<Promise<AsyncGenerator<string, void, void>>, [string, unknown?]>;
    } {
      const streamSpy = jest
        .fn<Promise<AsyncGenerator<string, void, void>>, [string, unknown?]>()
        .mockImplementation(() => Promise.resolve(makeIterator()));
      const chain = { stream: streamSpy } as unknown as Runnable<string, string>;
      return { chain, streamSpy };
    }

    async function collect(gen: AsyncGenerator<string, void, void>): Promise<string[]> {
      const out: string[] = [];
      for await (const t of gen) out.push(t);
      return out;
    }

    async function collectUntilError(
      gen: AsyncGenerator<string, void, void>,
    ): Promise<{ collected: string[]; error: unknown }> {
      const collected: string[] = [];
      try {
        for await (const t of gen) collected.push(t);
        return { collected, error: undefined };
      } catch (error) {
        return { collected, error };
      }
    }

    it('routes initiation through circuit → retry → chain.stream (composition order)', async () => {
      const { service, retry, circuit } = await build();
      const { chain, streamSpy } = makeStreamingChain(async function* () {
        await Promise.resolve(); // satisfies @typescript-eslint/require-await; async required for `for await`

        yield 'hello';
      });
      retry.execute.mockImplementation(async (op) => {
        const iter = await op();
        return { success: true, result: iter, attempts: 1, totalDurationMs: 1 };
      });

      const out = await collect(service.streamChain(chain, 'in', FAKE_CORR_ID));

      expect(out).toEqual(['hello']);
      expect(circuit.execute).toHaveBeenCalledTimes(1);
      expect(retry.execute).toHaveBeenCalledTimes(1);
      expect(streamSpy).toHaveBeenCalledWith(
        'in',
        expect.objectContaining({ callbacks: [FAKE_HANDLER] }),
      );
    });

    it('yields every token from the underlying iterator in order', async () => {
      const { service, retry } = await build();
      const tokens = ['Consciousness', ' is', ' fundamentally', ' subjective.'];
      const { chain } = makeStreamingChain(async function* () {
        await Promise.resolve(); // satisfies @typescript-eslint/require-await; async required for `for await`

        for (const t of tokens) yield t;
      });
      retry.execute.mockImplementation(async (op) => {
        const iter = await op();
        return { success: true, result: iter, attempts: 1, totalDurationMs: 1 };
      });

      const out = await collect(service.streamChain(chain, 'q', FAKE_CORR_ID));
      expect(out).toEqual(tokens);
    });

    it('propagates non-retryable initiation error untouched (4xx-style)', async () => {
      const { service, retry } = await build();
      const { chain } = makeStreamingChain(async function* () {
        await Promise.resolve(); // satisfies @typescript-eslint/require-await; async required for `for await`

        yield 'never-reached';
      });
      const badInput = new Error('400 Bad Request');
      retry.execute.mockRejectedValueOnce(badInput);

      const { collected, error } = await collectUntilError(
        service.streamChain(chain, 'in', FAKE_CORR_ID),
      );
      expect(collected).toEqual([]);
      expect(error).toBe(badInput);
    });

    it('propagates CircuitOpenException — chain.stream never invoked', async () => {
      const { service, retry, circuit } = await build();
      const { chain, streamSpy } = makeStreamingChain(async function* () {
        await Promise.resolve(); // satisfies @typescript-eslint/require-await; async required for `for await`

        yield 'never-reached';
      });
      const circuitErr = new CircuitOpenException(30);
      circuit.execute.mockRejectedValueOnce(circuitErr);

      const { collected, error } = await collectUntilError(
        service.streamChain(chain, 'in', FAKE_CORR_ID),
      );
      expect(collected).toEqual([]);
      expect(error).toBe(circuitErr);
      expect(retry.execute).not.toHaveBeenCalled();
      expect(streamSpy).not.toHaveBeenCalled();
    });

    it('propagates RetryExhaustedException from initiation untouched', async () => {
      const { service, retry } = await build();
      const { chain } = makeStreamingChain(async function* () {
        await Promise.resolve(); // satisfies @typescript-eslint/require-await; async required for `for await`

        yield 'never-reached';
      });
      const exhausted = new RetryExhaustedException(3, 3_500, new Error('503'));
      retry.execute.mockRejectedValueOnce(exhausted);

      const { collected, error } = await collectUntilError(
        service.streamChain(chain, 'in', FAKE_CORR_ID),
      );
      expect(collected).toEqual([]);
      expect(error).toBe(exhausted);
    });

    it('does NOT retry on a mid-stream iterator failure (consumption is unprotected)', async () => {
      const { service, retry } = await build();
      const midStreamErr = new Error('upstream dropped mid-flight after 2 tokens');
      const { chain, streamSpy } = makeStreamingChain(async function* () {
        await Promise.resolve(); // satisfies @typescript-eslint/require-await; async required for `for await`

        yield 'token1';
        yield 'token2';
        throw midStreamErr;
      });
      retry.execute.mockImplementation(async (op) => {
        const iter = await op();
        return { success: true, result: iter, attempts: 1, totalDurationMs: 1 };
      });

      const { collected, error } = await collectUntilError(
        service.streamChain(chain, 'q', FAKE_CORR_ID),
      );

      // First two tokens made it through before the iterator threw.
      expect(collected).toEqual(['token1', 'token2']);
      expect(error).toBe(midStreamErr);
      // CRITICAL: chain.stream was called exactly once — the iterator's
      // throw did NOT trigger a retry-cycle re-stream. Mid-stream
      // failures are intentionally unprotected.
      expect(streamSpy).toHaveBeenCalledTimes(1);
      expect(retry.execute).toHaveBeenCalledTimes(1);
    });

    it('throws the programmer-error guard if retry resolves with no result', async () => {
      const { service, retry } = await build();
      const { chain } = makeStreamingChain(async function* () {
        await Promise.resolve(); // satisfies @typescript-eslint/require-await; async required for `for await`

        yield 'unused';
      });
      retry.execute.mockResolvedValueOnce({
        success: false,
        result: undefined,
        attempts: 1,
        totalDurationMs: 0,
        finalError: undefined,
      });

      const { collected, error } = await collectUntilError(
        service.streamChain(chain, 'in', FAKE_CORR_ID),
      );
      expect(collected).toEqual([]);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain('Retry policy returned no stream');
    });
  });

  // -----------------------------------------------------------------
  // Phase 1.6 Sprint Token — token-usage callback wiring
  // -----------------------------------------------------------------
  describe('token-usage callback wiring', () => {
    it('invokeChain calls TokenUsageService.createCallback with the provided correlationId', async () => {
      const { service, retry, tokenUsage } = await build();
      const { chain } = makeChain<string, string>(() => Promise.resolve('ok'));
      retry.execute.mockImplementation(async (op) => {
        const result = await op();
        return { success: true, result, attempts: 1, totalDurationMs: 1 };
      });

      await service.invokeChain(chain, 'in', 'corr-invoke-42');

      expect(tokenUsage.createCallback).toHaveBeenCalledTimes(1);
      expect(tokenUsage.createCallback).toHaveBeenCalledWith('corr-invoke-42');
    });

    it('invokeChain passes the created callback to chain.invoke via the callbacks option', async () => {
      const { service, retry, tokenUsage } = await build();
      const { chain, invokeSpy } = makeChain<string, string>(() => Promise.resolve('ok'));
      retry.execute.mockImplementation(async (op) => {
        const result = await op();
        return { success: true, result, attempts: 1, totalDurationMs: 1 };
      });

      await service.invokeChain(chain, 'in', FAKE_CORR_ID);

      // The chain.invoke spy was called with (input, { callbacks: [FAKE_HANDLER] }).
      const [inputArg, optionsArg] = invokeSpy.mock.calls[0];
      expect(inputArg).toBe('in');
      expect(optionsArg).toEqual(expect.objectContaining({ callbacks: [FAKE_HANDLER] }));
      // Sanity — the createCallback was the one whose return value flowed in.
      expect(tokenUsage.createCallback).toHaveBeenCalledWith(FAKE_CORR_ID);
    });

    it('streamChain calls TokenUsageService.createCallback with the provided correlationId', async () => {
      const { service, retry, tokenUsage } = await build();
      const streamSpy = jest
        .fn<Promise<AsyncGenerator<string, void, void>>, [string, unknown?]>()
        .mockImplementation(() =>
          Promise.resolve(
            (async function* () {
              await Promise.resolve();
              yield 'hello';
            })(),
          ),
        );
      const chain = { stream: streamSpy } as unknown as Runnable<string, string>;
      retry.execute.mockImplementation(async (op) => {
        const iter = await op();
        return { success: true, result: iter, attempts: 1, totalDurationMs: 1 };
      });

      // Drain the generator so streamChain actually awaits the initiation.
      for await (const _ of service.streamChain(chain, 'in', 'corr-stream-99')) {
        // consume
      }

      expect(tokenUsage.createCallback).toHaveBeenCalledTimes(1);
      expect(tokenUsage.createCallback).toHaveBeenCalledWith('corr-stream-99');
    });

    it('streamChain passes the created callback to chain.stream via the callbacks option', async () => {
      const { service, retry } = await build();
      const streamSpy = jest
        .fn<Promise<AsyncGenerator<string, void, void>>, [string, unknown?]>()
        .mockImplementation(() =>
          Promise.resolve(
            (async function* () {
              await Promise.resolve();
              yield 'hello';
            })(),
          ),
        );
      const chain = { stream: streamSpy } as unknown as Runnable<string, string>;
      retry.execute.mockImplementation(async (op) => {
        const iter = await op();
        return { success: true, result: iter, attempts: 1, totalDurationMs: 1 };
      });

      for await (const _ of service.streamChain(chain, 'in', FAKE_CORR_ID)) {
        // consume
      }

      const [inputArg, optionsArg] = streamSpy.mock.calls[0];
      expect(inputArg).toBe('in');
      expect(optionsArg).toEqual(expect.objectContaining({ callbacks: [FAKE_HANDLER] }));
    });
  });
});
