import { Logger } from '@nestjs/common';
import { NeighborExpansionService } from './neighbor-expansion.service';
import type { ChromaDocument } from '../vector-store/chroma.repository';
import type { RetrievedChunk } from './retrieval.types';

/** Split `{episode}_chunk_{idx}` (right-anchored so episode ids may have `_`). */
function parse(id: string): { episodeId: string; index: number } {
  const m = /^(.+)_chunk_(\d+)$/.exec(id);
  if (m === null) throw new Error(`bad test id ${id}`);
  return { episodeId: m[1], index: Number(m[2]) };
}

/** A fused parent chunk (carries a real RRF-ish score). */
function rc(id: string, score = 0.5): RetrievedChunk {
  const { episodeId, index } = parse(id);
  return {
    id,
    document: `doc-${id}`,
    score,
    metadata: { episode_id: episodeId, chunk_index: index },
    chunkIndex: index,
  };
}

/** What Chroma `getByIds` returns for an existing id. */
function chromaDoc(id: string): ChromaDocument {
  const { episodeId, index } = parse(id);
  return { id, document: `doc-${id}`, metadata: { episode_id: episodeId, chunk_index: index } };
}

interface RepoMock {
  getByIds: jest.Mock;
}

describe('NeighborExpansionService', () => {
  let service: NeighborExpansionService;
  let repo: RepoMock;
  let warnSpy: jest.SpyInstance;

  /**
   * Wire `getByIds` to return only the ids in `existing` (simulates Chroma
   * omitting non-existent ids), preserving the requested-vs-returned contract.
   */
  function withExisting(...existing: string[]): void {
    const set = new Set(existing);
    repo.getByIds.mockImplementation((ids: string[]) =>
      Promise.resolve(ids.filter((id) => set.has(id)).map(chromaDoc)),
    );
  }

  beforeEach(() => {
    repo = { getByIds: jest.fn() };
    service = new NeighborExpansionService(repo as never);
    warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  it('1. basic — parent 306 pulls 305 and 307, placed adjacent in index order', async () => {
    withExisting('269_chunk_305', '269_chunk_307');

    const out = await service.expand([rc('269_chunk_306', 0.9)]);

    expect(out.map((c) => c.id)).toEqual(['269_chunk_305', '269_chunk_306', '269_chunk_307']);
    // parent keeps its score; injected neighbors get the 0 sentinel
    expect(out.find((c) => c.id === '269_chunk_306')?.score).toBe(0.9);
    expect(out.find((c) => c.id === '269_chunk_305')?.score).toBe(0);
    expect(out.find((c) => c.id === '269_chunk_307')?.score).toBe(0);
  });

  it('2. split-sentence ordering — [306, 302] → 305,306,307 contiguous, 306 immediately followed by 307', async () => {
    withExisting('269_chunk_305', '269_chunk_307', '269_chunk_301', '269_chunk_303');

    const out = await service.expand([rc('269_chunk_306'), rc('269_chunk_302')]);
    const ids = out.map((c) => c.id);

    expect(ids).toEqual([
      '269_chunk_305',
      '269_chunk_306',
      '269_chunk_307',
      '269_chunk_301',
      '269_chunk_302',
      '269_chunk_303',
    ]);
    // THE q017 adjacency proof: 306 is immediately followed by 307 → the
    // sentence split across the 306|307 boundary is reassembled contiguously.
    const i306 = ids.indexOf('269_chunk_306');
    const i307 = ids.indexOf('269_chunk_307');
    expect(i307).toBe(i306 + 1);
  });

  it('3. dedup — a chunk that is both a parent and another parent’s neighbor appears once (first occurrence)', async () => {
    // 307 is a parent AND 306's next-neighbor.
    withExisting('269_chunk_305', '269_chunk_308');

    const out = await service.expand([rc('269_chunk_306'), rc('269_chunk_307')]);
    const ids = out.map((c) => c.id);

    expect(ids).toEqual(['269_chunk_305', '269_chunk_306', '269_chunk_307', '269_chunk_308']);
    expect(ids.filter((id) => id === '269_chunk_307')).toHaveLength(1);
    // 307 kept its FIRST occurrence — as a parent (score preserved), not re-emitted as a neighbor.
    expect(out.find((c) => c.id === '269_chunk_307')?.score).toBe(0.5);
  });

  it('4. cap — 5 disjoint parents (15 chunks) truncate to exactly 12 from the end', async () => {
    const parents = ['1', '2', '3', '4', '5'].map((ep) => rc(`${ep}_chunk_5`));
    // every neighbor exists
    withExisting(...['1', '2', '3', '4', '5'].flatMap((ep) => [`${ep}_chunk_4`, `${ep}_chunk_6`]));

    const out = await service.expand(parents);

    expect(out).toHaveLength(12);
    // highest-rank groups survive; the lowest-rank (5th) group drops entirely
    expect(out.map((c) => c.id)).not.toContain('5_chunk_5');
    expect(out.map((c) => c.id)).not.toContain('5_chunk_4');
    expect(out.map((c) => c.id)).not.toContain('5_chunk_6');
    // groups 1..4 are fully present
    expect(out.map((c) => c.id)).toContain('4_chunk_6');
  });

  it('5. boundary (last chunk) — missing +1 is skipped, only -1 added, no error', async () => {
    withExisting('269_chunk_305'); // 307 absent → 306 behaves as last chunk

    const out = await service.expand([rc('269_chunk_306')]);

    expect(out.map((c) => c.id)).toEqual(['269_chunk_305', '269_chunk_306']);
  });

  it('6. boundary (first chunk) — chunk_0 has no -1, only +1 requested', async () => {
    withExisting('269_chunk_1');

    const out = await service.expand([rc('269_chunk_0')]);

    expect(out.map((c) => c.id)).toEqual(['269_chunk_0', '269_chunk_1']);
    // never asks for the nonsensical chunk_-1
    const requested = repo.getByIds.mock.calls[0][0];
    expect(requested).toEqual(['269_chunk_1']);
    expect(requested).not.toContain('269_chunk_-1');
  });

  it('7. neighbor absent in Chroma — skipped silently (parent survives alone)', async () => {
    withExisting(); // nothing exists

    const out = await service.expand([rc('269_chunk_306')]);

    expect(out.map((c) => c.id)).toEqual(['269_chunk_306']);
  });

  it('8. cross-episode safety — neighbors computed per-episode only, never across episode_id', async () => {
    withExisting('5_chunk_9', '5_chunk_11', '6_chunk_10', '6_chunk_12');

    await service.expand([rc('5_chunk_10'), rc('6_chunk_11')]);

    const requested = new Set(repo.getByIds.mock.calls[0][0]);
    expect(requested).toEqual(new Set(['5_chunk_9', '5_chunk_11', '6_chunk_10', '6_chunk_12']));
    // adjacency by index NEVER crosses episodes (no 5_chunk_11 attributed to ep 6, etc.)
  });

  it('9. parses episode ids that contain underscores (collision-disambiguated `14_0`)', async () => {
    withExisting('14_0_chunk_4', '14_0_chunk_6');

    const out = await service.expand([rc('14_0_chunk_5')]);

    expect(out.map((c) => c.id)).toEqual(['14_0_chunk_4', '14_0_chunk_5', '14_0_chunk_6']);
  });

  it('10. batch fetch — Chroma getByIds is called exactly ONCE, never per-chunk', async () => {
    withExisting('269_chunk_305', '269_chunk_307', '269_chunk_301', '269_chunk_303');

    await service.expand([rc('269_chunk_306'), rc('269_chunk_302')]);

    expect(repo.getByIds).toHaveBeenCalledTimes(1);
  });

  it('graceful — a Chroma fetch error degrades to the un-expanded input, warns', async () => {
    repo.getByIds.mockRejectedValue(new Error('chroma down'));

    const out = await service.expand([rc('269_chunk_306')]);

    expect(out.map((c) => c.id)).toEqual(['269_chunk_306']);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('neighbor_fetch_failed'));
  });

  it('empty input — returns [] with no Chroma round trip', async () => {
    const out = await service.expand([]);
    expect(out).toEqual([]);
    expect(repo.getByIds).not.toHaveBeenCalled();
  });
});
