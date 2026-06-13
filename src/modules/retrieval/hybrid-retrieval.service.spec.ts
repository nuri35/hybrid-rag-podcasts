import { Logger } from '@nestjs/common';
import { RrfFusionService } from '../fusion/rrf-fusion.service';
import { HybridRetrievalService } from './hybrid-retrieval.service';
import { SOURCE_TOP_K } from './hybrid-retrieval.constants';
import { selectRetriever } from '../qa/retriever.provider';
import type { RetrievedChunk } from './retrieval.types';

function chunk(id: string, score = 0.9): RetrievedChunk {
  return { id, document: `doc-${id}`, score, metadata: { episode_id: '1' }, chunkIndex: 0 };
}
function list(prefix: string, n: number): RetrievedChunk[] {
  return Array.from({ length: n }, (_, i) => chunk(`${prefix}${i}`));
}

interface VectorMock {
  retrieve: jest.Mock;
}
interface EsMock {
  search: jest.Mock;
}
interface ExpansionMock {
  expand: jest.Mock;
}

/** Config mock toggling NEIGHBOR_EXPANSION_ENABLED. */
function cfg(expansionEnabled: boolean): never {
  return { get: jest.fn().mockReturnValue(expansionEnabled) } as never;
}

describe('HybridRetrievalService', () => {
  let service: HybridRetrievalService;
  let vector: VectorMock;
  let es: EsMock;
  let fusion: RrfFusionService;
  let neighborExpansion: ExpansionMock;
  let logSpy: jest.SpyInstance;
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    vector = { retrieve: jest.fn() };
    es = { search: jest.fn() };
    fusion = new RrfFusionService();
    neighborExpansion = { expand: jest.fn() };
    // Existing fusion/degradation tests assert the RAW fused output, so build
    // with expansion DISABLED here; the expansion wiring has its own describe.
    service = new HybridRetrievalService(
      vector as never,
      es as never,
      fusion,
      neighborExpansion as never,
      cfg(false),
    );
    logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  it('1. happy path — both return 10, fusion called with both lists, returns top-5', async () => {
    const vHits = list('v', 10);
    const eHits = list('e', 10);
    vector.retrieve.mockResolvedValue(vHits);
    es.search.mockResolvedValue(eHits);
    const fuseSpy = jest.spyOn(fusion, 'fuse');

    const out = await service.retrieve('Turing machine');

    expect(out).toHaveLength(5); // FUSION_OUTPUT_TOP_K default
    expect(fuseSpy).toHaveBeenCalledWith(vHits, eHits, 5);
    // each source asked for SOURCE_TOP_K
    expect(vector.retrieve).toHaveBeenCalledWith('Turing machine', { topK: SOURCE_TOP_K });
    expect(es.search).toHaveBeenCalledWith('Turing machine', SOURCE_TOP_K);
  });

  it('2. ES rejects → vector-only order survives, warns, degraded=es', async () => {
    const vHits = list('v', 3);
    vector.retrieve.mockResolvedValue(vHits);
    es.search.mockRejectedValue(new Error('boom-es'));

    const out = await service.retrieve('q', { topK: 5 });

    expect(out.map((c) => c.id)).toEqual(['v0', 'v1', 'v2']);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('hybrid_es_failed'));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('degraded=es'));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('es_hits=0'));
  });

  it('3. vector rejects → keyword-only order survives, degraded=vector', async () => {
    const eHits = list('e', 4);
    vector.retrieve.mockRejectedValue(new Error('boom-vec'));
    es.search.mockResolvedValue(eHits);

    const out = await service.retrieve('q');

    expect(out.map((c) => c.id)).toEqual(['e0', 'e1', 'e2', 'e3']);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('hybrid_vector_failed'));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('degraded=vector'));
  });

  it('4. both reject → [], degraded=both', async () => {
    vector.retrieve.mockRejectedValue(new Error('boom-vec'));
    es.search.mockRejectedValue(new Error('boom-es'));

    const out = await service.retrieve('q');

    expect(out).toEqual([]);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('degraded=both'));
  });

  it('5. parallelism — both sources dispatched before either resolves', async () => {
    let resolveVector!: (v: RetrievedChunk[]) => void;
    let resolveEs!: (v: RetrievedChunk[]) => void;
    vector.retrieve.mockReturnValue(new Promise((r) => (resolveVector = r)));
    es.search.mockReturnValue(new Promise((r) => (resolveEs = r)));

    const pending = service.retrieve('q');

    // Both called synchronously, before EITHER promise settles → true parallel.
    expect(vector.retrieve).toHaveBeenCalledTimes(1);
    expect(es.search).toHaveBeenCalledTimes(1);

    resolveVector(list('v', 2));
    resolveEs(list('e', 2));
    await expect(pending).resolves.toHaveLength(4);
  });

  it('6. overlap reported when a chunk appears in both lists', async () => {
    // shared id 'x' in both → overlap=1, union=3
    vector.retrieve.mockResolvedValue([chunk('x'), chunk('v1')]);
    es.search.mockResolvedValue([chunk('x', 20), chunk('e1', 18)]);

    await service.retrieve('q');

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('overlap=1'));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('fused_unique=3'));
  });

  it('7. topK is passed through to fusion', async () => {
    vector.retrieve.mockResolvedValue(list('v', 10));
    es.search.mockResolvedValue(list('e', 10));
    const fuseSpy = jest.spyOn(fusion, 'fuse');

    const out = await service.retrieve('q', { topK: 3 });

    expect(fuseSpy).toHaveBeenCalledWith(expect.anything(), expect.anything(), 3);
    expect(out).toHaveLength(3);
  });

  describe('neighbor expansion wiring (Phase 4 enhancement)', () => {
    function build(expansionEnabled: boolean): HybridRetrievalService {
      return new HybridRetrievalService(
        vector as never,
        es as never,
        fusion,
        neighborExpansion as never,
        cfg(expansionEnabled),
      );
    }

    it('9. toggle OFF → expand NOT called, fused top-5 returned as-is', async () => {
      const svc = build(false);
      vector.retrieve.mockResolvedValue(list('v', 10));
      es.search.mockResolvedValue(list('e', 10));

      const out = await svc.retrieve('q');

      expect(neighborExpansion.expand).not.toHaveBeenCalled();
      expect(out).toHaveLength(5);
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('expanded=false'));
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('neighbors_added=0'));
    });

    it('toggle ON → expand called with the fused list, its result is returned', async () => {
      const svc = build(true);
      const vHits = list('v', 10);
      const eHits = list('e', 10);
      vector.retrieve.mockResolvedValue(vHits);
      es.search.mockResolvedValue(eHits);
      const fuseSpy = jest.spyOn(fusion, 'fuse');
      // expansion injects two neighbor chunks (ids NOT in the fused set)
      neighborExpansion.expand.mockImplementation((fused: RetrievedChunk[]) =>
        Promise.resolve([...fused, chunk('neighborA', 0), chunk('neighborB', 0)]),
      );

      const out = await svc.retrieve('q');

      const fusedArg = fuseSpy.mock.results[0].value as RetrievedChunk[];
      expect(neighborExpansion.expand).toHaveBeenCalledWith(fusedArg);
      expect(out.map((c) => c.id)).toContain('neighborA');
      expect(out).toHaveLength(7); // 5 fused + 2 neighbors
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('expanded=true'));
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('chunks_before=5'));
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('chunks_after=7'));
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('neighbors_added=2'));
    });
  });
});

describe('selectRetriever (toggle seam)', () => {
  const vector = { id: 'vector' } as never;
  const hybrid = { id: 'hybrid' } as never;
  const cfg = (enabled: boolean) => ({ get: jest.fn().mockReturnValue(enabled) }) as never;

  it('flag true → HybridRetrievalService', () => {
    expect(selectRetriever(cfg(true), vector, hybrid)).toBe(hybrid);
  });

  it('flag false → legacy VectorRetrieverService (hybrid/ES never reached)', () => {
    expect(selectRetriever(cfg(false), vector, hybrid)).toBe(vector);
  });
});
