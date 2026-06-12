import { RrfFusionService } from './rrf-fusion.service';
import { FUSION_OUTPUT_TOP_K, RRF_K } from './rrf-fusion.constants';
import type { RetrievedChunk } from '../retrieval/retrieval.types';

/** Build a RetrievedChunk. `score` is intentionally NOT an RRF score so tests
 *  can prove fusion overwrites it. Vector-ish (≤1) vs keyword-ish (BM25 ~20). */
function chunk(id: string, score = 0.9): RetrievedChunk {
  return { id, document: `doc-${id}`, score, metadata: { episode_id: id.split('_')[0] }, chunkIndex: 0 };
}

describe('RrfFusionService', () => {
  let service: RrfFusionService;

  beforeEach(() => {
    service = new RrfFusionService();
  });

  it('1. hand-calculated exactness — order and scores', () => {
    const vector = [chunk('A'), chunk('B'), chunk('C')];
    const keyword = [chunk('X', 20), chunk('A', 18), chunk('B', 15)];

    const out = service.fuse(vector, keyword, 10);

    // A = 1/61 + 1/62, B = 1/62 + 1/63, X = 1/61, C = 1/63
    const A = 1 / 61 + 1 / 62;
    const B = 1 / 62 + 1 / 63;
    const X = 1 / 61;
    const C = 1 / 63;

    expect(out.map((c) => c.id)).toEqual(['A', 'B', 'X', 'C']);
    expect(out[0].score).toBeCloseTo(A, 6); // ≈ 0.032523
    expect(out[1].score).toBeCloseTo(B, 6); // ≈ 0.032003
    expect(out[2].score).toBeCloseTo(X, 6); // ≈ 0.016393
    expect(out[3].score).toBeCloseTo(C, 6); // ≈ 0.015873
  });

  it('2. both-lists agreement beats a single-list higher rank (q014 rescue)', () => {
    // D: keyword #8 (idx7) + vector #6 (idx5) → 1/68 + 1/66 ≈ 0.029857
    // E: keyword #2 (idx1) only                → 1/62        ≈ 0.016129
    const vector = [chunk('v1'), chunk('v2'), chunk('v3'), chunk('v4'), chunk('v5'), chunk('D')];
    const keyword = [
      chunk('k1', 20), chunk('E', 19), chunk('k3', 18), chunk('k4', 17),
      chunk('k5', 16), chunk('k6', 15), chunk('k7', 14), chunk('D', 13),
    ];

    const out = service.fuse(vector, keyword, 20);
    const ids = out.map((c) => c.id);

    expect(ids.indexOf('D')).toBeLessThan(ids.indexOf('E'));
    const D = out.find((c) => c.id === 'D')!;
    const E = out.find((c) => c.id === 'E')!;
    expect(D.score).toBeCloseTo(1 / 66 + 1 / 68, 6);
    expect(E.score).toBeCloseTo(1 / 62, 6);
    expect(D.score).toBeGreaterThan(E.score);
  });

  it('3. empty keyword list (ES-down) → vector order, RRF-rescored, no error', () => {
    const vector = [chunk('A'), chunk('B'), chunk('C')];

    const out = service.fuse(vector, [], 10);

    expect(out.map((c) => c.id)).toEqual(['A', 'B', 'C']);
    expect(out[0].score).toBeCloseTo(1 / 61, 6);
    expect(out[1].score).toBeCloseTo(1 / 62, 6);
    expect(out[2].score).toBeCloseTo(1 / 63, 6);
  });

  it('4. empty vector list → keyword order, RRF-rescored (symmetric)', () => {
    const keyword = [chunk('X', 20), chunk('Y', 18)];

    const out = service.fuse([], keyword, 10);

    expect(out.map((c) => c.id)).toEqual(['X', 'Y']);
    expect(out[0].score).toBeCloseTo(1 / 61, 6);
    expect(out[1].score).toBeCloseTo(1 / 62, 6);
  });

  it('5. both lists empty → []', () => {
    expect(service.fuse([], [])).toEqual([]);
  });

  it('6. dedup — a chunk in both lists appears exactly once', () => {
    const vector = [chunk('A'), chunk('B')];
    const keyword = [chunk('A', 20), chunk('C', 18)];

    const out = service.fuse(vector, keyword, 10);

    expect(out.filter((c) => c.id === 'A')).toHaveLength(1);
    expect(out.map((c) => c.id).sort()).toEqual(['A', 'B', 'C']);
  });

  it('7. topK respected — 10 unique in, topK=5 → exactly 5 out', () => {
    const vector = Array.from({ length: 10 }, (_, i) => chunk(`c${i}`));

    const out = service.fuse(vector, [], 5);

    expect(out).toHaveLength(5);
    expect(out.map((c) => c.id)).toEqual(['c0', 'c1', 'c2', 'c3', 'c4']);
  });

  it('8. tie-break determinism — equal RRF score → ascending id, stable across runs', () => {
    // P (vector #1) and Q (keyword #1) both score 1/61, both listCount 1.
    // Tie-break: equal listCount → ascending lexicographic id → 'aaa' before 'zzz'.
    const vector = [chunk('aaa')];
    const keyword = [chunk('zzz', 20)];

    const first = service.fuse(vector, keyword, 10).map((c) => c.id);
    const second = service.fuse(vector, keyword, 10).map((c) => c.id);

    expect(first).toEqual(['aaa', 'zzz']);
    expect(second).toEqual(first); // deterministic
  });

  it('9. output score field carries RRF scores (all < 1, descending)', () => {
    const vector = [chunk('A', 0.95), chunk('B', 0.9)];
    const keyword = [chunk('A', 25), chunk('X', 22)];

    const out = service.fuse(vector, keyword, 10);

    for (const c of out) {
      expect(c.score).toBeLessThan(1); // not the cosine 0.95 nor BM25 25
    }
    const scores = out.map((c) => c.score);
    expect(scores).toEqual([...scores].sort((a, b) => b - a)); // descending
    // The largest possible single contribution is 1/(RRF_K+1).
    expect(out[0].score).toBeLessThanOrEqual(2 / (RRF_K + 1));
  });

  it('10. input arrays and chunk objects are not mutated', () => {
    const vector = [chunk('A', 0.95), chunk('B', 0.9)];
    const keyword = [chunk('A', 25), chunk('X', 22)];
    const vectorSnapshot = vector.map((c) => ({ ...c }));
    const keywordSnapshot = keyword.map((c) => ({ ...c }));

    service.fuse(vector, keyword, 10);

    expect(vector).toEqual(vectorSnapshot); // order + scores untouched
    expect(keyword).toEqual(keywordSnapshot);
    expect(vector[0].score).toBe(0.95);
    expect(keyword[0].score).toBe(25);
  });

  it('uses documented defaults (FUSION_OUTPUT_TOP_K, RRF_K)', () => {
    expect(FUSION_OUTPUT_TOP_K).toBe(5);
    expect(RRF_K).toBe(60);
    // default topK = FUSION_OUTPUT_TOP_K
    const vector = Array.from({ length: 8 }, (_, i) => chunk(`c${i}`));
    expect(service.fuse(vector, [])).toHaveLength(5);
  });
});
