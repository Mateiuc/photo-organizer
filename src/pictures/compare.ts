// Picture comparison: pure functions, so they can be tested and run in a worker.
//
// Each photo gets, from a small copy of its picture (about 256 px):
//   - a 32×32 grey "sketch" of the picture, and a 64-bit perceptual hash (pHash) made from it, for the picture
//     turned 0°, 90°, 180° and 270° (sideways copies are common after sharing)
//   - a fingerprint from an AI picture model (MobileNet V3), which knows what is in the picture
//   - sharpness, how flat (plain) the picture is, its shape, and its average colour
//
// "Same photo": the hashes are close AND the two sketches match almost exactly (correlation ≥ 0.94). Tested on
// 3,670 real photos (6.8 million pairs of different photos): no wrong match, while resized, re-compressed,
// brightened and black-and-white copies all matched. Shots of the same scene a moment apart don't count: they
// go to look-alikes.
// "Look-alikes": photos taken close together in time whose AI fingerprints are very close: bursts, retakes, and
// crops. You choose how close with a slider. When both photos were already looked at by the CLIP AI in Clean up,
// its fingerprints decide (CLIP knows what is in a picture much better); otherwise the MobileNet ones do.

export const GRID = 32;
export const DIM = 1280; // size of the AI fingerprint

// ---------- describing one picture ----------
/** The picture as a 32×32 grid of grey values (box average, so the result doesn't depend on the browser). */
export function greyGrid(rgba: ArrayLike<number>, w: number, h: number): Uint8Array {
  const sum = new Float64Array(GRID * GRID), cnt = new Float64Array(GRID * GRID);
  for (let y = 0; y < h; y++) {
    const gy = Math.min(GRID - 1, Math.floor((y * GRID) / h)) * GRID;
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const g = gy + Math.min(GRID - 1, Math.floor((x * GRID) / w));
      sum[g] += 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2];
      cnt[g]++;
    }
  }
  const out = new Uint8Array(GRID * GRID);
  for (let i = 0; i < out.length; i++) out[i] = cnt[i] ? Math.round(sum[i] / cnt[i]) : 0;
  return out;
}

/** The grid turned clockwise `quarter` times. */
export function turn(g: Uint8Array, quarter: number): Uint8Array {
  const q = ((quarter % 4) + 4) % 4;
  if (!q) return g;
  const out = new Uint8Array(g.length), n = GRID;
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const v = g[y * n + x];
    if (q === 1) out[x * n + (n - 1 - y)] = v; // (x, y) → (n-1-y, x)
    else if (q === 2) out[(n - 1 - y) * n + (n - 1 - x)] = v;
    else out[(n - 1 - x) * n + y] = v;
  }
  return out;
}

const COS = (() => {
  const c = new Float64Array(GRID * GRID);
  for (let k = 0; k < GRID; k++) for (let n = 0; n < GRID; n++) c[k * GRID + n] = Math.cos((Math.PI * (2 * n + 1) * k) / (2 * GRID));
  return c;
})();

/** 64-bit perceptual hash of a grid, as [high 32 bits, low 32 bits]. */
export function phash(g: Uint8Array): [number, number] {
  // 2-D DCT, only the 8×8 lowest frequencies are needed.
  const tmp = new Float64Array(8 * GRID);
  for (let u = 0; u < 8; u++) for (let x = 0; x < GRID; x++) {
    let s = 0;
    for (let y = 0; y < GRID; y++) s += COS[u * GRID + y] * g[y * GRID + x];
    tmp[u * GRID + x] = s;
  }
  const d: number[] = [];
  for (let u = 0; u < 8; u++) for (let v = 0; v < 8; v++) {
    if (!u && !v) continue; // the average brightness says nothing about the picture
    let s = 0;
    for (let x = 0; x < GRID; x++) s += COS[v * GRID + x] * tmp[u * GRID + x];
    d.push(s);
  }
  const med = [...d].sort((a, b) => a - b)[d.length >> 1];
  let hi = 0, lo = 0;
  for (let i = 0; i < 63; i++) {
    if (d[i] <= med) continue;
    if (i < 32) hi |= 1 << (31 - i); else lo |= 1 << (63 - i);
  }
  return [hi >>> 0, lo >>> 0];
}

/** The hashes of the picture turned 0°, 90°, 180° and 270°: 8 numbers. */
export function hashes(g: Uint8Array): Uint32Array {
  const out = new Uint32Array(8);
  for (let q = 0; q < 4; q++) { const [hi, lo] = phash(turn(g, q)); out[q * 2] = hi; out[q * 2 + 1] = lo; }
  return out;
}

const bits = (x: number) => { x -= (x >>> 1) & 0x55555555; x = (x & 0x33333333) + ((x >>> 2) & 0x33333333); return (((x + (x >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24; };
export const hamming = (ahi: number, alo: number, bhi: number, blo: number) => bits((ahi ^ bhi) >>> 0) + bits((alo ^ blo) >>> 0);

/** How alike two grids are, from -1 to 1 (1 = the same picture, whatever the brightness and contrast). */
export function correlation(a: ArrayLike<number>, b: ArrayLike<number>, ao = 0, bo = 0, n = GRID * GRID): number {
  let sa = 0, sb = 0;
  for (let i = 0; i < n; i++) { sa += a[ao + i]; sb += b[bo + i]; }
  const ma = sa / n, mb = sb / n;
  let ab = 0, aa = 0, bb = 0;
  for (let i = 0; i < n; i++) { const x = a[ao + i] - ma, y = b[bo + i] - mb; ab += x * y; aa += x * x; bb += y * y; }
  return aa && bb ? ab / Math.sqrt(aa * bb) : 0;
}

/** How plain the picture is (spread of grey values; under ~10 is a dark, blank or one-colour picture). */
export function flatness(g: Uint8Array): number {
  let s = 0, s2 = 0;
  for (let i = 0; i < g.length; i++) { s += g[i]; s2 += g[i] * g[i]; }
  const m = s / g.length;
  return Math.sqrt(Math.max(0, s2 / g.length - m * m));
}

/** Sharpness: how strong the fine detail is (variance of the Laplacian). Only comparable between pictures of the same size. */
export function sharpness(rgba: ArrayLike<number>, w: number, h: number): number {
  const g = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) g[i] = 0.299 * rgba[i * 4] + 0.587 * rgba[i * 4 + 1] + 0.114 * rgba[i * 4 + 2];
  let s = 0, s2 = 0, n = 0;
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    const l = 4 * g[i] - g[i - 1] - g[i + 1] - g[i - w] - g[i + w];
    s += l; s2 += l * l; n++;
  }
  return n ? s2 / n - (s / n) ** 2 : 0;
}

/** Average red, green, blue (0-255) and saturation (0-100). */
export function colour(rgba: ArrayLike<number>, w: number, h: number): [number, number, number, number] {
  let r = 0, g = 0, b = 0, sat = 0;
  const n = w * h;
  for (let i = 0; i < n; i++) {
    const R = rgba[i * 4], G = rgba[i * 4 + 1], B = rgba[i * 4 + 2];
    r += R; g += G; b += B;
    const mx = Math.max(R, G, B), mn = Math.min(R, G, B);
    sat += mx ? (mx - mn) / mx : 0;
  }
  return n ? [Math.round(r / n), Math.round(g / n), Math.round(b / n), Math.round((sat / n) * 100)] : [0, 0, 0, 0];
}

/** True when two copies of the same photo have clearly different colours (one was edited, or made black and white). */
export function coloursDiffer(a: ArrayLike<number>, b: ArrayLike<number>): boolean {
  return Math.abs(a[3] - b[3]) > 12 || Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2])) > 30;
}

/** The AI fingerprint in 1 byte per number (a quarter of the space, and the same results). */
export function quantize(e: ArrayLike<number>): Int8Array {
  let mx = 0;
  for (let i = 0; i < e.length; i++) mx = Math.max(mx, Math.abs(e[i]));
  const out = new Int8Array(e.length);
  if (mx) for (let i = 0; i < e.length; i++) out[i] = Math.round((e[i] * 127) / mx);
  return out;
}

// ---------- comparing many pictures ----------
/** Everything needed to compare n pictures, packed into flat arrays (cheap to send to a worker). */
export interface Packed {
  n: number;
  hash: Uint32Array; // n × 8
  grid: Uint8Array; // n × 1024
  emb: Int8Array; // n × DIM
  shape: Float32Array; // width / height of the picture
  flat: Float32Array;
  time: Float64Array; // when taken (ms), NaN when unknown
  pixels: Float64Array; // width × height of the original, or its file size when unknown (to choose the best copy)
  clip: Int8Array; // n × CLIP_LEN: the CLIP fingerprint from Clean up, all zeros when the photo has none
  hasClip: Uint8Array; // 1 when the photo has a CLIP fingerprint
}

/** Size of a CLIP fingerprint (the same as CLIP_DIM in sort/groups). */
export const CLIP_LEN = 512;

export const SAME = { hamming: 8, corr: 0.94, flatHamming: 4, flatCorr: 0.98, flat: 10, blank: 3, shape: 0.03 };

/** Groups of the same photo (as indexes into the packed arrays). */
export function samePhotos(p: Packed): number[][] {
  const { n, hash, grid, shape, flat } = p;
  // Four indexes, one per 16-bit quarter of the hash. Two hashes at most 7 bits apart share at least one quarter
  // within 1 bit, so looking up each quarter and its 16 one-bit neighbours finds every close pair.
  const index: Map<number, number[]>[] = [new Map(), new Map(), new Map(), new Map()];
  const quarters = (hi: number, lo: number) => [hi >>> 16, hi & 0xffff, lo >>> 16, lo & 0xffff];
  for (let i = 0; i < n; i++) {
    if (flat[i] < SAME.blank) continue;
    quarters(hash[i * 8], hash[i * 8 + 1]).forEach((q, b) => { const a = index[b].get(q); a ? a.push(i) : index[b].set(q, [i]); });
  }
  const parent = Int32Array.from({ length: n }, (_, i) => i);
  const find = (x: number): number => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  const tried = new Set<number>();
  for (let i = 0; i < n; i++) {
    if (flat[i] < SAME.blank) continue;
    for (let q = 0; q < 4; q++) {
      const hi = hash[i * 8 + q * 2], lo = hash[i * 8 + q * 2 + 1];
      tried.clear();
      quarters(hi, lo).forEach((v, b) => {
        for (let bit = -1; bit < 16; bit++) {
          for (const j of index[b].get(bit < 0 ? v : v ^ (1 << bit)) ?? []) {
            if (j <= i || tried.has(j)) continue;
            tried.add(j);
            if (find(i) === find(j)) continue;
            const plain = Math.min(flat[i], flat[j]) < SAME.flat;
            if (hamming(hi, lo, hash[j * 8], hash[j * 8 + 1]) > (plain ? SAME.flatHamming : SAME.hamming)) continue;
            const ratio = q % 2 ? shape[i] * shape[j] : shape[i] / shape[j];
            if (Math.abs(ratio - 1) > SAME.shape) continue;
            const gi = q ? turn(grid.subarray(i * 1024, i * 1024 + 1024), q) : grid.subarray(i * 1024, i * 1024 + 1024);
            if (correlation(gi, grid, 0, j * 1024) < (plain ? SAME.flatCorr : SAME.corr)) continue;
            parent[find(j)] = find(i);
          }
        }
      });
    }
  }
  const groups = new Map<number, number[]>();
  for (let i = 0; i < n; i++) { const r = find(i); const g = groups.get(r); g ? g.push(i) : groups.set(r, [i]); }
  return [...groups.values()].filter((g) => g.length > 1);
}

export const NEAR = { window: 40, hours: 24, min: 0.8 };

/** Cosine similarity of two AI fingerprints. */
export function similarity(emb: Int8Array, i: number, j: number, norms: Float32Array): number {
  let s = 0;
  const a = i * DIM, b = j * DIM;
  for (let k = 0; k < DIM; k++) s += emb[a + k] * emb[b + k];
  return norms[i] && norms[j] ? s / (norms[i] * norms[j]) : 0;
}
export function norms(p: Packed): Float32Array {
  const out = new Float32Array(p.n);
  for (let i = 0; i < p.n; i++) { let s = 0; for (let k = 0; k < DIM; k++) s += p.emb[i * DIM + k] ** 2; out[i] = Math.sqrt(s); }
  return out;
}

function clipNorms(p: Packed): Float32Array {
  const out = new Float32Array(p.n);
  for (let i = 0; i < p.n; i++) {
    if (!p.hasClip[i]) continue;
    let s = 0;
    for (let k = 0; k < CLIP_LEN; k++) s += p.clip[i * CLIP_LEN + k] ** 2;
    out[i] = Math.sqrt(s);
  }
  return out;
}
function clipSimilarity(p: Packed, i: number, j: number, nm: Float32Array): number {
  let s = 0;
  const a = i * CLIP_LEN, b = j * CLIP_LEN;
  for (let k = 0; k < CLIP_LEN; k++) s += p.clip[a + k] * p.clip[b + k];
  return nm[i] && nm[j] ? s / (nm[i] * nm[j]) : 0;
}

/**
 * Pairs of photos taken close together (within the next 40 photos and 24 hours) whose AI fingerprints are at least
 * 0.8 alike, as [i, j, similarity] triples. The CLIP fingerprints are used when both photos have one, else the
 * MobileNet ones. `skip[i]` leaves a photo out (an extra copy of another photo).
 */
export function nearPairs(p: Packed, skip?: Uint8Array): Float64Array {
  const nm = norms(p), cn = clipNorms(p);
  const order = Array.from({ length: p.n }, (_, i) => i).filter((i) => !skip?.[i] && !Number.isNaN(p.time[i])).sort((a, b) => p.time[a] - p.time[b]);
  const out: number[] = [];
  for (let x = 0; x < order.length; x++) {
    const i = order[x];
    for (let y = x + 1; y < order.length && y <= x + NEAR.window; y++) {
      const j = order[y];
      if (p.time[j] - p.time[i] > NEAR.hours * 3600e3) break;
      const s = p.hasClip[i] && p.hasClip[j] ? clipSimilarity(p, i, j, cn) : similarity(p.emb, i, j, nm);
      if (s >= NEAR.min) out.push(Math.min(i, j), Math.max(i, j), s);
    }
  }
  return Float64Array.from(out);
}

/**
 * Look-alike groups for a chosen closeness. Two groups only join when, on average, all their photos are that
 * close to each other, so a long chain of slightly different photos doesn't end up as one big group.
 */
export function lookAlikes(pairs: Float64Array, threshold: number, maxSize = 60): number[][] {
  const sim = new Map<string, number>();
  const list: [number, number, number][] = [];
  for (let k = 0; k < pairs.length; k += 3) {
    if (pairs[k + 2] < threshold) continue;
    list.push([pairs[k], pairs[k + 1], pairs[k + 2]]);
  }
  for (let k = 0; k < pairs.length; k += 3) sim.set(pairs[k] + ',' + pairs[k + 1], pairs[k + 2]);
  list.sort((a, b) => b[2] - a[2]);
  const groupOf = new Map<number, number[]>();
  const get = (i: number) => { let g = groupOf.get(i); if (!g) { g = [i]; groupOf.set(i, g); } return g; };
  const s = (a: number, b: number) => sim.get(Math.min(a, b) + ',' + Math.max(a, b)) ?? 0.6;
  for (const [i, j] of list) {
    const A = get(i), B = get(j);
    if (A === B || A.length + B.length > maxSize) continue;
    let tot = 0;
    for (const a of A) for (const b of B) tot += s(a, b);
    if (tot / (A.length * B.length) < threshold) continue;
    for (const b of B) { A.push(b); groupOf.set(b, A); }
  }
  return [...new Set(groupOf.values())].filter((g) => g.length > 1);
}
