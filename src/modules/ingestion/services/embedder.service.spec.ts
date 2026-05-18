import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { Document } from '@langchain/core/documents';
import { EmbeddingFailedException } from '../../../common/exceptions';
import { EmbedderService } from './embedder.service';

const mockEmbedDocuments = jest.fn<Promise<number[][]>, [string[]]>();

jest.mock('@langchain/google-genai', () => ({
  GoogleGenerativeAIEmbeddings: jest.fn().mockImplementation(() => ({
    embedDocuments: (texts: string[]) => mockEmbedDocuments(texts),
  })),
}));

jest.mock('@google/generative-ai', () => ({
  TaskType: { RETRIEVAL_DOCUMENT: 'RETRIEVAL_DOCUMENT' },
}));

interface ConfigOverrides {
  EMBEDDING_BATCH_SIZE?: number;
  EMBEDDING_CONCURRENCY?: number;
  EMBEDDING_MODEL?: string;
  GOOGLE_API_KEY?: string;
}

function makeConfig(overrides: ConfigOverrides = {}): ConfigService {
  const values: Record<string, unknown> = {
    GOOGLE_API_KEY: 'test-key',
    EMBEDDING_MODEL: 'text-embedding-004',
    EMBEDDING_BATCH_SIZE: 10,
    EMBEDDING_CONCURRENCY: 5,
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
    expect(caught).toMatchObject({ rejected: 3 });
  });
});
