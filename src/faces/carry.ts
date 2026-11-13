// Moving from the older face AI to the stronger one: every photo was read again, so each new face is matched with
// the old face in the same photo and the same spot, and takes that face's person (its name, "stranger" mark and
// "not them" list). New faces with no old face there are grouped as usual. Pure, so it can be tested.
import { iou } from './ada';
import { SAME_PERSON, type Face, type Person } from './cluster';

type Owned = Face & { person: string };

/** Two boxes in the same photo are the same face when they overlap at least this much. */
export const SAME_SPOT = 0.3;

export interface Carried {
  people: Person[];
  faces: Owned[];
  /** Named people none of whose faces were found again (shown, so nobody disappears unnoticed). */
  lost: string[];
  /** Per named person: faces before and after. */
  named: { id: string; name: string; before: number; after: number }[];
}

/** Old face key → new face key, pairing the most overlapping boxes first, one to one, per photo. */
export function pairFaces(oldFaces: Iterable<Owned>, newFaces: Iterable<Face>): Map<string, string> {
  const byItem = new Map<string, Owned[]>();
  for (const f of oldFaces) { const a = byItem.get(f.itemId); a ? a.push(f) : byItem.set(f.itemId, [f]); }
  const newByItem = new Map<string, Face[]>();
  for (const f of newFaces) { const a = newByItem.get(f.itemId); a ? a.push(f) : newByItem.set(f.itemId, [f]); }
  const out = new Map<string, string>();
  for (const [item, nfs] of newByItem) {
    const ofs = byItem.get(item);
    if (!ofs) continue;
    const pairs: [number, Owned, Face][] = [];
    for (const o of ofs) for (const n of nfs) { const v = iou(o.box, n.box); if (v >= SAME_SPOT) pairs.push([v, o, n]); }
    pairs.sort((a, b) => b[0] - a[0]);
    const usedNew = new Set<string>();
    for (const [, o, n] of pairs) if (!out.has(o.key) && !usedNew.has(n.key)) { out.set(o.key, n.key); usedNew.add(n.key); }
  }
  return out;
}

export function carryOver(oldPeople: Map<string, Person>, oldFaces: Map<string, Owned>, newFaces: Face[], newId: () => string): Carried {
  const pairs = pairFaces(oldFaces.values(), newFaces);
  const ownerOfNew = new Map<string, string>();
  for (const [ok, nk] of pairs) ownerOfNew.set(nk, oldFaces.get(ok)!.person);
  // People worth keeping: named ones, and ones you marked as a stranger or brought back.
  const keep = new Map<string, Person>();
  for (const p of oldPeople.values()) {
    if (!p.name && p.stranger == null) continue;
    const no = (p.no ?? []).map((k) => pairs.get(k)).filter((k): k is string => !!k);
    keep.set(p.id, { id: p.id, ...(p.name ? { name: p.name } : {}), ...(p.stranger != null ? { stranger: p.stranger } : {}), ...(no.length ? { no } : {}), sum: new Array(newFaces[0]?.d.length ?? 512).fill(0), n: 0, cover: pairs.get(p.cover) ?? '' });
  }
  const people = new Map<string, Person>();
  const faces: Owned[] = [];
  const rest: Face[] = [];
  // 1. Faces in the same spot as a kept person's old face join that person.
  for (const f of newFaces) {
    const p = keep.get(ownerOfNew.get(f.key) ?? '');
    if (!p) { rest.push(f); continue; }
    for (let i = 0; i < f.d.length; i++) p.sum[i] += f.d[i];
    p.n++;
    if (!p.cover) p.cover = f.key;
    people.set(p.id, p);
    faces.push({ ...f, person: p.id });
  }
  // A cover face that wasn't carried over is replaced by one that was.
  const ownerOf = new Map(faces.map((f) => [f.key, f.person]));
  for (const p of people.values()) if (ownerOf.get(p.cover) !== p.id) p.cover = faces.find((f) => f.person === p.id)!.key;
  // 2. The rest are grouped as when photos are first looked at: with the nearest person if close enough, else alone.
  for (const [f, id] of group(people, rest, newId)) faces.push({ ...f, person: id });
  const count = new Map<string, number>();
  for (const f of oldFaces.values()) count.set(f.person, (count.get(f.person) ?? 0) + 1);
  const named = [...oldPeople.values()].filter((p) => p.name).map((p) => ({ id: p.id, name: p.name!, before: count.get(p.id) ?? 0, after: people.get(p.id)?.n ?? 0 }));
  return { people: [...people.values()], faces, lost: named.filter((x) => !x.after).map((x) => x.name), named };
}

/**
 * Puts each face with the person whose average face is nearest (if nearer than SAME_PERSON), else starts a new
 * person: the same as cluster.assign, but keeping every average face ready, so tens of thousands of faces take
 * seconds. AdaFace fingerprints only (length 1, so distance = √(2 − 2·dot)). Changes `people` in place.
 */
export function group(people: Map<string, Person>, faces: Face[], newId: () => string): [Face, string][] {
  const dim = 512;
  let cap = Math.max(64, people.size + faces.length);
  let cent = new Float32Array(cap * dim);
  const ids: string[] = [];
  const setCentre = (row: number, sum: number[]) => {
    let ss = 0;
    for (let i = 0; i < dim; i++) ss += sum[i] * sum[i];
    const k = 1 / (Math.sqrt(ss) || 1);
    for (let i = 0; i < dim; i++) cent[row * dim + i] = sum[i] * k;
  };
  for (const p of people.values()) { setCentre(ids.length, p.sum); ids.push(p.id); }
  const minDot = 1 - (SAME_PERSON * SAME_PERSON) / 2;
  const out: [Face, string][] = [];
  for (const f of faces) {
    let best = -1, bestDot = minDot;
    for (let r = 0, o = 0; r < ids.length; r++, o += dim) {
      let s = 0;
      for (let i = 0; i < dim; i++) s += cent[o + i] * f.d[i];
      if (s > bestDot) { bestDot = s; best = r; }
    }
    if (best >= 0) {
      const p = people.get(ids[best])!;
      for (let i = 0; i < dim; i++) p.sum[i] += f.d[i];
      p.n++;
      setCentre(best, p.sum);
      out.push([f, p.id]);
    } else {
      const p: Person = { id: newId(), sum: [...f.d], n: 1, cover: f.key };
      people.set(p.id, p);
      if (ids.length >= cap) { cap *= 2; const c = new Float32Array(cap * dim); c.set(cent); cent = c; }
      setCentre(ids.length, p.sum);
      ids.push(p.id);
      out.push([f, p.id]);
    }
  }
  return out;
}

/** Quick look before switching: per named person, faces now and faces found again in the same spot. */
export function previewCarry(oldPeople: Map<string, Person>, oldFaces: Map<string, Owned>, newFaces: Iterable<Face>): { name: string; before: number; after: number }[] {
  const pairs = pairFaces(oldFaces.values(), newFaces);
  const before = new Map<string, number>(), after = new Map<string, number>();
  for (const f of oldFaces.values()) {
    before.set(f.person, (before.get(f.person) ?? 0) + 1);
    if (pairs.has(f.key)) after.set(f.person, (after.get(f.person) ?? 0) + 1);
  }
  return [...oldPeople.values()].filter((p) => p.name).map((p) => ({ name: p.name!, before: before.get(p.id) ?? 0, after: after.get(p.id) ?? 0 })).sort((a, b) => b.before - a.before);
}
