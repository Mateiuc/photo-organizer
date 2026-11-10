import { describe, expect, it } from 'vitest';
import { colour, coloursDiffer, correlation, DIM, flatness, greyGrid, hamming, hashes, lookAlikes, nearPairs, quantize, samePhotos, sharpness, turn, type Packed } from './compare';

/** A made-up photo: a few coloured shapes on a gradient. */
function picture(seed: number, w = 240, h = 180) {
  let s = seed;
  const rnd = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);
  const shapes = Array.from({ length: 7 }, () => ({ x: rnd() * w, y: rnd() * h, r: 15 + rnd() * 50, c: [rnd() * 255, rnd() * 255, rnd() * 255] }));
  const px = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    let c = [(x / w) * 120, (y / h) * 120, 80];
    for (const sh of shapes) if ((x - sh.x) ** 2 + (y - sh.y) ** 2 < sh.r ** 2) c = sh.c;
    px[i] = c[0]; px[i + 1] = c[1]; px[i + 2] = c[2]; px[i + 3] = 255;
  }
  return { px, w, h };
}
const edit = (p: ReturnType<typeof picture>, f: (v: number, i: number) => number) => ({ ...p, px: p.px.map((v, i) => (i % 4 === 3 ? v : f(v, i))) });
/** Half the size, by averaging 2×2 blocks (what a smaller copy looks like). */
function half(p: ReturnType<typeof picture>) {
  const w = p.w >> 1, h = p.h >> 1, px = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) for (let c = 0; c < 4; c++) {
    const at = (dx: number, dy: number) => p.px[((2 * y + dy) * p.w + 2 * x + dx) * 4 + c];
    px[(y * w + x) * 4 + c] = (at(0, 0) + at(1, 0) + at(0, 1) + at(1, 1)) / 4;
  }
  return { px, w, h };
}
/** Turned a quarter clockwise. */
function sideways(p: ReturnType<typeof picture>) {
  const w = p.h, h = p.w, px = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < p.h; y++) for (let x = 0; x < p.w; x++) for (let c = 0; c < 4; c++) px[(x * w + (w - 1 - y)) * 4 + c] = p.px[(y * p.w + x) * 4 + c];
  return { px, w, h };
}
const grid = (p: ReturnType<typeof picture>) => greyGrid(p.px, p.w, p.h);

describe('describing a picture', () => {
  it('turns grids', () => {
    const g = grid(picture(1));
    expect(turn(turn(turn(turn(g, 1), 1), 1), 1)).toEqual(g);
    expect(turn(turn(g, 1), 3)).toEqual(g);
    expect(turn(g, 2)).toEqual(turn(turn(g, 1), 1));
    expect(correlation(grid(sideways(picture(1))), turn(g, 1))).toBeGreaterThan(0.995); // equal but for rounding
  });

  it('gives copies close hashes and different photos far ones', () => {
    const a = picture(1), g = grid(a), h = hashes(g);
    for (const copy of [half(a), edit(a, (v) => v * 1.15), edit(a, (v, i) => v + ((i * 7919) % 9) - 4)]) {
      const c = hashes(grid(copy));
      expect(hamming(h[0], h[1], c[0], c[1])).toBeLessThanOrEqual(4);
      expect(correlation(g, grid(copy))).toBeGreaterThan(0.97);
    }
    const s = hashes(grid(sideways(a)));
    expect(hamming(h[2], h[3], s[0], s[1])).toBeLessThanOrEqual(2); // a sideways copy matches the turned hash
    const b = grid(picture(2)), hb = hashes(b);
    expect(hamming(h[0], h[1], hb[0], hb[1])).toBeGreaterThan(12);
    expect(correlation(g, b)).toBeLessThan(0.8);
  });

  it('measures plainness, sharpness and colour', () => {
    const a = picture(3);
    expect(flatness(grid(a))).toBeGreaterThan(20);
    expect(flatness(grid(edit(a, () => 30)))).toBe(0);
    const soft = edit(a, (v, i) => { const p = i >> 2, x = p % a.w; return x > 0 ? (v + a.px[i - 4]) / 2 : v; });
    expect(sharpness(a.px, a.w, a.h)).toBeGreaterThan(sharpness(soft.px, soft.w, soft.h));
    const grey = edit(a, (_v, i) => { const p = i - (i % 4); return 0.299 * a.px[p] + 0.587 * a.px[p + 1] + 0.114 * a.px[p + 2]; });
    expect(coloursDiffer(colour(a.px, a.w, a.h), colour(grey.px, grey.w, grey.h))).toBe(true);
    expect(coloursDiffer(colour(a.px, a.w, a.h), colour(half(a).px, a.w / 2, a.h / 2))).toBe(false);
  });
});

function pack(pics: { p: ReturnType<typeof picture>; t?: number; e?: number[] }[]): Packed {
  const n = pics.length;
  const out: Packed = { n, hash: new Uint32Array(n * 8), grid: new Uint8Array(n * 1024), emb: new Int8Array(n * DIM), shape: new Float32Array(n), flat: new Float32Array(n), time: new Float64Array(n), pixels: new Float64Array(n) };
  pics.forEach(({ p, t, e }, i) => {
    const g = grid(p);
    out.grid.set(g, i * 1024); out.hash.set(hashes(g), i * 8); out.shape[i] = p.w / p.h; out.flat[i] = flatness(g);
    out.time[i] = t ?? NaN; out.pixels[i] = p.w * p.h;
    if (e) out.emb.set(quantize(e), i * DIM);
  });
  return out;
}

describe('finding the same photo', () => {
  it('groups resized, brightened and sideways copies, and nothing else', () => {
    const a = picture(1), b = picture(2), c = picture(4);
    const groups = samePhotos(pack([{ p: a }, { p: b }, { p: half(a) }, { p: sideways(a) }, { p: edit(a, (v) => v * 0.85) }, { p: c }, { p: edit(c, () => 128) }, { p: edit(c, () => 128) }]));
    expect(groups.map((g) => g.sort())).toEqual([[0, 2, 3, 4]]); // the two blank pictures are never "the same photo"
  });

  it('does not group a shifted shot of the same scene', () => {
    const a = picture(5, 260, 180);
    const crop = (dx: number) => { const w = 240, h = 180, px = new Uint8ClampedArray(w * h * 4); for (let y = 0; y < h; y++) px.set(a.px.subarray((y * a.w + dx) * 4, (y * a.w + dx + w) * 4), y * w * 4); return { px, w, h }; };
    expect(samePhotos(pack([{ p: crop(0) }, { p: crop(20) }]))).toEqual([]);
  });
});

describe('finding look-alikes', () => {
  const base = Array.from({ length: DIM }, (_, k) => Math.sin(k * 0.37) + 1);
  const near = (amount: number, seed: number) => base.map((v, k) => v + amount * Math.sin(k * seed));
  const min = 60e3, day = 24 * 3600e3;

  it('pairs photos taken close together that look alike', () => {
    const p = pack([
      { p: picture(1), t: 0, e: base },
      { p: picture(2), t: 1 * min, e: near(0.2, 1.3) },
      { p: picture(3), t: 2 * min, e: near(0.25, 2.1) },
      { p: picture(4), t: 3 * day, e: near(0.1, 1.7) }, // alike, but days later
      { p: picture(5), t: 4 * min, e: base.map((_v, k) => Math.cos(k * 1.91) + 1) }, // something else
    ]);
    const pairs = nearPairs(p);
    const groups = lookAlikes(pairs, 0.9);
    expect(groups.map((g) => g.sort())).toEqual([[0, 1, 2]]);
    expect(lookAlikes(pairs, 0.999)).toEqual([]);
    expect(nearPairs(p, Uint8Array.from([0, 1, 1, 0, 0])).length).toBe(0); // extra copies left out
  });

  it("doesn't chain slightly different photos into one big group", () => {
    // a-b and b-c are close, a-c isn't: average closeness of {a,b} to c is too low at a strict setting
    const pairs = Float64Array.from([0, 1, 0.95, 1, 2, 0.93, 0, 2, 0.82]);
    expect(lookAlikes(pairs, 0.9)).toEqual([[0, 1]]);
    expect(lookAlikes(pairs, 0.85)[0].sort()).toEqual([0, 1, 2]);
  });
});
