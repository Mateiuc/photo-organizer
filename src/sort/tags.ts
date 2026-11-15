// What else is in a photo. A photo is in one Clean-up group, but it can have several tags: a photo in "Everything
// else" can show a car and a street, a document can have a person on it.
//
// Tags come from the same AI fingerprint as the groups (no second look at the photo): each tag has a few sentences,
// and a photo gets the tag when its fingerprint is close enough to one of them. How close is "enough" (`min`) was
// measured for each tag on about 4,500 labelled photos (scripts/tagscore.ts with FIT=1): a tag is only here if, with
// `min` chosen on one half of them and counted on the other, it marked about 1 in 100 or fewer of the photos that
// don't have it, and found at least half of those that do. Tried and left out: Street or city (found 43%), Screen
// (too few labelled photos) and Thermal (purple-lit rooms got it; the Thermal camera group handles those).
import { AI_DIM } from './groups';

export interface Tag {
  id: string;
  name: string;
  /** How close (cosine) the photo must be to the tag's best sentence. */
  min: number;
  prompts: string[];
}

/**
 * Change when the tags' sentences change, then run `npm run sentences`: like the group sentences, their fingerprints
 * come with the app (public/ai/tags-N.bin).
 */
export const TAGS_VERSION = 1;

export const TAGS: Tag[] = [
  { id: 'people', name: 'People', min: 0.084, prompts: [
    'a photo of a person', 'a photo of people', 'a photo of a group of people', 'a selfie', 'a photo of a child', 'a portrait of a man', 'a portrait of a woman',
    'a photo of a man', 'a photo of a woman', 'a photo of a person playing a sport', 'a photo of a person standing outside', 'a photo of a person at work',
  ] },
  { id: 'car', name: 'Car', min: 0.085, prompts: [
    'a photo of a car', 'a photo of a parked car', 'a photo of a truck', 'a photo of a van', 'a photo of cars on a road',
  ] },
  { id: 'car_in', name: 'Inside a car', min: 0.098, prompts: [
    'a photo of the interior of a car', 'a photo of a car dashboard', 'a photo of a steering wheel', 'a photo of car seats', 'a photo of the inside of a car',
  ] },
  { id: 'engine', name: 'Engine', min: 0.099, prompts: [
    'a photo of a car engine', 'a photo of an engine bay', 'a photo under the hood of a car',
  ] },
  { id: 'animal', name: 'Animal', min: 0.076, prompts: [
    'a photo of an animal', 'a photo of a dog', 'a photo of a cat', 'a photo of a bird', 'a photo of a horse',
  ] },
  { id: 'food', name: 'Food', min: 0.065, prompts: [
    'a photo of food', 'a photo of a meal on a plate', 'a photo of a dessert', 'a photo of a drink',
  ] },
  { id: 'text', name: 'Page of text', min: 0.107, prompts: [
    'a photo of a document with text', 'a scanned page of text', 'a photo of a printed page', 'a photo of a receipt', 'a photo of a paper form', 'a photo of a handwritten note',
  ] },
  { id: 'label', name: 'Label or plate', min: 0.086, prompts: [
    'a photo of a label with printed text', 'a photo of a nameplate with serial numbers', 'a photo of a sticker with a barcode', 'a photo of a rating plate on a machine',
  ] },
  { id: 'words', name: 'Picture with words', min: 0.079, prompts: [
    'a meme', 'a picture with a caption written on it', 'a greeting card', 'an image with a quote written on it', 'a poster with text',
  ] },
  { id: 'nature', name: 'Nature', min: 0.090, prompts: [
    'a photo of a landscape', 'a photo of mountains', 'a photo of a forest', 'a photo of the sea', 'a photo of a beach', 'a photo of a lake', 'a photo of a river',
    'a photo of a field', 'a photo of the sky',
  ] },
  { id: 'room', name: 'Room at home', min: 0.083, prompts: [
    'a photo of a room in a house', 'a photo of a kitchen', 'a photo of a bedroom', 'a photo of a living room', 'a photo of a bathroom',
  ] },
  { id: 'build', name: 'Building work', min: 0.088, prompts: [
    'a photo of a construction site', 'a photo of building work', 'a photo of a house being renovated', 'a photo of an excavator', 'a photo of scaffolding',
  ] },
  { id: 'garage', name: 'Garage or workshop', min: 0.096, prompts: [
    'a photo of a car repair shop', 'a photo of the inside of a garage', 'a photo of a car parked in a garage', 'a photo of a car on a lift',
    'a photo of a mechanic working in a workshop',
  ] },
  { id: 'tool', name: 'Tools', min: 0.114, prompts: [
    'a photo of a tool', 'a photo of hand tools', 'a photo of a toolbox', 'a photo of pliers', 'a photo of a wrench', 'a photo of a screwdriver', 'a photo of a power drill',
  ] },
  { id: 'board', name: 'Circuit board', min: 0.097, prompts: [
    'a photo of a circuit board', 'a photo of a printed circuit board with electronic components', 'a photo of a computer motherboard',
  ] },
  { id: 'wires', name: 'Wires and cables', min: 0.108, prompts: [
    'a photo of electrical wires', 'a photo of cables', 'a photo of a wiring harness', 'a photo of a cable plugged into a device', 'a photo of an electrical panel with wires',
  ] },
  { id: 'flowers', name: 'Flowers', min: 0.094, prompts: [
    'a photo of a flower', 'a photo of flowers', 'a close-up photo of a flower',
  ] },
];

export const TAG_BY_ID = new Map(TAGS.map((t, i) => [t.id, i]));

/** Every tag sentence, in order, with its tag. */
export function tagSentences(): { text: string; t: number }[] {
  return TAGS.flatMap((tag, t) => tag.prompts.map((text) => ({ text, t })));
}

export interface TagBank {
  /** S × 768 sentence fingerprints, each unit length. */
  emb: Float32Array;
  /** Tag of each sentence. */
  tag: Uint8Array;
}

export function makeTagBank(emb: Float32Array, dim = AI_DIM): TagBank {
  const list = tagSentences();
  const out = new Float32Array(list.length * dim);
  for (let p = 0; p < list.length; p++) {
    let s = 0;
    for (let d = 0; d < dim; d++) s += emb[p * dim + d] ** 2;
    const k = s ? 1 / Math.sqrt(s) : 0;
    for (let d = 0; d < dim; d++) out[p * dim + d] = emb[p * dim + d] * k;
  }
  return { emb: out, tag: Uint8Array.from(list.map((x) => x.t)) };
}

/**
 * How close n photos (fingerprints n × 768, whole numbers) are to each tag: n × TAGS.length, the cosine to the tag's
 * best sentence.
 */
export function tagScores(k: ArrayLike<number>, n: number, bank: TagBank, dim = AI_DIM): Float32Array {
  const T = TAGS.length, S = bank.tag.length;
  const out = new Float32Array(n * T).fill(-1);
  const f = new Float32Array(dim);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let d = 0; d < dim; d++) { const v = k[i * dim + d]; f[d] = v; s += v * v; }
    const m = s ? 1 / Math.sqrt(s) : 0;
    for (let q = 0; q < S; q++) {
      let c = 0;
      const o = q * dim;
      for (let d = 0; d < dim; d++) c += f[d] * bank.emb[o + d];
      c *= m;
      const at = i * T + bank.tag[q];
      if (c > out[at]) out[at] = c;
    }
  }
  return out;
}

/** The tags of n photos, one whole number each: bit t is set when the photo has TAGS[t]. */
export function tagAll(k: ArrayLike<number>, n: number, bank: TagBank, dim = AI_DIM): Uint32Array {
  const T = TAGS.length;
  const sc = tagScores(k, n, bank, dim);
  const out = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    let bits = 0;
    for (let t = 0; t < T; t++) if (sc[i * T + t] >= TAGS[t].min) bits |= 1 << t;
    out[i] = bits >>> 0;
  }
  return out;
}

/**
 * Tags that say "this is not just a paper or a screen": something a person would want to keep is in the photo. A
 * photo the AI calls junk that also has one of these is worth a look before it is deleted.
 */
const KEEP_SIGNS = new Set(['people', 'animal', 'food', 'nature', 'car', 'car_in', 'engine', 'room', 'build', 'garage', 'board', 'wires', 'flowers']);
export const keepSigns = (bits: number | undefined): Tag[] => tagsIn(bits).filter((t) => KEEP_SIGNS.has(t.id));

export const hasTag = (bits: number | undefined, id: string) => { const t = TAG_BY_ID.get(id); return t != null && !!bits && (bits & (1 << t)) !== 0; };
/** The tags in a photo's number, in the order of TAGS. */
export const tagsIn = (bits: number | undefined): Tag[] => (bits ? TAGS.filter((_, t) => (bits & (1 << t)) !== 0) : []);
