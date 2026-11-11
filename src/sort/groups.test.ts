import { describe, expect, it } from 'vitest';
import { CLIP_DIM, GROUP_BY_ID, GROUPS, makeBank, place, promptList, scoreAll, unitOf, type Examples } from './groups';
import { quantize } from '../pictures/compare';

// Stand-in fingerprints: each group points in its own direction, each sentence a little to the side of it.
function rnd(seed: number) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296 - 0.5; }; }
const r = rnd(3);
// Directions at right angles to each other (Gram–Schmidt), so random overlaps don't blur the test.
const made: Float32Array[] = [];
const randUnit = () => {
  const v = Float32Array.from({ length: CLIP_DIM }, () => r());
  for (const u of made) { let c = 0; for (let d = 0; d < CLIP_DIM; d++) c += v[d] * u[d]; for (let d = 0; d < CLIP_DIM; d++) v[d] -= c * u[d]; }
  const out = unitOf(v);
  made.push(out);
  return out;
};
const mixv = (parts: [number, Float32Array][]) => { const v = new Float32Array(CLIP_DIM); for (const [w, x] of parts) for (let d = 0; d < CLIP_DIM; d++) v[d] += w * x[d]; return v; };
// Built to behave like real CLIP: pictures share an "it's a picture" part and sentences an "it's a sentence" part,
// so a picture and its best sentence are only a little alike (cosine about 0.25, the others about 0.16), pictures of
// the same kind are very alike, and unrelated pictures about 0.55.
const cImg = randUnit();
const cTxt = unitOf(mixv([[0.25, cImg], [0.97, randUnit()]]));
const imgDir = GROUPS.map(() => randUnit());
const txtDir = imgDir.map((d) => unitOf(mixv([[0.3, d], [0.95, randUnit()]])));
const prompts = promptList();
const textEmb = new Float32Array(prompts.length * CLIP_DIM);
prompts.forEach((p, i) => textEmb.set(unitOf(mixv([[0.85, cTxt], [0.5, txtDir[p.g]], [0.05, randUnit()]])), i * CLIP_DIM));
const bank = makeBank(textEmb);
/** A photo looking like a mix of groups. */
const photo = (mix: Record<string, number>) => {
  const g = unitOf(mixv(Object.entries(mix).map(([id, w]) => [w, imgDir[GROUP_BY_ID.get(id)!]] as [number, Float32Array])));
  return quantize(unitOf(mixv([[0.75, cImg], [0.65, g], [0.03, randUnit()]])));
};
const pack = (ps: Int8Array[]) => { const k = new Int8Array(ps.length * CLIP_DIM); ps.forEach((p, i) => k.set(p, i * CLIP_DIM)); return k; };

describe('clean-up groups', () => {
  it('every group has sentences, and each group weighs the same in total', () => {
    expect(GROUPS.every((g) => g.prompts.length >= 3)).toBe(true);
    for (let g = 0; g < GROUPS.length; g++) {
      const sum = [...bank.bias].map((b, i) => (bank.group[i] === g ? Math.exp(b) : 0)).reduce((a, b) => a + b, 0);
      expect(sum).toBeCloseTo(1, 5);
    }
  });

  it('puts a photo in the group whose sentences fit it best, and says how sure', () => {
    const k = pack([photo({ docs: 1 }), photo({ food: 1 }), photo({ people: 1 }), photo({ labels: 0.55, docs: 0.45 })]);
    const { g, p } = scoreAll(k, 4, bank);
    expect([...g].slice(0, 3).map((i) => GROUPS[i].id)).toEqual(['docs', 'food', 'people']);
    expect(p[0]).toBeGreaterThan(0.8);
    expect(['labels', 'docs']).toContain(GROUPS[g[3]].id);
    expect(p[3]).toBeLessThan(p[0]); // a mixed photo is less sure
  });

  it('your fixes pull look-alike photos to the group you chose', () => {
    // photos that look mostly like labels; you said a few like them are documents
    const looks = () => photo({ labels: 0.6, docs: 0.4 });
    const before = scoreAll(pack([looks()]), 1, bank);
    expect(GROUPS[before.g[0]].id).toBe('labels');
    expect(before.p[0]).toBeGreaterThan(0.5);
    const fixes = [looks(), looks(), looks()];
    const ex: Examples = { emb: new Float32Array(fixes.length * CLIP_DIM), group: new Uint8Array(fixes.length).fill(GROUP_BY_ID.get('docs')!), n: fixes.length };
    fixes.forEach((f, i) => ex.emb.set(unitOf(f), i * CLIP_DIM));
    const after = scoreAll(pack([looks(), photo({ food: 1 })]), 2, bank, ex);
    expect(GROUPS[after.g[0]].id).toBe('docs');
    expect(GROUPS[after.g[1]].id).toBe('food'); // a photo that looks nothing like them stays where it was
    // and photos that the AI was already sure about elsewhere don't move
    const sure = scoreAll(pack([photo({ screens: 1 }), photo({ people: 1 })]), 2, bank, ex);
    expect([...sure.g].map((i) => GROUPS[i].id)).toEqual(['screens', 'people']);
  });

  it('sure signals: your fix, a screenshot by its file, a face (but not on a document the AI is sure of)', () => {
    const docs = GROUP_BY_ID.get('docs')!, food = GROUP_BY_ID.get('food')!, people = GROUP_BY_ID.get('people')!, shots = GROUP_BY_ID.get('shots')!;
    expect(place({ g: docs, p: 0.7 }, { fix: food })).toEqual({ g: food, p: 1, why: 'you' });
    expect(place(undefined, { screenshot: true })).toEqual({ g: shots, p: 1, why: 'name' });
    expect(place({ g: food, p: 0.6 }, { face: true })).toEqual({ g: people, p: 0.9, why: 'face' });
    expect(place({ g: docs, p: 0.6 }, { face: true })).toEqual({ g: people, p: 0.9, why: 'face' }); // not sure it's a document: People
    expect(place({ g: docs, p: 0.95 }, { face: true })).toEqual({ g: docs, p: 0.95, why: 'ai' }); // an ID card has a face too
    expect(place(undefined, {})).toBeUndefined();
  });
});
