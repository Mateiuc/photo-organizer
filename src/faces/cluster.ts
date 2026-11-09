// Grouping faces into people. Pure functions, so they can be tested and run anywhere.

/** One face found in a photo. `d` is the face's 128-number fingerprint from the recognition model. */
export interface Face {
  key: string; // `${itemId}#${n}`
  itemId: string;
  d: number[];
  box: [number, number, number, number]; // x, y, w, h as fractions of the picture
  crop: string; // small JPEG of the face, as a data URL
}

/** A group of faces that look like the same person. `sum`/`n` give the average fingerprint. */
export interface Person {
  id: string;
  name?: string;
  sum: number[];
  n: number;
  cover: string; // face key shown as the person's picture
}

/** Two faces closer than this are taken as the same person (the model's usual cut-off is 0.6; lower is stricter). */
export const SAME_PERSON = 0.42;

export function distance(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) { const x = a[i] - b[i]; s += x * x; }
  return Math.sqrt(s);
}

export function centre(p: Person): number[] {
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

/** Below this, a suggested match is very likely the same person; above LIKELY it's only a weak guess. */
export const SURE = 0.5;
export const LIKELY = 0.6;
