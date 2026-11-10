import { describe, expect, it } from 'vitest';
import { parseQueries, PRESETS, union } from './topics';
import { parseTimeline } from '../gphotos/api';

describe('search topics', () => {
  it('reads the searches a topic is made of', () => {
    expect(parseQueries(' car,  vehicle ;truck\nCar ,, engine  bay ')).toEqual(['car', 'vehicle', 'truck', 'engine bay']);
  });
  it('keeps each photo once, in the order found', () => {
    expect(union([['a', 'b'], ['b', 'c'], [], ['a', 'd']])).toEqual(['a', 'b', 'c', 'd']);
  });
  it('starts with Cars, VIN, and Wires & electronics', () => {
    expect(PRESETS.map((p) => p.name)).toEqual(['Cars', 'VIN', 'Wires & electronics']);
    expect(PRESETS.every((p) => p.queries.length && !p.keys.length)).toBe(true);
  });
  it('reads a search answer like a library page', () => {
    const item = (k: string) => [k, ['https://lh3.googleusercontent.com/pw/' + k, 800, 600], 1625493780000, 'D' + k, 0, 1625600000000];
    const p = parseTimeline([[item('K1'), item('K2'), ['broken']], 'NEXT']);
    expect(p.items.map((x) => x.mediaKey)).toEqual(['K1', 'K2']);
    expect(p.next).toBe('NEXT');
    expect(parseTimeline(null).items).toEqual([]); // nothing found
  });
});
