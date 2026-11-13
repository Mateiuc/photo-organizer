// The stronger face AI: RetinaFace finds faces and 5 points on each (eyes, nose, mouth corners); each face is then
// straightened and cut to 112×112 the way AdaFace was trained, and AdaFace turns it into a 512-number fingerprint.
// Pure functions on plain pixel arrays (no canvas, no AI runtime), so the same code runs in the app and in tests.

/** The face AI models, where they come from, and their SHA-256 (checked after download). */
export const MODELS = {
  detector: {
    file: 'retinaface_mnet_v2.onnx',
    url: 'https://huggingface.co/yakhyo/uniface-weights/resolve/cbe2dcc059a4a4e36b786c30b06975efcc28039b/retinaface_mnet_v2.onnx',
    sha256: '3ca44c045651cabeed1193a1fae8946ad1f3a55da8fa74b341feab5a8319f757',
    bytes: 12506811,
  },
  recognizer: {
    file: 'adaface_ir_50.onnx',
    url: 'https://huggingface.co/yakhyo/uniface-weights/resolve/cbe2dcc059a4a4e36b786c30b06975efcc28039b/adaface_ir_50.onnx',
    sha256: '9c0ae385d7362323c92d218de598d32e52a9130b78faac6a8a924091aca62c0b',
    bytes: 174396180,
  },
} as const;

/** Which face AI made a fingerprint. Old faces (no `m`) were made by face-api. */
export const ADA = 'ada50';

/** An RGBA picture, as from canvas getImageData. */
export interface Rgba { data: Uint8ClampedArray | Uint8Array; width: number; height: number }

/** A face found by the detector, in the picture's pixels. */
export interface Found {
  box: [number, number, number, number]; // x, y, w, h
  score: number;
  points: number[]; // 5 points as x0, y0, … x4, y4: left eye, right eye, nose, left mouth, right mouth
}

// ---------- finding faces (RetinaFace) ----------
/** Pictures are shrunk to this longer side for finding faces (a 40-pixel face in a 1024-wide photo stays 25 pixels). */
export const DETECT_SIDE = 640;
const MEAN_BGR = [104, 117, 123];
const STEPS = [8, 16, 32];
const MIN_SIZES = [[16, 32], [64, 128], [256, 512]];

/**
 * The picture shrunk (never enlarged) so its longer side is at most `maxSide`, padded to a multiple of 32, as the
 * detector's input: BGR, minus the mean, channels first. `scale` turns detector pixels back into picture pixels.
 */
export function detectorInput(img: Rgba, maxSide = DETECT_SIDE): { data: Float32Array; w: number; h: number; scale: number } {
  const k = Math.min(1, maxSide / Math.max(img.width, img.height));
  const rw = Math.max(1, Math.round(img.width * k)), rh = Math.max(1, Math.round(img.height * k));
  const w = Math.ceil(rw / 32) * 32, h = Math.ceil(rh / 32) * 32;
  const out = new Float32Array(3 * w * h);
  const plane = w * h;
  for (let c = 0; c < 3; c++) out.fill(-MEAN_BGR[c], c * plane, (c + 1) * plane);
  const sx = img.width / rw, sy = img.height / rh;
  const px = new Float32Array(3);
  for (let y = 0; y < rh; y++) {
    for (let x = 0; x < rw; x++) {
      sample(img, (x + 0.5) * sx - 0.5, (y + 0.5) * sy - 0.5, px);
      const o = y * w + x;
      out[o] = px[2] - MEAN_BGR[0]; // B
      out[plane + o] = px[1] - MEAN_BGR[1]; // G
      out[2 * plane + o] = px[0] - MEAN_BGR[2]; // R
    }
  }
  return { data: out, w, h, scale: 1 / k };
}

/** Bilinear sample of the picture at (x, y) into out[0..2] as R, G, B. Outside the picture is black. */
function sample(img: Rgba, x: number, y: number, out: Float32Array) {
  const { data, width: W, height: H } = img;
  const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
  out[0] = out[1] = out[2] = 0;
  for (let j = 0; j < 2; j++) {
    const yy = y0 + j;
    if (yy < 0 || yy >= H) continue;
    const wy = j ? fy : 1 - fy;
    for (let i = 0; i < 2; i++) {
      const xx = x0 + i;
      if (xx < 0 || xx >= W) continue;
      const wgt = wy * (i ? fx : 1 - fx);
      if (!wgt) continue;
      const o = (yy * W + xx) * 4;
      out[0] += data[o] * wgt; out[1] += data[o + 1] * wgt; out[2] += data[o + 2] * wgt;
    }
  }
}

/** The detector's prior boxes for an input of w×h, as cx, cy, w, h fractions. */
export function priors(w: number, h: number): Float32Array {
  const out: number[] = [];
  STEPS.forEach((s, k) => {
    const fh = Math.ceil(h / s), fw = Math.ceil(w / s);
    for (let i = 0; i < fh; i++) for (let j = 0; j < fw; j++) for (const m of MIN_SIZES[k]) out.push(((j + 0.5) * s) / w, ((i + 0.5) * s) / h, m / w, m / h);
  });
  return Float32Array.from(out);
}

/**
 * Turns the detector's raw outputs into faces in picture pixels: keeps those scoring over `minScore`, then drops
 * boxes that overlap a better one by more than `nms`.
 */
export function decodeFaces(
  loc: ArrayLike<number>, conf: ArrayLike<number>, lm: ArrayLike<number>,
  inp: { w: number; h: number; scale: number }, minScore = 0.6, nms = 0.4,
): Found[] {
  const pr = priors(inp.w, inp.h);
  const n = pr.length / 4;
  const cand: Found[] = [];
  const sw = inp.w * inp.scale, sh = inp.h * inp.scale;
  for (let i = 0; i < n; i++) {
    const score = conf[i * 2 + 1];
    if (!(score > minScore)) continue;
    const pcx = pr[i * 4], pcy = pr[i * 4 + 1], pw = pr[i * 4 + 2], ph = pr[i * 4 + 3];
    const cx = pcx + loc[i * 4] * 0.1 * pw, cy = pcy + loc[i * 4 + 1] * 0.1 * ph;
    const bw = pw * Math.exp(loc[i * 4 + 2] * 0.2), bh = ph * Math.exp(loc[i * 4 + 3] * 0.2);
    const points: number[] = [];
    for (let p = 0; p < 5; p++) points.push((pcx + lm[i * 10 + p * 2] * 0.1 * pw) * sw, (pcy + lm[i * 10 + p * 2 + 1] * 0.1 * ph) * sh);
    cand.push({ box: [(cx - bw / 2) * sw, (cy - bh / 2) * sh, bw * sw, bh * sh], score, points });
  }
  cand.sort((a, b) => b.score - a.score);
  const keep: Found[] = [];
  for (const c of cand) if (keep.every((k) => iou(k.box, c.box) <= nms)) keep.push(c);
  return keep;
}

/** How much two x, y, w, h boxes overlap: 0 (not at all) to 1 (the same box). */
export function iou(a: readonly number[], b: readonly number[]): number {
  const x1 = Math.max(a[0], b[0]), y1 = Math.max(a[1], b[1]);
  const x2 = Math.min(a[0] + a[2], b[0] + b[2]), y2 = Math.min(a[1] + a[3], b[1] + b[3]);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const u = a[2] * a[3] + b[2] * b[3] - inter;
  return u > 0 ? inter / u : 0;
}

// ---------- straightening a face (5-point alignment) ----------
/** Where the 5 points sit on a straight 112×112 face (the standard ArcFace/AdaFace layout). */
export const REFERENCE = [38.2946, 51.6963, 73.5318, 51.5014, 56.0252, 71.7366, 41.5493, 92.3655, 70.7299, 92.2041];

/**
 * The turn, size change and shift (no mirroring) that best moves the face's 5 points onto REFERENCE, as the
 * 2×3 matrix [a, -b, tx; b, a, ty] (least squares, the same result as Umeyama's method).
 */
export function similarity(points: readonly number[], ref: readonly number[] = REFERENCE): number[] {
  let mx = 0, my = 0, mu = 0, mv = 0;
  for (let i = 0; i < 5; i++) { mx += points[2 * i]; my += points[2 * i + 1]; mu += ref[2 * i]; mv += ref[2 * i + 1]; }
  mx /= 5; my /= 5; mu /= 5; mv /= 5;
  let sxx = 0, sa = 0, sb = 0;
  for (let i = 0; i < 5; i++) {
    const x = points[2 * i] - mx, y = points[2 * i + 1] - my, u = ref[2 * i] - mu, v = ref[2 * i + 1] - mv;
    sxx += x * x + y * y; sa += x * u + y * v; sb += x * v - y * u;
  }
  const a = sxx ? sa / sxx : 1, b = sxx ? sb / sxx : 0;
  return [a, -b, mu - a * mx + b * my, b, a, mv - b * mx - a * my];
}

/**
 * The straightened 112×112 face as AdaFace's input: BGR, scaled to -1…1, channels first. Written into `out` at
 * `offset` (so several faces can share one batch).
 */
export function alignedInput(img: Rgba, points: readonly number[], out = new Float32Array(3 * 112 * 112), offset = 0): Float32Array {
  const [a, nb, tx, b, , ty] = similarity(points);
  // inverse of [a -b; b a]: (1/(a²+b²)) [a b; -b a]
  const det = a * a + b * b || 1;
  const ia = a / det, ib = b / det;
  const S = 112, plane = S * S;
  const px = new Float32Array(3);
  void nb;
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const dx = x - tx, dy = y - ty;
      sample(img, ia * dx + ib * dy, -ib * dx + ia * dy, px);
      const o = offset + y * S + x;
      out[o] = (px[2] - 127.5) / 127.5; // B
      out[o + plane] = (px[1] - 127.5) / 127.5; // G
      out[o + 2 * plane] = (px[0] - 127.5) / 127.5; // R
    }
  }
  return out;
}

/** Scales a fingerprint to length 1; returns it and its length before. */
export function unit(v: ArrayLike<number>): { d: Float32Array; norm: number } {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i] * v[i];
  const norm = Math.sqrt(s);
  const d = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) d[i] = norm ? v[i] / norm : 0;
  return { d, norm };
}

/**
 * How much the face is turned sideways, from the 5 points: 0 straight on, 1 in profile. The nose sits halfway
 * between the eyes on a straight face and moves towards one eye as the head turns.
 */
export function turn(points: readonly number[]): number {
  const [lx, , rx, , nx] = points;
  const span = rx - lx;
  if (span <= 0) return 1;
  return Math.min(1, Math.abs((nx - lx) / span - 0.5) * 2);
}
