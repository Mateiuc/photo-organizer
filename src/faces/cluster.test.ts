import { describe, expect, it } from 'vitest';
import { assign, closest, merge, type Face, type Person } from './cluster';

const vec = (x: number, y = 0) => { const v = new Array(128).fill(0); v[0] = x; v[1] = y; return v; };
const face = (key: string, d: number[]): Face => ({ key, itemId: key.split('#')[0], d, box: [0, 0, 1, 1], crop: '' });

describe('grouping faces into people', () => {
  it('puts close faces together and far faces apart', () => {
    const people = new Map<string, Person>();
    let n = 0;
    const id = () => 'p' + n++;
    const a1 = assign(people, face('a#0', vec(0)), id);
    const a2 = assign(people, face('b#0', vec(0.3)), id);
    const b1 = assign(people, face('c#0', vec(0, 2)), id);
    expect(a2.id).toBe(a1.id);
    expect(b1.id).not.toBe(a1.id);
    expect(people.size).toBe(2);
    expect(a1.n).toBe(2);
  });
  it('merges two people and keeps the name', () => {
    const a: Person = { id: 'a', name: 'Ana', sum: vec(1), n: 1, cover: 'x' };
    const b: Person = { id: 'b', sum: vec(3), n: 2, cover: 'y' };
    expect(merge(a, b)).toMatchObject({ id: 'b', name: 'Ana', n: 3 });
  });
});

describe('suggesting who a face belongs to', () => {
  it('lists the nearest people first and skips the face itself', () => {
    const cands = [{ id: 'a', c: vec(0) }, { id: 'b', c: vec(1) }, { id: 'c', c: vec(0.2) }, { id: 'd', c: vec(5) }, { id: 'self', c: vec(0.1) }];
    const r = closest(cands, vec(0.1), 3, (x) => x.id === 'self');
    expect(r.map((x) => x.c.id)).toEqual(['a', 'c', 'b']);
    expect(r[0].dist).toBeCloseTo(0.1);
  });
});
