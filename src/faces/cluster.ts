// Grouping faces into people. Pure functions, so they can be tested and run anywhere.

/** One face found in a photo. `d` is the face's 128-number fingerprint from the recognition model. */
export interface Face {
  key: string; // `${itemId}#${n}`
  itemId: string;
  d: number[];
  box: [number, number, number, number]; // x, y, w, h as fractions of the picture
  crop: string; // small JPEG of the face, as a data URL
  /** Which face AI made `d`: 'ada50' (AdaFace, 512 numbers). Unset: the older face-api (128 numbers). */
  m?: string;
  /** AdaFace only: how sure the detector was that it's a face, and how much the head is turned (0 straight on, 1 profile). */
  s?: number;
  t?: number;
}

/** A group of faces that look like the same person. `sum`/`n` give the average fingerprint. */
export interface Person {
  id: string;
  name?: string;
  sum: number[];
  n: number;
  cover: string; // face key shown as the person's picture
  /** You set this face aside as a stranger (true) or brought it back (false). Unset: decided by size and count. */
  stranger?: boolean;
  /** For a named person: unnamed faces you said aren't them, so they aren't suggested for them again. */
  no?: string[];
}

/**
 * How close two fingerprints must be, for the face AI in use. face-api's fingerprints are 128 numbers (its usual
 * cut-off is 0.6); AdaFace's are 512 numbers of length 1, so their distances run 0…2 (see faces/README for how the
 * AdaFace numbers were measured). Lower is stricter.
 *   same: a new face joins that person by itself. sure: "very likely". likely: "maybe". best: a near-certain match
 *   (used only to draw the closeness bar). margin: how far past `likely` a person's average face may be and still
 *   be worth comparing face by face.
 */
export interface Limits { same: number; sure: number; likely: number; best: number; margin: number }
export const FACE_API_LIMITS: Limits = { same: 0.42, sure: 0.5, likely: 0.6, best: 0.3, margin: 0.2 };
export const ADA_LIMITS: Limits = { same: 0.95, sure: 1.0, likely: 1.1, best: 0.7, margin: 0.2 };
export let SAME_PERSON = FACE_API_LIMITS.same;
/** Below this, a suggested match is very likely the same person; above LIKELY it's only a weak guess. */
export let SURE = FACE_API_LIMITS.sure;
export let LIKELY = FACE_API_LIMITS.likely;
export let BEST = FACE_API_LIMITS.best;
export let MARGIN = FACE_API_LIMITS.margin;
/** Sets the limits for the face AI whose fingerprints are in use (by their length: 512 is AdaFace). */
export function useLimits(dim: number) {
  const l = dim === 512 ? ADA_LIMITS : FACE_API_LIMITS;
  SAME_PERSON = l.same; SURE = l.sure; LIKELY = l.likely; BEST = l.best; MARGIN = l.margin;
}

export function distance(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) { const x = a[i] - b[i]; s += x * x; }
  return Math.sqrt(s);
}

/** A person's average face. AdaFace's is scaled back to length 1, like each of its fingerprints. */
export function centre(p: Person): number[] {
  if (p.sum.length === 512) {
    let ss = 0;
    for (const v of p.sum) ss += v * v;
    const len = Math.sqrt(ss) || 1;
    return p.sum.map((v) => v / len);
  }
  return p.sum.map((v) => v / p.n);
}

/** The person whose average face is nearest, if near enough. */
export function nearest(people: Iterable<Person>, d: number[], limit = SAME_PERSON): Person | undefined {
  let best: Person | undefined, bestD = limit;
  for (const p of people) {
    const dist = distance(centre(p), d);
    if (dist < bestD) { best = p; bestD = dist; }
  }
  return best;
}

/** Puts a face with the nearest person, or starts a new person. Returns the person (changed in place, or new). */
export function assign(people: Map<string, Person>, face: Face, newId: () => string): Person {
  const p = nearest(people.values(), face.d);
  if (p) {
    p.sum = p.sum.map((v, i) => v + face.d[i]);
    p.n++;
    return p;
  }
  const np: Person = { id: newId(), sum: [...face.d], n: 1, cover: face.key };
  people.set(np.id, np);
  return np;
}

/** Joins person `from` into `into` (they are the same person). */
export function merge(from: Person, into: Person): Person {
  return { ...into, name: into.name ?? from.name, sum: into.sum.map((v, i) => v + from.sum[i]), n: into.n + from.n };
}

/** Takes one face out of a person ("not this person"). */
export function without(p: Person, face: Face): Person {
  return { ...p, sum: p.sum.map((v, i) => v - face.d[i]), n: Math.max(0, p.n - 1) };
}

/** The `k` people whose average face is nearest to `d`, nearest first, with their distance. */
export function closest<T extends { c: ArrayLike<number> }>(cands: T[], d: ArrayLike<number>, k = 3, skip?: (c: T) => boolean): { c: T; dist: number }[] {
  const best: { c: T; dist: number }[] = [];
  for (const c of cands) {
    if (skip?.(c)) continue;
    let s = 0;
    for (let i = 0; i < d.length; i++) { const x = c.c[i] - d[i]; s += x * x; }
    if (best.length === k && s >= best[k - 1].dist) continue;
    best.push({ c, dist: s });
    best.sort((a, b) => a.dist - b.dist);
    if (best.length > k) best.pop();
  }
  return best.map((b) => ({ c: b.c, dist: Math.sqrt(b.dist) }));
}
