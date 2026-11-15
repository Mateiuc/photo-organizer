import fs from 'node:fs';
import { createHash } from 'node:crypto';
import sentences from './sentences.json';
import { describe, expect, it } from 'vitest';
import { choose, AI_DIM, PROMPTS_VERSION, GROUP_BY_ID, GROUPS, JUNK_SURE, makeBank, place, promptList, scoreAll, unitOf, type Examples } from './groups';
import { quantize } from '../pictures/compare';

// Stand-in fingerprints: each group points in its own direction, each sentence a little to the side of it.
function rnd(seed: number) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296 - 0.5; }; }
const r = rnd(3);
// Directions at right angles to each other (Gram–Schmidt), so random overlaps don't blur the test.
const made: Float32Array[] = [];
const randUnit = () => {
  const v = Float32Array.from({ length: AI_DIM }, () => r());
  for (const u of made) { let c = 0; for (let d = 0; d < AI_DIM; d++) c += v[d] * u[d]; for (let d = 0; d < AI_DIM; d++) v[d] -= c * u[d]; }
  const out = unitOf(v);
  made.push(out);
  return out;
};
const mixv = (parts: [number, Float32Array][]) => { const v = new Float32Array(AI_DIM); for (const [w, x] of parts) for (let d = 0; d < AI_DIM; d++) v[d] += w * x[d]; return v; };
// Built to behave like real CLIP: pictures share an "it's a picture" part and sentences an "it's a sentence" part,
// so a picture and its best sentence are only a little alike (cosine about 0.25, the others about 0.16), pictures of
// the same kind are very alike, and unrelated pictures about 0.55.
const cImg = randUnit();
const cTxt = unitOf(mixv([[0.25, cImg], [0.97, randUnit()]]));
const imgDir = GROUPS.map(() => randUnit());
const txtDir = imgDir.map((d) => unitOf(mixv([[0.3, d], [0.95, randUnit()]])));
const prompts = promptList();
const textEmb = new Float32Array(prompts.length * AI_DIM);
prompts.forEach((p, i) => textEmb.set(unitOf(mixv([[0.85, cTxt], [0.5, txtDir[p.g]], [0.05, randUnit()]])), i * AI_DIM));
const bank = makeBank(textEmb);
/** A photo looking like a mix of groups. */
const photo = (mix: Record<string, number>) => {
  const g = unitOf(mixv(Object.entries(mix).map(([id, w]) => [w, imgDir[GROUP_BY_ID.get(id)!]] as [number, Float32Array])));
  return quantize(unitOf(mixv([[0.75, cImg], [0.65, g], [0.03, randUnit()]])));
};
const pack = (ps: Int8Array[]) => { const k = new Int8Array(ps.length * AI_DIM); ps.forEach((p, i) => k.set(p, i * AI_DIM)); return k; };

describe('clean-up groups', () => {
  it('every group the AI picks from has sentences, and each weighs the same in total', () => {
    expect(GROUPS.filter((g) => g.side !== 'whatsapp').every((g) => g.prompts.length >= 3)).toBe(true);
    expect(GROUPS.find((g) => g.side === 'whatsapp')!.prompts).toEqual([]); // known from the name, never from the AI
    for (let g = 0; g < GROUPS.length; g++) {
      if (!GROUPS[g].prompts.length) continue;
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
    const ex: Examples = { emb: new Float32Array(fixes.length * AI_DIM), group: new Uint8Array(fixes.length).fill(GROUP_BY_ID.get('docs')!), n: fixes.length };
    fixes.forEach((f, i) => ex.emb.set(unitOf(f), i * AI_DIM));
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
    const wa = GROUP_BY_ID.get('whatsapp')!;
    expect(place({ g: people, p: 0.9 }, { whatsapp: true, face: true })).toEqual({ g: wa, p: 1, why: 'name' }); // WhatsApp kept apart
    expect(place({ g: docs, p: 0.9 }, { whatsapp: true, fix: food })).toEqual({ g: food, p: 1, why: 'you' }); // your fix still wins
    expect(place(undefined, { whatsapp: true })).toEqual({ g: wa, p: 1, why: 'name' }); // even before the AI looked at it
  });
});

describe('camera photos and unsure guesses', () => {
  const G = GROUPS.length;
  const id = (x: string) => GROUP_BY_ID.get(x)!;
  const probs = (parts: Record<string, number>) => { const a = new Float32Array(G); for (const [k, v] of Object.entries(parts)) a[id(k)] = v; return a; };
  it('a photo with camera information never goes to Screenshots: the next most likely group, counted among the rest', () => {
    const pr = probs({ shots: 0.42, lights: 0.3, other: 0.2, docs: 0.08 });
    expect(choose(pr, false)).toEqual({ g: id('shots'), p: expect.closeTo(0.42, 5) });
    const c = choose(pr, true);
    expect(c.g).toBe(id('lights'));
    expect(c.p).toBeCloseTo(0.3 / 0.58, 5);
    expect(place({ g: id('shots'), p: 0.42, probs: pr }, { camera: true })).toMatchObject({ g: id('lights'), why: 'ai' });
    expect(place({ g: id('shots'), p: 0.42, probs: pr }, { camera: false })).toMatchObject({ g: id('other'), why: 'unsure', guess: id('shots') });
  });
  it('a junk group only gets photos the AI is at least 50% sure about; the rest go to Everything else, marked not sure', () => {
    expect(JUNK_SURE).toBe(0.5);
    const unsure = place({ g: id('screens'), p: 0.41, probs: probs({ screens: 0.41, other: 0.3, wires: 0.29 }) }, {});
    expect(unsure).toEqual({ g: id('other'), p: expect.closeTo(0.41, 5), why: 'unsure', guess: id('screens') });
    expect(place({ g: id('screens'), p: 0.6, probs: probs({ screens: 0.6, other: 0.4 }) }, {})).toMatchObject({ g: id('screens'), why: 'ai' });
    // keep groups don't need 50%
    expect(place({ g: id('wires'), p: 0.35, probs: probs({ wires: 0.35, other: 0.33, food: 0.32 }) }, {})).toMatchObject({ g: id('wires'), why: 'ai' });
    // a screenshot known from its file name stays a screenshot
    expect(place(undefined, { screenshot: true, camera: true })).toMatchObject({ g: id('shots'), why: 'name' });
  });
  it('a photo the AI calls a document, label or screen photo, but whose tags show something worth keeping, goes to Everything else as mixed', () => {
    const sure = probs({ docs: 0.97, other: 0.03 });
    expect(place({ g: id('docs'), p: 0.97, probs: sure }, {})).toMatchObject({ g: id('docs'), why: 'ai' });
    expect(place({ g: id('docs'), p: 0.97, probs: sure }, { keepSign: true })).toEqual({ g: id('other'), p: expect.closeTo(0.97, 5), why: 'mixed', guess: id('docs') });
    for (const g of ['labels', 'screens']) expect(place({ g: id(g), p: 0.9, probs: probs({ [g]: 0.9, other: 0.1 }) }, { keepSign: true })).toMatchObject({ g: id('other'), why: 'mixed', guess: id(g) });
    // a screenshot of a photo of people is still a screenshot
    expect(place({ g: id('shots'), p: 0.9, probs: probs({ shots: 0.9, other: 0.1 }) }, { keepSign: true })).toMatchObject({ g: id('shots'), why: 'ai' });
    // keep groups, scan-tool screens (your call) and your own fixes are not touched
    expect(place({ g: id('wires'), p: 0.9, probs: probs({ wires: 0.9, other: 0.1 }) }, { keepSign: true })).toMatchObject({ g: id('wires'), why: 'ai' });
    expect(place({ g: id('scantool'), p: 0.9, probs: probs({ scantool: 0.9, other: 0.1 }) }, { keepSign: true })).toMatchObject({ g: id('scantool'), why: 'ai' });
    expect(place({ g: id('docs'), p: 0.97, probs: sure }, { keepSign: true, fix: id('docs') })).toMatchObject({ g: id('docs'), why: 'you' });
  });
  it('has a Thermal camera group on the keep side, and colored rooms and plane views have sentences', () => {
    expect(GROUPS[id('thermal')].side).toBe('keep');
    expect(GROUPS[id('lights')].prompts.some((p) => p.includes('colored lighting'))).toBe(true);
    expect(GROUPS[id('other')].prompts.some((p) => p.includes('airplane window'))).toBe(true);
  });
});

describe('the sentence fingerprints that come with the app', () => {
  it('were made from the sentences as they are now (else run `npm run sentences`)', () => {
    const texts = promptList().map((p) => p.text);
    expect(sentences.hash).toBe(createHash('sha256').update(JSON.stringify(texts)).digest('hex'));
    expect(sentences.version).toBe(PROMPTS_VERSION);
    expect(fs.statSync(`public/ai/sentences-${PROMPTS_VERSION}.bin`).size).toBe(texts.length * AI_DIM * 4);
  });
});
