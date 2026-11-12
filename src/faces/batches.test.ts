import { describe, expect, it } from 'vitest';
import { batchesByPerson, isStranger, namedMatches, refOf, score, type FaceGroup } from './batches';
import type { Person } from './cluster';

const vec = (x: number, y = 0) => { const v = new Array(128).fill(0); v[0] = x; v[1] = y; return v; };
const person = (id: string, faces: number[][], extra: Partial<Person> = {}): Person =>
  ({ id, sum: faces.reduce((s, f) => s.map((v, i) => v + f[i]), new Array(128).fill(0)), n: faces.length, cover: id + '#0', ...extra });
const group = (p: Person, faces: string[], items: string[]): FaceGroup => ({ id: p.id, p, faces, items: new Set(items) });

describe('strangers', () => {
  const w = (k: string) => (k.startsWith('small') ? 0.05 : 0.2);
  it('an unnamed face in one photo, small in it, is a stranger', () => {
    expect(isStranger(group(person('a', [vec(0)]), ['small#0'], ['x']), w)).toBe(true);
  });
  it('a big face, a face in 2 photos, or a named person is not', () => {
    expect(isStranger(group(person('a', [vec(0)]), ['big#0'], ['x']), w)).toBe(false);
    expect(isStranger(group(person('a', [vec(0), vec(0)]), ['small#0', 'small#1'], ['x', 'y']), w)).toBe(false);
    expect(isStranger(group(person('a', [vec(0)], { name: 'Ana' }), ['small#0'], ['x']), w)).toBe(false);
  });
  it('what you said wins', () => {
    expect(isStranger(group(person('a', [vec(0)], { stranger: false }), ['small#0'], ['x']), w)).toBe(false);
    expect(isStranger(group(person('a', [vec(0)], { stranger: true }), ['big#0'], ['x']), w)).toBe(true);
  });
});

describe('look-alikes of named people', () => {
  it('a person who looks different in some photos still matches through their nearest faces', () => {
    // Nick: mostly at 0, a few photos at 1 (a different look). Average is near 0.1, far from 1.
    const nickFaces = [...Array(18).fill(0).map(() => vec(0)), vec(1), vec(1), vec(1.05)];
    const ref = refOf(person('nick', nickFaces, { name: 'Nick' }), nickFaces);
    expect(score(ref, vec(1.02))).toBeLessThan(0.1);
    expect(score(ref, vec(0.05))).toBeLessThan(0.1);
    expect(score(ref, vec(3))).toBeGreaterThan(1.5);
  });
  it('keeps at most `max` faces, spread over all of them', () => {
    const faces = Array.from({ length: 1000 }, (_, i) => vec(i / 1000));
    const ref = refOf(person('p', faces), faces, 100);
    expect(ref.n).toBe(100);
    expect(ref.faces[0]).toBe(0);
    expect(ref.faces[99 * 128]).toBeGreaterThan(0.9);
  });
  it('each unnamed face goes to the one person it looks most like, and not to someone you said it isn’t', () => {
    const ana = person('ana', [vec(0)], { name: 'Ana' });
    const bob = person('bob', [vec(0, 1)], { name: 'Bob', no: ['u3'] });
    const refs = [refOf(ana, [vec(0)]), refOf(bob, [vec(0, 1)])];
    const unnamed = [
      { id: 'u1', c: vec(0.1) }, // Ana, very likely
      { id: 'u2', c: vec(0.05, 0.95) }, // Bob
      { id: 'u3', c: vec(0, 0.9) }, // looks like Bob, but you said it isn't Bob; too far from Ana
      { id: 'u4', c: vec(0.55) }, // Ana, maybe
      { id: 'u5', c: vec(5) }, // nobody
    ];
    const b = batchesByPerson(unnamed, refs);
    expect(b.get('ana')?.map((x) => x.id)).toEqual(['u1', 'u4']);
    expect(b.get('bob')?.map((x) => x.id)).toEqual(['u2']);
    expect([...b.values()].flat().some((x) => x.id === 'u3' || x.id === 'u5')).toBe(false);
  });
  it('lists named matches most alike first', () => {
    const refs = [refOf(person('a', [vec(0.3)], { name: 'A' }), [vec(0.3)]), refOf(person('b', [vec(0.1)], { name: 'B' }), [vec(0.1)])];
    expect(namedMatches(refs, vec(0)).map((x) => x.id)).toEqual(['b', 'a']);
  });
});
