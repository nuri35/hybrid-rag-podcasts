import { Test } from '@nestjs/testing';
import type { Runnable } from '@langchain/core/runnables';
import { CircuitOpenException } from '../exceptions/circuit-open.exception';
import { RetryExhaustedException } from '../exceptions/retry-exhausted.exception';
import { CircuitBreakerService } from './circuit-breaker.service';
import { ResilientLlmService } from './resilient-llm.service';
import { RetryPolicyService } from './retry-policy.service';
import type { RetryResult } from '../types/retry-policy.types';

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

/** Minimal Runnable shim — only `.invoke(input)` is used by the service. */
function makeChain<TInput, TOutput>(
  invokeImpl: (input: TInput) => Promise<TOutput>,
): {
  chain: Runnable<TInput, TOutput>;
  invokeSpy: jest.Mock<Promise<TOutput>, [TInput]>;
} {
  const invokeSpy = jest.fn<Promise<TOutput>, [TInput]>().mockImplementation(invokeImpl);
  const chain = { invoke: invokeSpy } as unknown as Runnable<TInput, TOutput>;
  return { chain, invokeSpy };
}

async function build(): Promise<{
  service: ResilientLlmService;
  retry: MockRetryPolicyService;
  circuit: MockCircuitBreakerService;
}> {
  const retry = makeMockRetryPolicyService();
  const circuit = makeMockCircuitBreakerService();
  const moduleRef = await Test.createTestingModule({
    providers: [
      ResilientLlmService,
      { provide: RetryPolicyService, useValue: retry },
      { provide: CircuitBreakerService, useValue: circuit },
    ],
  }).compile();
  return { service: moduleRef.get(ResilientLlmService), retry, circuit };
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

      const out = await service.invokeChain(chain, 'in');

      expect(out).toBe('result');
      expect(circuit.execute).toHaveBeenCalledTimes(1);
      expect(retry.execute).toHaveBeenCalledTimes(1);
      expect(invokeSpy).toHaveBeenCalledWith('in');
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

      await expect(service.invokeChain(chain, 'in')).resolves.toBe('ok');
    });

    it('propagates RetryExhaustedException from retry policy untouched', async () => {
      const { service, retry } = await build();
      const { chain } = makeChain<string, string>(() => Promise.resolve('unused'));
      const exhausted = new RetryExhaustedException(3, 3_500, new Error('503'));
      retry.execute.mockRejectedValueOnce(exhausted);

      const caught = await service.invokeChain(chain, 'in').catch((e: unknown) => e);
      expect(caught).toBe(exhausted);
      expect(caught).toBeInstanceOf(RetryExhaustedException);
    });

    it('propagates non-retryable errors from retry policy untouched (no wrap)', async () => {
      const { service, retry } = await build();
      const { chain } = makeChain<string, string>(() => Promise.resolve('unused'));
      const badInput = new Error('400 Bad Request');
      retry.execute.mockRejectedValueOnce(badInput);

      const caught = await service.invokeChain(chain, 'in').catch((e: unknown) => e);
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

      const caught = await service.invokeChain(chain, 'in').catch((e: unknown) => e);
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

      const caught = await service.invokeChain(chain, 'in').catch((e: unknown) => e);
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

      const caught = await service.invokeChain(chain, 'in').catch((e: unknown) => e);
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
});
