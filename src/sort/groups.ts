// Clean-up groups and how a photo is put in one. Pure functions, so they can be tested and run in a worker.
//
// The AI (SigLIP 2 base, patch 16, 224, from Google, run on this computer) turns a picture into 768 numbers, and a
// sentence like "a photo of a document" into 768 numbers the same way. The closer the two are, the better the
// sentence describes the picture. Each group has a few sentences; a photo goes to the group whose sentences fit it best.
//
// Fixes you make teach it: photos that look like a photo you put in a group are pulled towards that group
// (a "cache" of your examples next to the sentences, as in Tip-Adapter, Zhang et al. 2022).

export const AI_DIM = 768;
export const AI_MODEL = 'onnx-community/siglip2-base-patch16-224-ONNX';
/** The exact copy of the AI's files on Hugging Face, so every computer gets the same ones. */
export const AI_REVISION = 'ba1f3b0843f24bc5417d38e19c37b287d719b2f4';
/**
 * The full-size AI for pictures (about 370 MB, downloaded once). The small compressed copies (q8) are not used: with
 * the AI before this one their fingerprints were too far from the real ones, and clear photos of people ended up in
 * the junk groups.
 */
export const AI_DTYPE = 'fp32' as const;
/** The AI used before, whose files are let go from the browser. */
export const OLD_AI_MODEL = 'Xenova/clip-vit-base-patch32';
/** Which AI made a fingerprint. Fingerprints from an older one are made again. 1 = compressed CLIP, 2 = CLIP, 3 = SigLIP 2. */
export const FP_VERSION = 3;
/**
 * Change when the sentences change, then run `npm run sentences`: the sentence fingerprints come with the app
 * (public/ai/sentences-N.bin, made with the full-size words part of the AI), so the browser never downloads that part.
 */
export const PROMPTS_VERSION = 4;

export type Side = 'junk' | 'call' | 'keep' | 'other' | 'whatsapp';
export interface Group { id: string; name: string; side: Side; prompts: string[] }

export const GROUPS: Group[] = [
  { id: 'docs', name: 'Documents and papers', side: 'junk', prompts: [
    'a photo of a document with text', 'a photo of a printed page', 'a photo of a contract', 'a photo of a receipt', 'a photo of an invoice',
    'a photo of an ID card', 'a photo of a handwritten note', 'a scanned paper form', 'a photo of a page of a book',
  ] },
  { id: 'shots', name: 'Screenshots', side: 'junk', prompts: [
    'a screenshot of a phone screen', 'a screenshot of a chat conversation', 'a screenshot of a website', 'a screenshot of an app', 'a screenshot of a map',
  ] },
  { id: 'labels', name: 'Labels, stickers and VINs', side: 'junk', prompts: [
    'a photo of a VIN sticker on a car door frame', 'a photo of a vehicle identification number label', 'a close-up photo of a sticker with a barcode',
    'a photo of a label with small printed text', 'a photo of a serial number plate', 'a photo of a part number label on a car part', 'a photo of a tire label',
  ] },
  { id: 'screens', name: 'Photos of computer screens', side: 'junk', prompts: [
    'a photo of a laptop screen', 'a photo of a computer monitor showing text', 'a photo taken of a computer screen', 'a photo of a TV screen',
  ] },
  { id: 'scantool', name: 'Scan-tool screens', side: 'call', prompts: [
    'a photo of a car diagnostic scanner screen', 'a photo of a tablet showing car diagnostic data', 'a photo of a handheld diagnostic tool display',
    'a photo of an OBD scan tool showing error codes',
  ] },
  { id: 'people', name: 'People', side: 'keep', prompts: [
    'a photo of a person', 'a photo of people', 'a selfie', 'a group photo of friends', 'a photo of a child', 'a family photo', 'a portrait of a man', 'a portrait of a woman',
  ] },
  { id: 'wires', name: 'Wiring and cables', side: 'keep', prompts: [
    'a photo of electrical wires', 'a photo of car wiring', 'a photo of a wiring harness in a car', 'a photo of cables and connectors',
    'a photo of an electrical panel with wires', 'a photo of a car engine bay', 'a photo of car electronics being repaired',
  ] },
  { id: 'lights', name: 'Lights and LEDs', side: 'keep', prompts: [
    'a photo of LED lights', 'a photo of an LED strip', 'a photo of car headlights', 'a photo of lamps lighting a room', 'a photo of car tail lights at night',
    'a photo of ambient lighting in a car', 'a photo of a room lit by purple and pink LED light', 'a photo of a room with colored lighting',
    'a photo of a space glowing with violet grow lights', 'a photo of walls lit by colored LED light', 'a photo of a grow room under purple LED grow lights',
  ] },
  { id: 'house', name: 'House work', side: 'keep', prompts: [
    'a photo of house renovation work', 'a photo of a construction site', 'a photo of a room being renovated', 'a photo of tiling work',
    'a photo of a wall being built', 'a photo of a roof under construction', 'a photo of plumbing work',
  ] },
  { id: 'thermal', name: 'Thermal camera', side: 'keep', prompts: [
    'a thermal camera image', 'a thermal imaging picture with a temperature reading', 'an infrared heat map image',
    'a false-color thermal camera picture', 'a thermal image of an electrical panel', 'a thermal image of a car engine', 'a FLIR thermal photo',
  ] },
  { id: 'food', name: 'Food', side: 'keep', prompts: [
    'a photo of food', 'a photo of a meal on a plate', 'a photo of a dish in a restaurant', 'a photo of cooking in a kitchen', 'a photo of a cake', 'a photo of drinks on a table',
  ] },
  { id: 'other', name: 'Everything else', side: 'other', prompts: [
    'a photo of a landscape', 'a photo of a car', 'a photo of an animal', 'a photo of a street', 'a photo of a building', 'a photo of flowers',
    'a photo of the sea', 'a photo of mountains', 'a photo of a city', 'a photo of a garden', 'a photo of a room', 'a photo of a tool', 'a photo of a sunset',
    'a photo taken from an airplane window', 'an aerial view of city lights at night from a plane', 'a view of clouds and sky from a plane',
    'a night photo of a city', 'a dark photo taken at night', 'a photo of the sky', 'a photo taken through a window',
    'a photo of a living room with a television', 'a photo of an office with desks and computers', 'a photo of a room with a tv on the wall',
    'a photo of a street sign', 'a photo of a sign on a building', 'a photo of a shop front with a sign',
  ] },
  // Known from the file name or folder, not from the AI (so no sentences). Last, so the others keep their numbers.
  { id: 'whatsapp', name: 'WhatsApp', side: 'whatsapp', prompts: [] },
];

export const GROUP_BY_ID = new Map(GROUPS.map((g, i) => [g.id, i]));
export const SIDES: { side: Side; name: string; note: string }[] = [
  { side: 'junk', name: 'Probably junk', note: 'Documents, screenshots, labels and screens.' },
  { side: 'call', name: 'Your call', note: 'Tell me if these are junk or keep.' },
  { side: 'keep', name: 'Keep', note: 'People and your work.' },
  { side: 'other', name: 'Everything else', note: 'Not junk, and not one of your keep groups.' },
  { side: 'whatsapp', name: 'WhatsApp', note: 'Photos and videos saved from WhatsApp, kept apart from your camera photos.' },
];

/** Every sentence, in order, with the group it belongs to. */
export function promptList(): { text: string; g: number }[] {
  return GROUPS.flatMap((grp, g) => grp.prompts.map((text) => ({ text, g })));
}

export interface Bank {
  /** P × 768 sentence fingerprints, each unit length. */
  emb: Float32Array;
  /** Group of each sentence. */
  group: Uint8Array;
  /** −log(sentences in its group), so a group with more sentences doesn't win more often. */
  bias: Float32Array;
}

export function makeBank(emb: Float32Array, dim = AI_DIM): Bank {
  const list = promptList();
  const n = list.length;
  const out = new Float32Array(n * dim);
  for (let p = 0; p < n; p++) {
    let s = 0;
    for (let d = 0; d < dim; d++) s += emb[p * dim + d] ** 2;
    const k = s ? 1 / Math.sqrt(s) : 0;
    for (let d = 0; d < dim; d++) out[p * dim + d] = emb[p * dim + d] * k;
  }
  const count = new Map<number, number>();
  list.forEach((x) => count.set(x.g, (count.get(x.g) ?? 0) + 1));
  return { emb: out, group: Uint8Array.from(list.map((x) => x.g)), bias: Float32Array.from(list.map((x) => -Math.log(count.get(x.g)!))) };
}

/** Your fixes, as examples: unit-length fingerprints and the group you chose. */
export interface Examples { emb: Float32Array; group: Uint8Array; n: number }

export const LEARN = {
  /** The AI's own scale between picture–sentence closeness and certainty (SigLIP 2's logit scale, e^4.7245). */
  scale: 112.67,
  /** How sharply only close-looking examples count (Tip-Adapter's β). */
  beta: 5.5,
  /** How much your examples count next to the sentences (Tip-Adapter's α). */
  alpha: 3,
  /** Only the closest few examples of each group count, so a group with many fixes doesn't swallow everything. */
  top: 5,
  /** At most this many of your newest fixes are used. */
  maxExamples: 400,
};

/** Unit-length copy of a fingerprint kept as whole numbers. */
export function unitOf(k: ArrayLike<number>, dim = AI_DIM): Float32Array {
  let s = 0;
  for (let d = 0; d < dim; d++) s += k[d] * k[d];
  const m = s ? 1 / Math.sqrt(s) : 0;
  const out = new Float32Array(dim);
  for (let d = 0; d < dim; d++) out[d] = k[d] * m;
  return out;
}

/**
 * Scores n photos (fingerprints n × 768, whole numbers) against the groups. Returns each photo's best group and how
 * sure (0 to 1, the share of certainty that group gets), plus the runner-up.
 */
export function scoreAll(k: Int8Array, n: number, bank: Bank, ex?: Examples, dim = AI_DIM): { g: Uint8Array; p: Float32Array; g2: Uint8Array; probs: Float32Array } {
  const G = GROUPS.length, P = bank.group.length;
  const g = new Uint8Array(n), g2 = new Uint8Array(n), p = new Float32Array(n), probs = new Float32Array(n * G);
  const f = new Float32Array(dim);
  const logit = new Float64Array(P), gl = new Float64Array(G), cache = new Float64Array(G);
  const tops: number[][] = Array.from({ length: G }, () => []);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let d = 0; d < dim; d++) { const v = k[i * dim + d]; f[d] = v; s += v * v; }
    const m = s ? 1 / Math.sqrt(s) : 0;
    for (let d = 0; d < dim; d++) f[d] *= m;
    // sentences → group logits (log of the summed probability of the group's sentences)
    gl.fill(-Infinity);
    for (let q = 0; q < P; q++) {
      let c = 0;
      const o = q * dim;
      for (let d = 0; d < dim; d++) c += f[d] * bank.emb[o + d];
      logit[q] = LEARN.scale * c + bank.bias[q];
      const gg = bank.group[q];
      gl[gg] = gl[gg] === -Infinity ? logit[q] : Math.max(gl[gg], logit[q]) + Math.log1p(Math.exp(-Math.abs(gl[gg] - logit[q])));
    }
    // your examples
    if (ex && ex.n) {
      for (const t of tops) t.length = 0;
      for (let e = 0; e < ex.n; e++) {
        let c = 0;
        const o = e * dim;
        for (let d = 0; d < dim; d++) c += f[d] * ex.emb[o + d];
        const a = Math.exp(-LEARN.beta * (1 - c));
        const t = tops[ex.group[e]];
        if (t.length < LEARN.top) { t.push(a); t.sort((x, y) => y - x); } else if (a > t[t.length - 1]) { t[t.length - 1] = a; t.sort((x, y) => y - x); }
      }
      cache.fill(0);
      for (let q = 0; q < G; q++) for (const a of tops[q]) cache[q] += a;
      for (let q = 0; q < G; q++) gl[q] += LEARN.alpha * cache[q];
    }
    // softmax over groups
    let best = 0, second = -1, mx = -Infinity;
    for (let q = 0; q < G; q++) if (gl[q] > mx) mx = gl[q];
    let sum = 0;
    for (let q = 0; q < G; q++) sum += Math.exp(gl[q] - mx);
    for (let q = 1; q < G; q++) if (gl[q] > gl[best]) best = q;
    for (let q = 0; q < G; q++) if (q !== best && (second < 0 || gl[q] > gl[second])) second = q;
    g[i] = best; g2[i] = Math.max(0, second);
    p[i] = Math.exp(gl[best] - mx) / sum;
    for (let q = 0; q < G; q++) probs[i * G + q] = Math.exp(gl[q] - mx) / sum;
  }
  return { g, p, g2, probs };
}

/**
 * The AI's choice for one photo from every group's share: the most likely group, leaving out Screenshots for a photo
 * with camera information (a camera model or a GPS place), which a screenshot never has. How sure is counted among
 * the groups left.
 */
export function choose(probs: ArrayLike<number>, camera: boolean): { g: number; p: number } {
  const shots = GROUP_BY_ID.get('shots')!;
  let best = -1, sum = 0;
  for (let q = 0; q < probs.length; q++) {
    if (camera && q === shots) continue;
    sum += probs[q];
    if (best < 0 || probs[q] > probs[best]) best = q;
  }
  return { g: Math.max(0, best), p: sum && best >= 0 ? probs[best] / sum : 0 };
}

export type Why = 'ai' | 'name' | 'face' | 'you' | 'unsure' | 'mixed';
/** `guess`: for 'unsure' and 'mixed', the junk group the AI leaned to. */
export interface Placed { g: number; p: number; why: Why; guess?: number }

/** A junk group only gets photos the AI is at least this sure about; less sure ones go to Everything else. */
export const JUNK_SURE = 0.5;

/** How sure the AI must be that a photo with a face is junk (an ID card, a document with a photo) to keep it there. */
export const FACE_JUNK_SURE = 0.8;

/**
 * The final group of one photo: your fix first; then a WhatsApp photo or a screenshot, recognised from the file
 * itself; then a photo with a face goes to People, unless the AI is very sure it is a document, label, screen or
 * scan-tool screen (an ID card has a face too).
 *
 * `keepSign`: the photo's tags say something worth keeping is in it (people, a car, a room, food…, see keepSigns in
 * tags.ts). Documents, Labels and Photos of screens don't get such a photo, however sure the AI is: it goes to
 * Everything else, marked 'mixed'. Measured with scripts/junkcheck.ts, the numbers are in the pull request.
 */
export function place(ai: { g: number; p: number; probs?: ArrayLike<number> } | undefined, o: { fix?: number; whatsapp?: boolean; screenshot?: boolean; face?: boolean; camera?: boolean; keepSign?: boolean }): Placed | undefined {
  if (o.fix != null) return { g: o.fix, p: 1, why: 'you' };
  if (o.whatsapp) return { g: GROUP_BY_ID.get('whatsapp')!, p: 1, why: 'name' };
  if (o.screenshot) return { g: GROUP_BY_ID.get('shots')!, p: 1, why: 'name' };
  if (!ai) return undefined;
  const c = ai.probs ? choose(ai.probs, !!o.camera) : { g: ai.g, p: ai.p };
  const side = GROUPS[c.g].side;
  const sureJunk = (side === 'junk' || side === 'call') && c.p >= FACE_JUNK_SURE;
  if (o.face && !sureJunk && GROUPS[c.g].id !== 'people') return { g: GROUP_BY_ID.get('people')!, p: Math.max(side === 'keep' || side === 'other' ? c.p : 0, 0.9), why: 'face' };
  if (side === 'junk' && c.p < JUNK_SURE) return { g: GROUP_BY_ID.get('other')!, p: c.p, why: 'unsure', guess: c.g };
  // not for Screenshots: a screenshot of a photo of people is still a screenshot
  if (side === 'junk' && o.keepSign && GROUPS[c.g].id !== 'shots') return { g: GROUP_BY_ID.get('other')!, p: c.p, why: 'mixed', guess: c.g };
  return { g: c.g, p: c.p, why: 'ai' };
}
