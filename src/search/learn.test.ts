import { describe, expect, it } from 'vitest';
import { learnScores, rng, unit } from './learn';
import { marksSig, members, type Topic } from './topics';

/** n fingerprints of `dim` numbers: the first `a` near one direction, the next `b` near another, the rest random. */
function data(n: number, a: number, b: number, dim = 64, seed = 3) {
  const r = rng(seed);
  const ca = Array.from({ length: dim }, () => r() - 0.5), cb = Array.from({ length: dim }, () => r() - 0.5);
  const emb = new Int8Array(n * dim);
  for (let i = 0; i < n; i++) {
    const c = i < a ? ca : i < a + b ? cb : null;
    for (let d = 0; d < dim; d++) emb[i * dim + d] = Math.max(-127, Math.min(127, Math.round(((c ? c[d] * 2 : 0) + (r() - 0.5)) * 60)));
  }
  return emb;
}

describe('learning from marks', () => {
  it('makes unit-length vectors', () => {
    const u = unit(new Int8Array([3, 4, 0, 0, 0, 0]), 2, 3);
    expect(Math.hypot(u[0], u[1], u[2])).toBeCloseTo(1);
    expect([...u.slice(3)]).toEqual([0, 0, 0]);
  });

  it('ranks photos like the Yes ones first, and keeps photos like the No ones low', () => {
    const n = 600, a = 40, b = 40, dim = 64;
    const emb = data(n, a, b, dim);
    const yes = [0, 1, 2, 3, 4], no = [a, a + 1, a + 2];
    const s = learnScores({ emb, n, yes, no, dim });
    const rest = [...Array(n).keys()].filter((i) => !yes.includes(i) && !no.includes(i)).sort((x, y) => s[y] - s[x]);
    const top = rest.slice(0, a - yes.length);
    expect(top.filter((i) => i < a).length).toBeGreaterThanOrEqual(top.length - 2);
    const bScores = rest.filter((i) => i >= a && i < a + b).map((i) => s[i]);
    expect(Math.max(...bScores)).toBeLessThan(0.5);
  });

  it('gives the same answer for the same marks', () => {
    const emb = data(200, 20, 20, 32);
    const one = learnScores({ emb, n: 200, yes: [0, 1, 2], no: [], dim: 32, seed: 7 });
    const two = learnScores({ emb, n: 200, yes: [0, 1, 2], no: [], dim: 32, seed: 7 });
    expect([...one]).toEqual([...two]);
  });
});

describe('topic members', () => {
  const base: Topic = { id: 'vin', name: 'VIN', queries: ['VIN'], keys: ['a', 'b', 'c'] };
  it('uses Google results until something is learned, leaving out No marks', () => {
    expect(members({ ...base, no: ['gp:b'] })).toEqual(['gp:a', 'gp:c']);
  });
  it('after learning: Yes photos, then matches at least as sure as asked, never No photos', () => {
    const t: Topic = { ...base, yes: ['x'], no: ['y'], found: ['y', 'z', 'gp:a', 'w'], foundP: [0.9, 0.8, 0.6, 0.3], learnedAt: '2026-11-10' };
    expect(members(t)).toEqual(['x', 'z', 'gp:a']);
    expect(members({ ...t, sure: 0.2 })).toEqual(['x', 'z', 'gp:a', 'w']);
    expect(members({ ...t, onlyGoogle: true })).toEqual(['x', 'gp:a']);
  });
  it('notices when the marks change', () => {
    expect(marksSig({ yes: ['a', 'b'], no: [] })).toBe(marksSig({ yes: ['b', 'a'] }));
    expect(marksSig({ yes: ['a'] })).not.toBe(marksSig({ yes: ['a'], no: ['b'] }));
  });
});
