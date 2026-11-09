import { describe, expect, it } from 'vitest';
import { applyFilters, dateFromName, emptyFilters, exactDuplicates, exifToIso, kindOf, pickKeeper, sizedThumb, toItem, type Item } from './model';

describe('dates', () => {
  it('reads camera time', () => expect(exifToIso('2017:07:01 17:25:23')).toBe('2017-07-01T17:25:23'));
  it('ignores empty camera time', () => expect(exifToIso('0000:00:00 00:00:00')).toBeUndefined());
  it('reads renamed camera files', () => expect(dateFromName('2017_07_01-17.25.23.jpg')).toBe('2017-07-01T17:25:23'));
  it('reads phone files', () => expect(dateFromName('IMG_20200313_155816.jpg')).toBe('2020-03-13T15:58:16'));
  it('reads WhatsApp files', () => expect(dateFromName('IMG-20200313-WA0045.jpeg')).toBe('2020-03-13T12:00:00'));
  it('rejects nonsense', () => expect(dateFromName('DSC_4411.NEF')).toBeUndefined());
});

describe('kinds', () => {
  it('video', () => expect(kindOf('a.mp4', 'video/mp4')).toBe('video'));
  it('raw', () => expect(kindOf('DSC_1.NEF', 'image/x-nikon-nef')).toBe('raw'));
  it('screenshot', () => expect(kindOf('Screenshot_2020.png', 'image/png')).toBe('screenshot'));
  it('not media', () => expect(kindOf('a.pdf', 'application/pdf')).toBeNull());
});

const base = (o: Partial<Item>): Item => ({ id: 'x', name: 'x.jpg', kind: 'photo', mime: 'image/jpeg', size: 10, takenFrom: 'camera', tags: [], ...o });

describe('toItem', () => {
  it('uses camera date, place and size', () => {
    const it = toItem({ id: '1', name: 'p.jpg', mimeType: 'image/jpeg', size: '2048', md5Checksum: 'abc', parents: ['f'], imageMediaMetadata: { time: '2019:05:04 10:00:00', location: { latitude: 45.1, longitude: 25.2 } } })!;
    expect(it.takenAt).toBe('2019-05-04T10:00:00');
    expect(it.takenFrom).toBe('camera');
    expect(it.lat).toBe(45.1);
    expect(it.size).toBe(2048);
    expect(it.folderId).toBe('f');
  });
  it('ignores 0,0 locations and falls back to file name date', () => {
    const it = toItem({ id: '1', name: 'IMG_20200313_155816.jpg', mimeType: 'image/jpeg', imageMediaMetadata: { location: { latitude: 0, longitude: 0 } } })!;
    expect(it.lat).toBeUndefined();
    expect(it.takenFrom).toBe('filename');
  });
});

describe('duplicates', () => {
  it('groups by md5 and size, keeps the camera copy outside WhatsApp', () => {
    const a = base({ id: 'a', md5: 'm', size: 5, folderId: 'wa', takenFrom: 'filename' });
    const b = base({ id: 'b', md5: 'm', size: 5, folderId: 'cam' });
    const c = base({ id: 'c', md5: 'other', size: 5 });
    const g = exactDuplicates([a, b, c]);
    expect(g).toHaveLength(1);
    expect(pickKeeper(g[0], (id) => (id === 'wa' ? 'Media/WhatsApp Images' : 'Camera')).id).toBe('b');
  });
  it('keeps the copy in the folder for its month over Camera', () => {
    const cam = base({ id: 'cam', folderId: 'c', takenAt: '2015-08-03T10:00:00', takenFrom: 'camera' });
    const trip = base({ id: 'trip', folderId: 't', takenAt: '2015-08-03T10:00:00', takenFrom: 'camera' });
    const paths: Record<string, string> = { c: 'My Drive/Camera/2021-06', t: 'My Drive/_Vacante/Austria 2015/2015-08' };
    expect(pickKeeper([cam, trip], (id) => paths[id!]).id).toBe('trip');
  });
});

describe('filters', () => {
  const items = [base({ id: '1', kind: 'video', takenAt: '2020-01-01T00:00:00' }), base({ id: '2', takenAt: '2015-08-01T00:00:00', lat: 1, lon: 1, size: 5e6 })];
  const p = () => '', inF = () => true;
  it('by kind', () => expect(applyFilters(items, { ...emptyFilters, kinds: ['video'] }, p, inF).map((i) => i.id)).toEqual(['1']));
  it('by date', () => expect(applyFilters(items, { ...emptyFilters, to: '2016-01-01' }, p, inF).map((i) => i.id)).toEqual(['2']));
  it('by place and size', () => expect(applyFilters(items, { ...emptyFilters, withPlace: 'yes', minSize: 1e6 }, p, inF).map((i) => i.id)).toEqual(['2']));
});

it('resizes Drive thumbnails', () => expect(sizedThumb('https://lh3.googleusercontent.com/abc=s220', 1600)).toBe('https://lh3.googleusercontent.com/abc=s1600'));
