import { afterEach, describe, expect, it } from 'vitest';
import { clearTicks, forgetTicks, rangeIn, selectAllShown, selection, setTicked, showList, shownIds, startSelecting, stopSelecting, toggleTick } from './selection';

const ticked = () => [...selection.ids].sort();
const cleanups: (() => void)[] = [];
afterEach(() => { cleanups.splice(0).forEach((f) => f()); stopSelecting(); });

describe('selection', () => {
  it('finds the range between two photos in either direction', () => {
    const l = ['a', 'b', 'c', 'd', 'e'];
    expect(rangeIn(l, 'b', 'd')).toEqual(['b', 'c', 'd']);
    expect(rangeIn(l, 'e', 'c')).toEqual(['c', 'd', 'e']);
    expect(rangeIn(l, 'a', 'x')).toBeUndefined();
  });

  it('ticks and unticks one photo, and turns select mode on', () => {
    toggleTick('a');
    expect(selection.on).toBe(true);
    expect(ticked()).toEqual(['a']);
    toggleTick('a');
    expect(ticked()).toEqual([]);
  });

  it('Shift-click ticks every photo in between, in the order shown', () => {
    cleanups.push(showList(['p1', 'p2', 'p3', 'p4', 'p5', 'p6']));
    toggleTick('p2');
    toggleTick('p5', true);
    expect(ticked()).toEqual(['p2', 'p3', 'p4', 'p5']);
    // the range starts again from the last photo clicked
    toggleTick('p6', true);
    expect(ticked()).toEqual(['p2', 'p3', 'p4', 'p5', 'p6']);
  });

  it('Shift-click without a photo clicked first just ticks that photo', () => {
    cleanups.push(showList(['p1', 'p2', 'p3']));
    toggleTick('p3', true);
    expect(ticked()).toEqual(['p3']);
  });

  it('ticks a whole month and selects everything shown', () => {
    cleanups.push(showList(['a', 'b']), showList(['b', 'c']));
    expect(shownIds().sort()).toEqual(['a', 'b', 'c']);
    setTicked(['a', 'b'], true);
    expect(ticked()).toEqual(['a', 'b']);
    setTicked(['a'], false);
    expect(ticked()).toEqual(['b']);
    selectAllShown();
    expect(ticked()).toEqual(['a', 'b', 'c']);
  });

  it('a list that leaves the screen is no longer part of Select all', () => {
    const off = showList(['x', 'y']);
    cleanups.push(showList(['z']));
    off();
    startSelecting();
    selectAllShown();
    expect(ticked()).toEqual(['z']);
  });

  it('Clear keeps select mode on; Done leaves it; moved photos are unticked', () => {
    setTicked(['a', 'b', 'c'], true);
    forgetTicks(['b']);
    expect(ticked()).toEqual(['a', 'c']);
    clearTicks();
    expect(selection.on).toBe(true);
    expect(ticked()).toEqual([]);
    stopSelecting();
    expect(selection.on).toBe(false);
  });
});
