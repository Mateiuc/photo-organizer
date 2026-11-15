import fs from 'node:fs';
import { createHash } from 'node:crypto';
import made from './tags.json';
import { describe, expect, it } from 'vitest';
import { quantize } from '../pictures/compare';
import { AI_DIM, unitOf } from './groups';
import { hasTag, makeTagBank, TAG_BY_ID, tagAll, TAGS, TAGS_VERSION, tagScores, tagSentences, tagsIn } from './tags';

// Stand-in fingerprints: every tag points in its own direction (at right angles to the others); a tag's sentences
// all point the tag's way.
const dir = (t: number) => { const v = new Float32Array(AI_DIM); v[t] = 1; return v; };
const list = tagSentences();
const emb = new Float32Array(list.length * AI_DIM);
list.forEach((s, i) => emb.set(dir(s.t), i * AI_DIM));
const bank = makeTagBank(emb);
/** A photo as close to each named tag as given (cosine), kept as whole numbers like the app keeps it. */
const photo = (close: Record<string, number>) => {
  const v = new Float32Array(AI_DIM);
  let rest = 1;
  for (const [id, c] of Object.entries(close)) { v[TAG_BY_ID.get(id)!] = c; rest -= c * c; }
  v[AI_DIM - 1] = Math.sqrt(Math.max(0, rest)); // the part that is like no tag
  return quantize(unitOf(v));
};
const pack = (ps: Int8Array[]) => { const k = new Int8Array(ps.length * AI_DIM); ps.forEach((p, i) => k.set(p, i * AI_DIM)); return k; };

describe('tags', () => {
  it('fit in one whole number per photo, and every tag has sentences and a measured threshold', () => {
    expect(TAGS.length).toBeLessThanOrEqual(31);
    expect(new Set(TAGS.map((t) => t.id)).size).toBe(TAGS.length);
    for (const t of TAGS) { expect(t.prompts.length).toBeGreaterThanOrEqual(2); expect(t.min).toBeGreaterThan(0); expect(t.min).toBeLessThan(0.5); }
  });

  it('a photo gets every tag it is close enough to, and no other', () => {
    const a = TAGS[0], b = TAGS[1], c = TAGS[2];
    const k = pack([photo({ [a.id]: a.min + 0.03, [b.id]: b.min + 0.03 }), photo({ [c.id]: c.min - 0.03 }), photo({})]);
    const bits = tagAll(k, 3, bank);
    expect(tagsIn(bits[0]).map((t) => t.id)).toEqual([a.id, b.id]);
    expect(hasTag(bits[0], a.id)).toBe(true);
    expect(hasTag(bits[0], c.id)).toBe(false);
    expect(bits[1]).toBe(0); // close, but not close enough
    expect(bits[2]).toBe(0);
    expect(tagsIn(undefined)).toEqual([]);
  });

  it('the score of a tag is the closeness to its best sentence', () => {
    const t = TAGS[3];
    const sc = tagScores(pack([photo({ [t.id]: 0.2 })]), 1, bank);
    expect(sc[TAG_BY_ID.get(t.id)!]).toBeCloseTo(0.2, 2);
    expect(sc[TAG_BY_ID.get(TAGS[4].id)!]).toBeCloseTo(0, 2);
  });
});

describe('the tag sentence fingerprints that come with the app', () => {
  it('were made from the sentences as they are now (else run `npm run sentences`)', () => {
    const texts = tagSentences().map((p) => p.text);
    expect(made.hash).toBe(createHash('sha256').update(JSON.stringify(texts)).digest('hex'));
    expect(made.version).toBe(TAGS_VERSION);
    expect(fs.statSync(`public/ai/tags-${TAGS_VERSION}.bin`).size).toBe(texts.length * AI_DIM * 4);
  });
});
