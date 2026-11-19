import { describe, expect, it } from 'vitest';
import { GROUP_INFO, GROUPS, hasModel, MODEL, parseAnswer, pickSample, pullTotals, roughTime, SCHEMA } from './ollama';

describe('free AI on this PC', () => {
  it('reads a normal answer', () => {
    const a = parseAnswer('{"description":" A white car in a garage. ","sees":["car","garage"],"text":"1HGCM82633A004352","people":0,"group":"car"}');
    expect(a).toEqual({ description: 'A white car in a garage.', sees: ['car', 'garage'], text: '1HGCM82633A004352', people: 0, group: 'car' });
  });

  it('is loose with odd answers instead of failing the photo', () => {
    expect(parseAnswer('Sure! {"description":"x","group":"food","people":"2"} done').group).toBe('food');
    expect(parseAnswer('{"description":"x","group":"food","people":"2"}').people).toBe(2);
    const bad = parseAnswer('not json at all');
    expect(bad).toEqual({ description: '', sees: [], text: '', people: 0, group: 'other' });
    expect(parseAnswer('{"group":"spaceship","sees":"car","people":-3}')).toMatchObject({ group: 'other', sees: [], people: 0 });
    expect(parseAnswer(`{"sees":[${'"a",'.repeat(12)}"b"]}`).sees).toHaveLength(8);
  });

  it('knows a name and a side for every group the AI may answer', () => {
    expect(SCHEMA.properties.group.enum).toEqual(GROUPS);
    for (const g of GROUPS) expect(GROUP_INFO[g].name).toBeTruthy();
    expect(GROUPS.filter((g) => GROUP_INFO[g].junk)).toEqual(['document', 'screenshot', 'label', 'screen_photo', 'scan_tool', 'thermal']);
  });

  it('finds the AI among the installed models', () => {
    expect(hasModel(['llama3:latest', MODEL])).toBe(true);
    expect(hasModel([MODEL.toUpperCase()])).toBe(true);
    expect(hasModel(['gemma4:latest'])).toBe(false);
  });

  it('adds up a download made of several parts', () => {
    const parts = new Map([['a', { total: 100, completed: 50 }], ['b', { total: 300, completed: 0 }]]);
    expect(pullTotals(parts)).toEqual({ done: 50, total: 400 });
  });

  it('picks the same photos for the same seed, different ones for another, never twice the same', () => {
    const list = Array.from({ length: 500 }, (_, i) => i);
    const a = pickSample(list, 20, 7), b = pickSample(list, 20, 7), c = pickSample(list, 20, 8);
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
    expect(new Set(a).size).toBe(20);
    expect(pickSample([1, 2, 3], 20, 1).sort()).toEqual([1, 2, 3]);
  });

  it('says how long the whole library would take in plain words', () => {
    expect(roughTime(90)).toBe('about 2 minutes');
    expect(roughTime(3 * 3600 + 100)).toBe('about 3 hours');
    expect(roughTime(16 * 41140)).toBe('about 8 days');
  });
});
