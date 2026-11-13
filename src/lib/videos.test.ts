import { describe, expect, it } from 'vitest';
import type { Item } from './model';
import { waDay, whatsAppVideoCopies } from './videos';

const v = (id: string, name: string, durationMs: number, takenAt: string, extra: Partial<Item> = {}): Item =>
  ({ id, name, kind: 'video', mime: 'video/mp4', size: 1e6, durationMs, takenAt, takenFrom: 'camera', tags: [], ...extra });
const path = () => '';

describe('WhatsApp video copies', () => {
  it('reads the day from WhatsApp names', () => {
    expect(waDay(v('a', 'VID-20200313-WA0001.mp4', 5000, '2020-03-20T10:00:00'))).toBe(Date.UTC(2020, 2, 13));
    expect(waDay(v('a', 'WhatsApp Video 2021-07-04 at 12.00.01.mp4', 5000, '2020-03-20T10:00:00'))).toBe(Date.UTC(2021, 6, 4));
    expect(waDay(v('a', 'clip.mp4', 5000, '2020-03-20T10:00:00'))).toBe(Date.UTC(2020, 2, 20));
  });

  it('matches a copy to the one original with the same length, shape and date', () => {
    const orig = v('o', 'VID_20200312_101500.mp4', 15320, '2020-03-12T10:15:00', { width: 1920, height: 1080 });
    const copy = v('c', 'VID-20200313-WA0001.mp4', 15400, '2020-03-13T08:00:00', { width: 848, height: 480, takenFrom: 'upload' });
    const other = v('x', 'VID_20200312_120000.mp4', 9000, '2020-03-12T12:00:00');
    expect(whatsAppVideoCopies([orig, copy, other], path).map((g) => g.map((x) => x.id))).toEqual([['o', 'c']]);
  });

  it('accepts a copy turned sideways', () => {
    const orig = v('o', 'a.mp4', 8000, '2020-03-12T10:15:00', { width: 1920, height: 1080 });
    const copy = v('c', 'VID-20200313-WA0001.mp4', 8000, '2020-03-13T08:00:00', { width: 480, height: 848 });
    expect(whatsAppVideoCopies([orig, copy], path)).toHaveLength(1);
  });

  it('leaves out a different length, another shape, a date too far, short videos, and unsure matches', () => {
    const copy = v('c', 'VID-20200313-WA0001.mp4', 15400, '2020-03-13T08:00:00', { width: 848, height: 480 });
    expect(whatsAppVideoCopies([copy, v('o', 'a.mp4', 16000, '2020-03-12T10:00:00')], path)).toEqual([]);
    expect(whatsAppVideoCopies([copy, v('o', 'a.mp4', 15400, '2020-03-12T10:00:00', { width: 1000, height: 1000 })], path)).toEqual([]);
    expect(whatsAppVideoCopies([copy, v('o', 'a.mp4', 15400, '2020-02-01T10:00:00')], path)).toEqual([]);
    expect(whatsAppVideoCopies([copy, v('o', 'a.mp4', 15400, '2020-03-17T10:00:00')], path)).toEqual([]);
    const short = v('s', 'VID-20200313-WA0002.mp4', 1500, '2020-03-13T08:00:00');
    expect(whatsAppVideoCopies([short, v('o', 'a.mp4', 1500, '2020-03-12T10:00:00')], path)).toEqual([]);
    expect(whatsAppVideoCopies([copy, v('o1', 'a.mp4', 15400, '2020-03-12T10:00:00'), v('o2', 'b.mp4', 15350, '2020-03-11T10:00:00')], path)).toEqual([]);
  });

  it('never matches two WhatsApp copies with each other, and finds copies by their WhatsApp folder too', () => {
    const a = v('a', 'VID-20200313-WA0001.mp4', 15400, '2020-03-13T08:00:00');
    const b = v('b', 'VID-20200313-WA0002.mp4', 15400, '2020-03-13T08:00:00');
    expect(whatsAppVideoCopies([a, b], path)).toEqual([]);
    const inFolder = v('f', 'video.mp4', 15400, '2020-03-13T08:00:00', { folderId: 'wa' });
    const orig = v('o', 'a.mp4', 15400, '2020-03-12T10:00:00');
    expect(whatsAppVideoCopies([orig, inFolder], (id) => (id === 'wa' ? 'Phone/WhatsApp/Media/WhatsApp Video' : '')).map((g) => g.map((x) => x.id))).toEqual([['o', 'f']]);
  });
});
