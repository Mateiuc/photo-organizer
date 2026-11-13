import { describe, expect, it } from 'vitest';
import { carryOver, group, pairFaces, previewCarry } from './carry';
import { useLimits, type Face, type Person } from './cluster';
import { iou, REFERENCE, similarity, turn } from './ada';

const unitVec = (k: number, wobble = 0) => { const v = new Array(512).fill(0); v[k] = 1; v[(k + 1) % 512] = wobble; const n = Math.hypot(1, wobble); return v.map((x) => x / n); };
const face = (key: string, d: number[], box: Face['box'] = [0.1, 0.1, 0.2, 0.2]): Face => ({ key, itemId: key.split('#')[0], d, box, crop: '', m: 'ada50' });
const old = (key: string, person: string, box: Face['box'] = [0.1, 0.1, 0.2, 0.2]) => ({ ...face(key, new Array(128).fill(0), box), m: undefined, person });

describe('straightening a face', () => {
  it('maps the reference points onto themselves', () => {
    const [a, nb, tx, b, a2, ty] = similarity(REFERENCE);
    expect(a).toBeCloseTo(1); expect(a2).toBeCloseTo(1); expect(b).toBeCloseTo(0); expect(nb).toBeCloseTo(0); expect(tx).toBeCloseTo(0); expect(ty).toBeCloseTo(0);
  });
  it('undoes a turn, size change and shift', () => {
    const c = Math.cos(0.3) * 2, s = Math.sin(0.3) * 2;
    const moved = [];
    for (let i = 0; i < 5; i++) { const x = REFERENCE[2 * i], y = REFERENCE[2 * i + 1]; moved.push(c * x - s * y + 40, s * x + c * y + 7); }
    const [a, nb, tx, b, , ty] = similarity(moved);
    for (let i = 0; i < 5; i++) {
      const x = moved[2 * i], y = moved[2 * i + 1];
      expect(a * x + nb * y + tx).toBeCloseTo(REFERENCE[2 * i], 3);
      expect(b * x + a * y + ty).toBeCloseTo(REFERENCE[2 * i + 1], 3);
    }
  });
  it('tells a straight face from a turned one', () => {
    expect(turn(REFERENCE)).toBeLessThan(0.05);
    expect(turn([40, 50, 70, 50, 68, 70, 45, 90, 70, 90])).toBeGreaterThan(0.8);
  });
  it('measures box overlap', () => {
    expect(iou([0, 0, 1, 1], [0, 0, 1, 1])).toBe(1);
    expect(iou([0, 0, 1, 1], [2, 2, 1, 1])).toBe(0);
    expect(iou([0, 0, 2, 1], [1, 0, 2, 1])).toBeCloseTo(1 / 3);
  });
});

describe('carrying names over to the stronger face AI', () => {
  useLimits(512);
  it('pairs faces in the same photo and spot, one to one', () => {
    const olds = [old('a#0', 'p1', [0.1, 0.1, 0.2, 0.2]), old('a#1', 'p2', [0.6, 0.1, 0.2, 0.2]), old('b#0', 'p1')];
    const news = [face('a#0', unitVec(0), [0.62, 0.12, 0.2, 0.2]), face('a#1', unitVec(1), [0.11, 0.1, 0.19, 0.21]), face('c#0', unitVec(2))];
    const p = pairFaces(olds, news);
    expect(p.get('a#0')).toBe('a#1');
    expect(p.get('a#1')).toBe('a#0');
    expect(p.has('b#0')).toBe(false); // photo b has no new face
  });
  it('keeps names, strangers and "not them", regroups the rest', () => {
    const people = new Map<string, Person>([
      ['nick', { id: 'nick', name: 'Nick', sum: [], n: 2, cover: 'x#0', no: ['y#0', 'gone#0'] }],
      ['anon', { id: 'anon', sum: [], n: 1, cover: 'y#0' }],
      ['str', { id: 'str', sum: [], n: 1, cover: 'z#0', stranger: true }],
      ['ana', { id: 'ana', name: 'Ana', sum: [], n: 1, cover: 'q#0' }],
    ]);
    const faces = new Map([old('x#0', 'nick'), old('w#0', 'nick'), old('y#0', 'anon'), old('z#0', 'str'), old('q#0', 'ana')].map((f) => [f.key, f]));
    const news = [face('x#0', unitVec(0)), face('w#0', unitVec(0, 0.1)), face('y#0', unitVec(5)), face('z#0', unitVec(9)), face('v#0', unitVec(0, 0.05)), face('u#0', unitVec(5, 0.05))];
    let n = 0;
    const r = carryOver(people, faces, news, () => 'new' + n++);
    const owner = Object.fromEntries(r.faces.map((f) => [f.key, f.person]));
    expect(owner['x#0']).toBe('nick');
    expect(owner['w#0']).toBe('nick');
    expect(owner['v#0']).toBe('nick'); // a new photo of Nick joins him, as when photos are first looked at
    expect(owner['z#0']).toBe('str');
    expect(owner['y#0']).toMatch(/^new/); // unnamed people are grouped again
    expect(owner['u#0']).toBe(owner['y#0']);
    const nick = r.people.find((p) => p.id === 'nick')!;
    expect(nick.name).toBe('Nick');
    expect(nick.n).toBe(3);
    expect(nick.no).toEqual(['y#0']);
    expect(r.people.find((p) => p.id === 'str')!.stranger).toBe(true);
    expect(r.lost).toEqual(['Ana']);
    expect(r.named.find((x) => x.name === 'Nick')).toMatchObject({ before: 2, after: 3 });
    expect(previewCarry(people, faces, news)).toEqual([{ name: 'Nick', before: 2, after: 2 }, { name: 'Ana', before: 1, after: 0 }]);
  });
  it('groups many faces quickly', () => {
    const people = new Map<string, Person>();
    const fs = Array.from({ length: 3000 }, (_, i) => face(`i${i}#0`, unitVec(i % 300, ((i * 7) % 10) / 100)));
    let n = 0;
    const t = performance.now();
    const out = group(people, fs, () => 'g' + n++);
    expect(performance.now() - t).toBeLessThan(5000);
    expect(people.size).toBe(300);
    expect(new Set(out.filter(([f]) => f.key.startsWith('i7#') || f.key.startsWith('i307#')).map(([, id]) => id)).size).toBe(1);
  });
});
