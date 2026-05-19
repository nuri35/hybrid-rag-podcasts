import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { Document } from '@langchain/core/documents';
import { EmbeddingFailedException } from '../../../common/exceptions';
import { EmbedderService } from './embedder.service';

const mockEmbedDocuments = jest.fn<Promise<number[][]>, [string[]]>();
const mockEmbedQuery = jest.fn<Promise<number[]>, [string]>();

jest.mock('@langchain/google-genai', () => ({
  GoogleGenerativeAIEmbeddings: jest.fn().mockImplementation(() => ({
    embedDocuments: (texts: string[]) => mockEmbedDocuments(texts),
    embedQuery: (text: string) => mockEmbedQuery(text),
  })),
}));

jest.mock('@google/generative-ai', () => ({
  TaskType: {
    RETRIEVAL_DOCUMENT: 'RETRIEVAL_DOCUMENT',
    RETRIEVAL_QUERY: 'RETRIEVAL_QUERY',
  },
}));

interface ConfigOverrides {
  EMBEDDING_BATCH_SIZE?: number;
  EMBEDDING_CONCURRENCY?: number;
  EMBEDDING_MODEL?: string;
  GOOGLE_API_KEY?: string;
  EMBEDDING_REQUESTS_PER_MINUTE?: number;
  EMBEDDING_RETRY_MAX_ATTEMPTS?: number;
  EMBEDDING_RETRY_INITIAL_DELAY_MS?: number;
  EMBEDDING_RETRY_MAX_DELAY_MS?: number;
  EMBEDDING_RETRY_GROWTH_FACTOR?: number;
}

function makeConfig(overrides: ConfigOverrides = {}): ConfigService {
  // Test-friendly defaults: huge RPM so the token bucket is effectively a no-op
  // and tests run fast, and a small retry budget so failure paths exit quickly.
  const values: Record<string, unknown> = {
    GOOGLE_API_KEY: 'test-key',
    EMBEDDING_MODEL: 'gemini-embedding-001',
    EMBEDDING_BATCH_SIZE: 10,
    EMBEDDING_CONCURRENCY: 5,
    EMBEDDING_REQUESTS_PER_MINUTE: 60_000, // → minIntervalMs = 1ms
    EMBEDDING_RETRY_MAX_ATTEMPTS: 1,
    EMBEDDING_RETRY_INITIAL_DELAY_MS: 50,
    EMBEDDING_RETRY_MAX_DELAY_MS: 200,
    EMBEDDING_RETRY_GROWTH_FACTOR: 1.5,
    ...overrides,
  };
  return {
    get: (key: string): unknown => values[key],
  } as unknown as ConfigService;
}

async function buildService(overrides: ConfigOverrides = {}): Promise<EmbedderService> {
  const moduleRef = await Test.createTestingModule({
    providers: [EmbedderService, { provide: ConfigService, useValue: makeConfig(overrides) }],
  }).compile();
  return moduleRef.get(EmbedderService);
}

function makeDoc(idx: number, content?: string): Document {
  return new Document({
    pageContent: content ?? `doc-${idx}`,
    metadata: { episode_id: `ep_${idx}`, chunk_id: `ep_${idx}_chunk_0` },
  });
}

describe('EmbedderService', () => {
  beforeAll(() => {
    Logger.overrideLogger(false);
  });

  beforeEach(() => {
    mockEmbedDocuments.mockReset();
    mockEmbedQuery.mockReset();
  });

  it('preserves input order across multiple batches', async () => {
    // Encode the doc index in v[0] while keeping v[1] constant. Normalization
    // collapses magnitude but preserves the v[0]/v[1] ratio = idx, so each
    // returned slot still maps back to its original document index.
    mockEmbedDocuments.mockImplementation((texts) =>
      Promise.resolve(
        texts.map((t) => {
          const idx = Number(t.replace('doc-', ''));
          return [idx, 1];
        }),
      ),
    );

    const service = await buildService({ EMBEDDING_BATCH_SIZE: 10, EMBEDDING_CONCURRENCY: 5 });
    const docs = Array.from({ length: 25 }, (_, i) => makeDoc(i));

    const vectors = await service.embedBatch(docs);

    expect(vectors).toHaveLength(25);
    expect(mockEmbedDocuments).toHaveBeenCalledTimes(3);
    vectors.forEach((v, i) => {
      const magnitude = Math.sqrt(v[0] ** 2 + v[1] ** 2);
      expect(magnitude).toBeCloseTo(1, 10);
      expect(v[0] / v[1]).toBeCloseTo(i, 8);
    });
  });

  it('skips empty/whitespace documents and counts them', async () => {
    mockEmbedDocuments.mockImplementation((texts) =>
      Promise.resolve(texts.map(() => [0.1, 0.2, 0.3])),
    );
    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    const service = await buildService();
    const docs: Document[] = [
      makeDoc(0, 'valid content one'),
      makeDoc(1, ''),
      makeDoc(2, '   \n\t   '),
      makeDoc(3, 'valid content two'),
      makeDoc(4, 'valid content three'),
    ];

    const vectors = await service.embedBatch(docs);

    expect(vectors).toHaveLength(3);
    const skipWarnings = warnSpy.mock.calls.filter((args) =>
      String(args[0]).startsWith('Skipping empty chunk'),
    );
    expect(skipWarnings).toHaveLength(2);

    warnSpy.mockRestore();
  });

  it('throws EmbeddingFailedException when any batch rejects after retries', async () => {
    mockEmbedDocuments
      .mockResolvedValueOnce(Array.from({ length: 10 }, () => [0]))
      .mockRejectedValueOnce(new Error('rate limit exceeded after retries'))
      .mockResolvedValueOnce(Array.from({ length: 10 }, () => [0]));
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    const service = await buildService({ EMBEDDING_BATCH_SIZE: 10, EMBEDDING_CONCURRENCY: 5 });
    const docs = Array.from({ length: 30 }, (_, i) => makeDoc(i, `content ${i}`));

    const caught = await service.embedBatch(docs).catch((e: unknown) => e);
    expect(caught).toBeInstanceOf(EmbeddingFailedException);
    expect(caught).toMatchObject({
      name: 'EmbeddingFailedException',
      fulfilled: 2,
      rejected: 1,
      total: 3,
    });
  });

  it('returns a full vector array when every batch fulfills', async () => {
    // Use an already-unit vector so the post-normalization output is identical
    // to the mock return; lets the test focus on length and call count.
    mockEmbedDocuments.mockImplementation((texts) =>
      Promise.resolve(texts.map(() => [1, 0, 0])),
    );

    const service = await buildService({ EMBEDDING_BATCH_SIZE: 10, EMBEDDING_CONCURRENCY: 5 });
    const docs = Array.from({ length: 15 }, (_, i) => makeDoc(i, `content ${i}`));

    const vectors = await service.embedBatch(docs);

    expect(vectors).toHaveLength(15);
    expect(mockEmbedDocuments).toHaveBeenCalledTimes(2);
    vectors.forEach((v) => {
      expect(v).toEqual([1, 0, 0]);
    });
  });

  it('respects the configured concurrency limit', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    mockEmbedDocuments.mockImplementation((texts) => {
      inFlight += 1;
      if (inFlight > maxInFlight) {
        maxInFlight = inFlight;
      }
      return new Promise((resolve) => {
        setTimeout(() => {
          inFlight -= 1;
          resolve(texts.map(() => [1, 0]));
        }, 25);
      });
    });

    const service = await buildService({ EMBEDDING_BATCH_SIZE: 10, EMBEDDING_CONCURRENCY: 3 });
    const docs = Array.from({ length: 50 }, (_, i) => makeDoc(i, `content ${i}`));

    const vectors = await service.embedBatch(docs);

    expect(vectors).toHaveLength(50);
    expect(mockEmbedDocuments).toHaveBeenCalledTimes(5);
    expect(maxInFlight).toBeLessThanOrEqual(3);
    expect(maxInFlight).toBeGreaterThanOrEqual(2);
  });

  it('warns about chunks longer than the threshold but does not skip them', async () => {
    mockEmbedDocuments.mockImplementation((texts) => Promise.resolve(texts.map(() => [0.1])));
    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    const service = await buildService();
    const longContent = 'x'.repeat(10_000);
    const docs = [
      makeDoc(0, 'normal content'),
      makeDoc(1, longContent),
      makeDoc(2, 'another normal'),
    ];

    const vectors = await service.embedBatch(docs);

    expect(vectors).toHaveLength(3);
    const longChunkWarnings = warnSpy.mock.calls.filter((args) =>
      /is \d+ chars/.test(String(args[0])),
    );
    expect(longChunkWarnings.length).toBeGreaterThanOrEqual(1);

    warnSpy.mockRestore();
  });

  it('normalizes vectors to unit length (||v|| == 1 after embed)', async () => {
    // Gemini mock returns [3, 4] — magnitude 5 — expected normalized [0.6, 0.8].
    mockEmbedDocuments.mockResolvedValue([[3, 4]]);

    const service = await buildService();
    const docs = [makeDoc(0, 'some content for the embedder')];

    const vectors = await service.embedBatch(docs);

    expect(vectors).toHaveLength(1);
    expect(vectors[0][0]).toBeCloseTo(0.6, 10);
    expect(vectors[0][1]).toBeCloseTo(0.8, 10);
    const magnitude = Math.sqrt(vectors[0][0] ** 2 + vectors[0][1] ** 2);
    expect(magnitude).toBeCloseTo(1, 10);
  });

  it('preserves input order after normalization across multiple batches', async () => {
    // Distinguish documents by a per-doc magnitude (idx + 1) while keeping the
    // direction identical, then post-normalize they all collapse to the same
    // unit vector. The order verification is instead done via the mock's
    // recorded call args — each batch must contain the contiguous slice of
    // docs in the original sequence, proving batching does not shuffle.
    mockEmbedDocuments.mockImplementation((texts) =>
      Promise.resolve(
        texts.map((t) => {
          const idx = Number(t.replace('doc-', ''));
          return [(idx + 1) * 2, (idx + 1) * 3];
        }),
      ),
    );

    const service = await buildService({ EMBEDDING_BATCH_SIZE: 10, EMBEDDING_CONCURRENCY: 5 });
    const docs = Array.from({ length: 25 }, (_, i) => makeDoc(i));

    const vectors = await service.embedBatch(docs);

    expect(vectors).toHaveLength(25);
    // Every output vector must be unit-length after normalization.
    vectors.forEach((v) => {
      const magnitude = Math.sqrt(v[0] ** 2 + v[1] ** 2);
      expect(magnitude).toBeCloseTo(1, 10);
    });
    // The direction (v[0]/v[1] = 2/3) is identical for all docs since each
    // mock vector lies on the same ray; magnitude info is lost on purpose.
    vectors.forEach((v) => {
      expect(v[0] / v[1]).toBeCloseTo(2 / 3, 10);
    });
    // Mock call args prove batching kept order: each call should receive a
    // contiguous slice of the input texts in ascending index order.
    expect(mockEmbedDocuments).toHaveBeenCalledTimes(3);
    const callTexts = mockEmbedDocuments.mock.calls.map((c) => c[0]);
    const flattened = callTexts.flat();
    flattened.forEach((t, i) => {
      expect(t).toBe(`doc-${i}`);
    });
  });

  it('throws EmbeddingFailedException when any zero-magnitude vector is encountered (SDK-bug guard)', async () => {
    mockEmbedDocuments.mockResolvedValue([
      [0, 0, 0],
      [1, 0, 0],
    ]);

    const service = await buildService();
    const docs = [makeDoc(0, 'first content'), makeDoc(1, 'second content')];

    const caught = await service.embedBatch(docs).catch((e: unknown) => e);
    expect(caught).toBeInstanceOf(EmbeddingFailedException);
    expect(caught).toMatchObject({ rejected: 1 });
  });

  it('detects realistic Gemini-magnitude vectors as non-zero and normalizes correctly', async () => {
    // Realistic Gemini text-embedding-004 vectors have tiny per-dimension
    // values (~10^-2 to 10^-1) summing to a magnitude in the 0.05-2.0 range.
    // Construct three 32-dim vectors at different magnitudes within that range.
    const buildGeminiLike = (seed: number): number[] => {
      const dims = 32;
      const out = new Array<number>(dims);
      for (let i = 0; i < dims; i += 1) {
        out[i] = (seed + 1) * (i + 1) * 0.005;
      }
      return out;
    };
    const inputVectors = [buildGeminiLike(0), buildGeminiLike(1), buildGeminiLike(2)];
    const expectedRawMagnitudes = inputVectors.map((v) =>
      Math.sqrt(v.reduce((s, x) => s + x * x, 0)),
    );
    // Sanity: raw magnitudes must be non-zero and in the realistic range.
    expectedRawMagnitudes.forEach((m) => {
      expect(m).toBeGreaterThan(0.05);
      expect(m).toBeLessThan(2.0);
    });

    mockEmbedDocuments.mockResolvedValue(inputVectors);
    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    const service = await buildService();
    const docs = [
      makeDoc(0, 'realistic content one'),
      makeDoc(1, 'realistic content two'),
      makeDoc(2, 'realistic content three'),
    ];

    const vectors = await service.embedBatch(docs);

    expect(vectors).toHaveLength(3);
    vectors.forEach((v) => {
      const magnitude = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
      expect(magnitude).toBeCloseTo(1, 10);
    });
    // Direction preserved: ratios between consecutive dims survive normalization.
    vectors.forEach((v, idx) => {
      const raw = inputVectors[idx];
      const scale = 1 / expectedRawMagnitudes[idx];
      for (let i = 0; i < v.length; i += 1) {
        expect(v[i]).toBeCloseTo(raw[i] * scale, 10);
      }
    });
    const zeroWarn = warnSpy.mock.calls.find((args) =>
      String(args[0]).includes('zero-magnitude vector'),
    );
    expect(zeroWarn).toBeUndefined();

    warnSpy.mockRestore();
  });

  it('treats tiny but non-zero vectors as non-zero (above the 1e-12 magnitudeSquared threshold)', async () => {
    // Each component is 1e-7 → magnitudeSquared = 3 × (1e-7)² = 3e-14.
    // That is BELOW the 1e-12 threshold, so this *would* be treated as zero.
    // Use 1e-6 per component → magnitudeSquared = 3 × (1e-6)² = 3e-12 (above
    // 1e-12) so the helper normalizes it.
    const tinyButNonZero = [1e-6, 1e-6, 1e-6];
    mockEmbedDocuments.mockResolvedValue([tinyButNonZero]);
    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    const service = await buildService();
    const vectors = await service.embedBatch([makeDoc(0, 'tiny but real content')]);

    expect(vectors).toHaveLength(1);
    const magnitude = Math.sqrt(vectors[0].reduce((s, x) => s + x * x, 0));
    expect(magnitude).toBeCloseTo(1, 10);
    // No zero-magnitude warning should fire.
    const zeroWarn = warnSpy.mock.calls.find((args) =>
      String(args[0]).includes('zero-magnitude vector'),
    );
    expect(zeroWarn).toBeUndefined();

    warnSpy.mockRestore();
  });

  it('normalizes a 768-dim Gemini-shaped vector and never logs a zero warning', async () => {
    // Realistic Gemini text-embedding-004 vector: 768 dims, values in roughly
    // [-0.1, +0.1], magnitude ~1.0-2.0. We use Math.sin to produce a stable,
    // non-trivial direction without depending on randomness.
    const fakeGeminiVector = new Array(768).fill(0).map((_, i) => Math.sin(i) * 0.05);
    const rawMagnitude = Math.sqrt(fakeGeminiVector.reduce((s, x) => s + x * x, 0));
    expect(rawMagnitude).toBeGreaterThan(0.1);
    expect(rawMagnitude).toBeLessThan(3);

    mockEmbedDocuments.mockResolvedValueOnce([fakeGeminiVector]);
    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    const service = await buildService();
    const result = await service.embedBatch([makeDoc(0, 'test')]);

    expect(result).toHaveLength(1);
    expect(result[0]).toHaveLength(768);
    const outMag = Math.sqrt(result[0].reduce((s, x) => s + x * x, 0));
    expect(outMag).toBeCloseTo(1.0, 4);
    const zeroWarn = warnSpy.mock.calls.find((args) =>
      String(args[0]).includes('zero-magnitude vector'),
    );
    expect(zeroWarn).toBeUndefined();

    warnSpy.mockRestore();
  });

  it('throws when SDK silently substitutes empty arrays (Array(N).fill([]) bug)', async () => {
    // Simulates the @langchain/google-genai 0.2.x bug where a rejected
    // batchEmbedContents call (e.g. 404 model-not-found) gets converted to
    // an array of empty arrays — losing the real error and silently feeding
    // zero vectors downstream. Our guard converts this to a loud failure.
    mockEmbedDocuments.mockResolvedValue([[], [], []]);

    const service = await buildService();
    const docs = [
      makeDoc(0, 'first prose'),
      makeDoc(1, 'second prose'),
      makeDoc(2, 'third prose'),
    ];

    const caught = await service.embedBatch(docs).catch((e: unknown) => e);
    expect(caught).toBeInstanceOf(EmbeddingFailedException);
    // 3 docs fit in 1 batch (test batch size = 10). Adaptive retry exhausts and
    // throws; Promise.allSettled records it as a single rejected batch.
    expect(caught).toMatchObject({ rejected: 1, total: 1 });
  });

  // ──────────────────────────────────────────────────────────────────
  // Two-layer rate limiting: token bucket + adaptive retry
  // ──────────────────────────────────────────────────────────────────

  it('token bucket enforces minimum interval between sequential requests', async () => {
    // RPM=600 → minIntervalMs=100ms (long enough to measure, short enough for jest).
    mockEmbedDocuments.mockImplementation((texts) => Promise.resolve(texts.map(() => [1, 0])));

    const service = await buildService({
      EMBEDDING_BATCH_SIZE: 10,
      EMBEDDING_CONCURRENCY: 1, // serial → measure interval directly
      EMBEDDING_REQUESTS_PER_MINUTE: 600,
      EMBEDDING_RETRY_MAX_ATTEMPTS: 1,
    });

    const callTimes: number[] = [];
    mockEmbedDocuments.mockImplementation((texts) => {
      callTimes.push(Date.now());
      return Promise.resolve(texts.map(() => [1, 0]));
    });

    const docs = Array.from({ length: 30 }, (_, i) => makeDoc(i)); // 3 batches of 10
    await service.embedBatch(docs);

    expect(callTimes).toHaveLength(3);
    for (let i = 1; i < callTimes.length; i += 1) {
      const gap = callTimes[i] - callTimes[i - 1];
      // Allow generous jitter (-10ms) for timer / event-loop noise on Windows.
      expect(gap).toBeGreaterThanOrEqual(90);
    }
  });

  it('adaptive retry succeeds after a single 429 then a resolved response', async () => {
    const rateLimitError = new Error('429 quota exceeded for project') as Error & {
      status?: number;
    };
    rateLimitError.status = 429;
    mockEmbedDocuments
      .mockRejectedValueOnce(rateLimitError)
      .mockResolvedValueOnce([[0.7, 0.7]]);
    const debugSpy = jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);

    const service = await buildService({
      EMBEDDING_RETRY_MAX_ATTEMPTS: 3,
      EMBEDDING_RETRY_INITIAL_DELAY_MS: 50,
    });
    const result = await service.embedBatch([makeDoc(0, 'one prose')]);

    expect(result).toHaveLength(1);
    expect(mockEmbedDocuments).toHaveBeenCalledTimes(2);
    const retryDebug = debugSpy.mock.calls.find((args) =>
      String(args[0]).includes('Rate-limit error'),
    );
    expect(retryDebug).toBeDefined();

    debugSpy.mockRestore();
  });

  it('adaptive retry throws after max attempts on persistent 429', async () => {
    const rateLimitError = new Error('rate limit exceeded') as Error & { status?: number };
    rateLimitError.status = 429;
    mockEmbedDocuments.mockRejectedValue(rateLimitError);
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);

    const service = await buildService({
      EMBEDDING_RETRY_MAX_ATTEMPTS: 3,
      EMBEDDING_RETRY_INITIAL_DELAY_MS: 20,
      EMBEDDING_RETRY_MAX_DELAY_MS: 50,
    });

    const caught = await service.embedBatch([makeDoc(0, 'persistent 429 prose')]).catch(
      (e: unknown) => e,
    );
    expect(caught).toBeInstanceOf(EmbeddingFailedException);
    expect(mockEmbedDocuments).toHaveBeenCalledTimes(3);
  });

  it('adaptive retry: non-429 errors fail fast without retry', async () => {
    const serverError = new Error('500 internal server error') as Error & { status?: number };
    serverError.status = 500;
    mockEmbedDocuments.mockRejectedValueOnce(serverError);

    const service = await buildService({ EMBEDDING_RETRY_MAX_ATTEMPTS: 5 });
    const caught = await service.embedBatch([makeDoc(0, 'unreachable prose')]).catch(
      (e: unknown) => e,
    );
    expect(caught).toBeInstanceOf(EmbeddingFailedException);
    // Exactly one call: no retry happened because 500 is not transient at this layer.
    expect(mockEmbedDocuments).toHaveBeenCalledTimes(1);
  });

  it('retry delay grows by growth factor up to the max-delay cap', async () => {
    const rateLimitError = new Error('quota exhausted') as Error & { status?: number };
    rateLimitError.status = 429;
    mockEmbedDocuments.mockRejectedValue(rateLimitError);
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);

    const sleepDelays: number[] = [];
    const realSetTimeout = global.setTimeout;
    type SetTimeoutFn = typeof global.setTimeout;
    const fakeSetTimeout: SetTimeoutFn = ((cb: (...args: unknown[]) => void, ms?: number) => {
      if (typeof ms === 'number' && ms >= 50) {
        // Only capture adaptive-retry sleeps (token-bucket sleeps in tests
        // are ≤ minIntervalMs which is 1ms at the default test RPM).
        sleepDelays.push(ms);
      }
      return realSetTimeout(cb, 0);
    }) as unknown as SetTimeoutFn;
    const spy = jest.spyOn(global, 'setTimeout').mockImplementation(fakeSetTimeout);

    const service = await buildService({
      EMBEDDING_RETRY_MAX_ATTEMPTS: 6,
      EMBEDDING_RETRY_INITIAL_DELAY_MS: 100,
      EMBEDDING_RETRY_MAX_DELAY_MS: 400,
      EMBEDDING_RETRY_GROWTH_FACTOR: 1.5,
    });

    await service.embedBatch([makeDoc(0, 'growing delays prose')]).catch(() => undefined);

    // 6 attempts → 5 sleeps. Delays grow 100 → 150 → 225 → 337.5 → 400 (cap).
    expect(sleepDelays).toEqual([100, 150, 225, 337.5, 400]);

    spy.mockRestore();
  });

  // ──────────────────────────────────────────────────────────────────
  // embedQuery — query-side embedding with RETRIEVAL_QUERY task type
  // ──────────────────────────────────────────────────────────────────

  it('embedQuery returns a normalized vector for a valid query', async () => {
    mockEmbedQuery.mockResolvedValueOnce([3, 4]);

    const service = await buildService();
    const result = await service.embedQuery('What is consciousness?');

    expect(result).toHaveLength(2);
    expect(result[0]).toBeCloseTo(0.6, 10);
    expect(result[1]).toBeCloseTo(0.8, 10);
    expect(mockEmbedQuery).toHaveBeenCalledTimes(1);
    expect(mockEmbedQuery).toHaveBeenCalledWith('What is consciousness?');
  });

  it('embedQuery throws EmbeddingFailedException for empty string', async () => {
    const service = await buildService();
    await expect(service.embedQuery('')).rejects.toBeInstanceOf(EmbeddingFailedException);
    expect(mockEmbedQuery).not.toHaveBeenCalled();
  });

  it('embedQuery throws EmbeddingFailedException for whitespace-only query', async () => {
    const service = await buildService();
    await expect(service.embedQuery('   \n\t  ')).rejects.toBeInstanceOf(
      EmbeddingFailedException,
    );
    expect(mockEmbedQuery).not.toHaveBeenCalled();
  });

  it('embedQuery throws EmbeddingFailedException on zero-magnitude vector', async () => {
    mockEmbedQuery.mockResolvedValueOnce([0, 0, 0]);

    const service = await buildService();
    await expect(service.embedQuery('a real question')).rejects.toBeInstanceOf(
      EmbeddingFailedException,
    );
  });

  it('embedQuery produces a vector with magnitude ≈ 1.0 after normalization', async () => {
    // Realistic Gemini-shaped vector: 768 dims, magnitude ~0.5-2.0 before normalize.
    const fakeGeminiVector = new Array(768).fill(0).map((_, i) => Math.sin(i) * 0.05);
    mockEmbedQuery.mockResolvedValueOnce(fakeGeminiVector);

    const service = await buildService();
    const result = await service.embedQuery('relevant question');

    expect(result).toHaveLength(768);
    const magnitude = Math.sqrt(result.reduce((s, x) => s + x * x, 0));
    expect(magnitude).toBeCloseTo(1.0, 6);
  });

  it('embedQuery respects token bucket rate limiting between sequential calls', async () => {
    // RPM=600 → minIntervalMs=100ms.
    const callTimes: number[] = [];
    mockEmbedQuery.mockImplementation(() => {
      callTimes.push(Date.now());
      return Promise.resolve([0.5, 0.5]);
    });

    const service = await buildService({
      EMBEDDING_REQUESTS_PER_MINUTE: 600,
      EMBEDDING_RETRY_MAX_ATTEMPTS: 1,
    });

    await service.embedQuery('first question');
    await service.embedQuery('second question');
    await service.embedQuery('third question');

    expect(callTimes).toHaveLength(3);
    for (let i = 1; i < callTimes.length; i += 1) {
      const gap = callTimes[i] - callTimes[i - 1];
      expect(gap).toBeGreaterThanOrEqual(90);
    }
  });

  it('embedQuery retries on rate-limit error and succeeds on next attempt', async () => {
    const rateLimitError = new Error('429 quota exceeded for project') as Error & {
      status?: number;
    };
    rateLimitError.status = 429;
    mockEmbedQuery
      .mockRejectedValueOnce(rateLimitError)
      .mockResolvedValueOnce([1, 0]);
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);

    const service = await buildService({
      EMBEDDING_RETRY_MAX_ATTEMPTS: 3,
      EMBEDDING_RETRY_INITIAL_DELAY_MS: 30,
    });

    const result = await service.embedQuery('rate-limited question');

    expect(result).toEqual([1, 0]);
    expect(mockEmbedQuery).toHaveBeenCalledTimes(2);
  });
});
