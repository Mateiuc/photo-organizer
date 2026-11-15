import { describe, expect, it } from 'vitest';
import { AI_SHAPE, PIC_SHAPE, plan, READ_SIZE, sharpestOf } from './plan';

describe('one read per photo', () => {
  it('makes both pictures from one read when a photo needs both', () => {
    const p = plan(true, true);
    expect(p.shapes).toHaveLength(2);
    expect(p.shapes[p.sort]).toBe(AI_SHAPE);
    expect(p.shapes[p.pic]).toBe(PIC_SHAPE);
  });
  it('makes only what is missing', () => {
    expect(plan(true, false)).toEqual({ shapes: [PIC_SHAPE], pic: 0, sort: -1 });
    expect(plan(false, true)).toEqual({ shapes: [AI_SHAPE], pic: -1, sort: 0 });
    expect(plan(false, false).shapes).toEqual([]);
  });
  it('fetches enough for the AI: a photo twice as wide as high still has 224 rows', () => {
    expect(READ_SIZE / 2).toBeGreaterThanOrEqual((AI_SHAPE as { height: number }).height);
  });
});

describe('the sharpest of a set', () => {
  it('is the highest sharpness when all pictures were made the same way', () => {
    expect(sharpestOf([10, 30, 20], [1, 1, 1])).toBe(1);
    expect(sharpestOf([10, 30, 20], [0, 0, 0])).toBe(1);
  });
  it('compares only the pictures made the way most of the set was', () => {
    // photo 0 is an older ready-made preview, which reads sharper: it isn't compared with the other two
    expect(sharpestOf([100, 60, 70], [0, 1, 1])).toBe(2);
    expect(sharpestOf([100, 60, 70], [0, 0, 1])).toBe(0);
  });
  it('takes the first way on a tie, and gives -1 for an empty set', () => {
    expect(sharpestOf([50, 90], [0, 1])).toBe(0);
    expect(sharpestOf([], [])).toBe(-1);
  });
});
