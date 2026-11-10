import { describe, expect, it, vi } from 'vitest';

const calls: { rpcid: string; data: any }[] = [];
vi.mock('./bridge', () => ({
  ask: async (msg: { rpcid: string; data: any }) => { calls.push({ rpcid: msg.rpcid, data: msg.data }); return { data: [null] }; },
}));
const { inParts, restoreGp, trashGp, TRASH_PART } = await import('./api');

describe('Google Photos trash', () => {
  it('splits lists into parts', () => {
    expect(inParts([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(inParts([], 3)).toEqual([]);
  });

  it('moves items to the Trash in parts of 250, in the format Google Photos uses', async () => {
    calls.length = 0;
    const keys = Array.from({ length: 600 }, (_, i) => 'k' + i);
    const told: number[] = [];
    await trashGp(keys, (part) => { told.push(part.length); });
    expect(TRASH_PART).toBe(250);
    expect(calls.map((c) => c.rpcid)).toEqual(['XwAOJf', 'XwAOJf', 'XwAOJf']);
    expect(calls[0].data).toEqual([null, 1, keys.slice(0, 250), 3]);
    expect(calls[2].data).toEqual([null, 1, keys.slice(500), 3]);
    expect(told).toEqual([250, 250, 100]);
  });

  it('restores from the Trash', async () => {
    calls.length = 0;
    await restoreGp(['a', 'b']);
    expect(calls).toEqual([{ rpcid: 'XwAOJf', data: [null, 3, ['a', 'b'], 2] }]);
  });
});
