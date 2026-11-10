// "Learn from my examples": the photos you mark Yes and No teach a small model which pictures belong to a topic,
// then every photo the app has looked at is scored. It uses the AI fingerprints that Compare pictures already made
// (MobileNet V3, 1,280 numbers per photo), so nothing new has to be downloaded and nothing leaves this computer.
//
// The model is a weighted logistic regression: your Yes photos on one side, your No photos plus a random sample
// of your other photos on the other (most photos don't belong to a topic, so a random sample is mostly "no").
// Tested on 119 real workshop photos (VIN stickers, scan-tool screens, documents, other labels) mixed into
// 3,670 unrelated photos: with 10 Yes and 10 No, about 85 of the top 100 matches were real VIN stickers.
import { DIM } from '../pictures/compare';

export const LEARN = {
  /** Random other photos used as "probably not". */
  background: 1000,
  iterations: 150,
  rate: 0.5,
  /** Regularisation strength (higher = smoother model). */
  c: 10,
  /** Scores below this aren't kept. */
  keep: 0.1,
  /**
   * How much the Yes photos count against the No photos and the sample. A little more than each, so that real
   * matches aren't hidden at the default "How sure: 50%" (results are shown best first, and a wrong one is easy
   * to mark ✗). Measured on the real photos: 78% to 99% of the matches shown at 50%, depending on how many marks.
   */
  yesWeight: 1.5,
};

/** Small, seeded random numbers, so the same marks give the same answer. */
export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Turns the stored fingerprints (whole numbers, each photo scaled on its own) into unit-length vectors. */
export function unit(emb: Int8Array, n: number, dim = DIM): Float32Array {
  const out = new Float32Array(n * dim);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let d = 0; d < dim; d++) { const v = emb[i * dim + d]; s += v * v; }
    const k = s ? 1 / Math.sqrt(s) : 0;
    for (let d = 0; d < dim; d++) out[i * dim + d] = emb[i * dim + d] * k;
  }
  return out;
}

export interface LearnInput {
  emb: Int8Array; // n × dim fingerprints
  n: number;
  yes: number[]; // indexes
  no: number[];
  seed?: number;
  dim?: number;
}

/** Trains on the marks and returns, for every photo, how likely it belongs (0 to 1). */
export function learnScores({ emb, n, yes, no, seed = 1, dim = DIM }: LearnInput): Float32Array {
  // Each fingerprint is used at unit length. Only the training rows are turned into decimals, so 40,000 photos
  // don't need hundreds of megabytes.
  const scale = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let d = 0; d < dim; d++) { const v = emb[i * dim + d]; s += v * v; }
    scale[i] = s ? 1 / Math.sqrt(s) : 0;
  }
  const marked = new Set([...yes, ...no]);
  // A random sample of the other photos, as weak "no" examples.
  const rest: number[] = [];
  for (let i = 0; i < n; i++) if (!marked.has(i)) rest.push(i);
  const r = rng(seed);
  const m = Math.min(LEARN.background, rest.length);
  for (let i = 0; i < m; i++) { const j = i + Math.floor(r() * (rest.length - i)); [rest[i], rest[j]] = [rest[j], rest[i]]; }
  const bg = rest.slice(0, m);
  const rows = [...yes, ...no, ...bg];
  const X = new Float32Array(rows.length * dim);
  rows.forEach((row, k) => { for (let d = 0; d < dim; d++) X[k * dim + d] = emb[row * dim + d] * scale[row]; });
  const y = new Float32Array(rows.length);
  const w = new Float32Array(rows.length);
  // Yes, No and the sample each count about as much as the others together, however many there are.
  yes.forEach((_, i) => { y[i] = 1; w[i] = LEARN.yesWeight / yes.length; });
  no.forEach((_, i) => { w[yes.length + i] = 1 / no.length; });
  bg.forEach((_, i) => { w[yes.length + no.length + i] = 1 / bg.length; });
  let mean = 0;
  for (const v of w) mean += v;
  mean /= w.length || 1;
  for (let i = 0; i < w.length; i++) w[i] /= mean;
  const sw = w.reduce((a, b) => a + b, 0) || 1;
  const l2 = 1 / (LEARN.c * (rows.length || 1));

  const W = new Float64Array(dim);
  let b = 0;
  const g = new Float64Array(rows.length);
  const grad = new Float64Array(dim);
  for (let it = 0; it < LEARN.iterations; it++) {
    let gb = 0;
    for (let k = 0; k < rows.length; k++) {
      const o = k * dim;
      let z = b;
      for (let d = 0; d < dim; d++) z += X[o + d] * W[d];
      const p = 1 / (1 + Math.exp(-z));
      g[k] = (p - y[k]) * w[k];
      gb += g[k];
    }
    grad.fill(0);
    for (let k = 0; k < rows.length; k++) {
      const o = k * dim, gk = g[k];
      if (gk) for (let d = 0; d < dim; d++) grad[d] += X[o + d] * gk;
    }
    for (let d = 0; d < dim; d++) W[d] -= LEARN.rate * (grad[d] / sw + l2 * W[d]);
    b -= LEARN.rate * (gb / sw);
  }
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const o = i * dim;
    let z = 0;
    for (let d = 0; d < dim; d++) z += emb[o + d] * W[d];
    out[i] = 1 / (1 + Math.exp(-(b + z * scale[i])));
  }
  return out;
}
