// Naming faces in batches: which unnamed faces look like someone you already named, and which faces are strangers.
// Pure functions, so they can be tested and run anywhere.
import { LIKELY, type Person } from './cluster';

/** A face narrower than this share of its picture is "small" (someone in the background, a crowd, a poster). */
export const SMALL_FACE = 0.08;

/** A group of faces as the People page sees it. */
export interface FaceGroup { id: string; p: Person; faces: string[]; items: Set<string> }

/**
 * Set aside as a stranger: you said so; or, if you didn't say, an unnamed face seen in only one photo and small in it.
 * A named person is never a stranger.
 */
export function isStranger(g: FaceGroup, width: (faceKey: string) => number): boolean {
  if (g.p.name) return false;
  if (g.p.stranger != null) return g.p.stranger;
  return g.items.size === 1 && g.faces.every((k) => width(k) < SMALL_FACE);
}

/** A named person, ready for comparing: their average face and up to `max` of their faces. */
export interface Ref { id: string; centre: Float32Array; faces: Float32Array; n: number; no: Set<string> }

export function refOf(p: Person, faceFingerprints: ArrayLike<number>[], max = 100): Ref {
  const dim = p.sum.length;
  const step = Math.max(1, faceFingerprints.length / max); // spread over all their faces, not only the first ones
  const pick: ArrayLike<number>[] = [];
  for (let i = 0; i < faceFingerprints.length && pick.length < max; i += step) pick.push(faceFingerprints[Math.floor(i)]);
  const faces = new Float32Array(pick.length * dim);
  pick.forEach((d, i) => faces.set(d, i * dim));
  return { id: p.id, centre: Float32Array.from(p.sum, (v) => v / Math.max(1, p.n)), faces, n: pick.length, no: new Set(p.no ?? []) };
}

function dist(a: ArrayLike<number>, b: ArrayLike<number>, bo = 0): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) { const x = a[i] - b[bo + i]; s += x * x; }
  return Math.sqrt(s);
}

/**
 * How far a face (fingerprint `d`) is from a named person; lower is more alike. It is the nearer of two measures:
 * distance to their average face, and the average distance to their 3 most alike faces (which helps when someone
 * looks different across photos, like a child growing up). Same scale as the rest of the app: under 0.5 very likely,
 * under 0.6 maybe.
 */
export function score(ref: Ref, d: ArrayLike<number>): number {
  const c = dist(d, ref.centre);
  if (!ref.n) return c;
  const dim = d.length;
  const best = [Infinity, Infinity, Infinity];
  for (let f = 0; f < ref.n; f++) {
    const x = dist(d, ref.faces, f * dim);
    if (x < best[2]) { best[2] = x; best.sort((a, b) => a - b); }
  }
  const k = Math.min(3, ref.n);
  let m = 0;
  for (let i = 0; i < k; i++) m += best[i];
  return Math.min(c, m / k);
}

/** Named people that a face looks like, most alike first (only those under `limit`). */
export function namedMatches(refs: Ref[], d: ArrayLike<number>, opts: { limit?: number; skipNo?: string } = {}): { id: string; dist: number }[] {
  const limit = opts.limit ?? LIKELY;
  const out: { id: string; dist: number }[] = [];
  for (const r of refs) {
    if (opts.skipNo && r.no.has(opts.skipNo)) continue;
    if (dist(d, r.centre) > limit + 0.2) continue; // far from their average: no need to look at every face
    const s = score(r, d);
    if (s < limit) out.push({ id: r.id, dist: s });
  }
  return out.sort((a, b) => a.dist - b.dist);
}

/**
 * Each unnamed group goes to the one named person it looks most like (if under `limit`), skipping people you said it
 * isn't. Returns named person → their look-alikes, most alike first.
 */
export function batchesByPerson(unnamed: { id: string; c: ArrayLike<number> }[], refs: Ref[], limit = LIKELY): Map<string, { id: string; dist: number }[]> {
  const out = new Map<string, { id: string; dist: number }[]>();
  for (const g of unnamed) {
    const best = namedMatches(refs, g.c, { limit, skipNo: g.id })[0];
    if (!best) continue;
    const a = out.get(best.id);
    if (a) a.push({ id: g.id, dist: best.dist }); else out.set(best.id, [{ id: g.id, dist: best.dist }]);
  }
  for (const a of out.values()) a.sort((x, y) => x.dist - y.dist);
  return out;
}
