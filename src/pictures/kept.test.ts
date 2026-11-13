import { describe, expect, it } from 'vitest';
import { isKept } from './kept';

describe('duplicate sets you kept', () => {
  it('hides a kept set, and a smaller part of it, but not a set with a new copy', () => {
    const sets = [['a', 'b', 'c']];
    expect(isKept(sets, ['b', 'a'])).toBe(true);
    expect(isKept(sets, ['a', 'b', 'c'])).toBe(true);
    expect(isKept(sets, ['a', 'd'])).toBe(false);
    expect(isKept([], ['a', 'b'])).toBe(false);
  });
});
