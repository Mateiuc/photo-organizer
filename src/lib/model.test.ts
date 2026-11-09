import { describe, expect, it } from 'vitest';
import { copyMark, misplaced, worseReason, possibleCopies, localToItem, mimeFromName, applyFilters, dateFromName, emptyFilters, exactDuplicates, exifToIso, kindOf, pickKeeper, sizedThumb, toItem, type Item } from './model';

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

describe('local files', () => {
  it('knows media by extension', () => { expect(mimeFromName('A.JPG')).toBe('image/jpeg'); expect(mimeFromName('notes.txt')).toBe(''); });
  it('reads camera data', () => {
    const it = localToItem({ path: 'Pics/2015/a.jpg', name: 'a.jpg', size: 5, mtime: 0, folderId: 'local:Pics/2015', exif: { time: '2015:08:03 10:00:00', make: 'NIKON', model: 'D90', lat: 47.2, lon: 13.1 } })!;
    expect(it).toMatchObject({ id: 'local:Pics/2015/a.jpg', takenAt: '2015-08-03T10:00:00', takenFrom: 'camera', camera: 'NIKON D90', lat: 47.2, local: true });
  });
  it('falls back to file name, then file date', () => {
    expect(localToItem({ path: 'x/VID_20200313_155816.mp4', name: 'VID_20200313_155816.mp4', size: 1, mtime: 0, folderId: 'local:x' })!.takenFrom).toBe('filename');
    expect(localToItem({ path: 'x/clip.mov', name: 'clip.mov', size: 1, mtime: Date.UTC(2019, 0, 5), folderId: 'local:x' })!.takenFrom).toBe('file');
  });
  it('skips other files', () => expect(localToItem({ path: 'x/a.pdf', name: 'a.pdf', size: 1, mtime: 0, folderId: 'x' })).toBeNull());
});

describe('copies that lost camera data', () => {
  const p = (id?: string) => (id === 'wa' ? 'Media/WhatsApp Images' : id === 't' ? 'Trips/2018-11' : 'Backup');
  it('keeps the copy that still has camera data', () => {
    const full = base({ id: 'full', folderId: 'b', takenFrom: 'camera', camera: 'Sony G8441', lat: 25, lon: -81, width: 5056, height: 3792 });
    const bare = base({ id: 'bare', folderId: 't', takenFrom: 'filename', takenAt: '2018-11-01T14:52:36' });
    expect(pickKeeper([bare, full], p).id).toBe('full');
  });
  it('groups re-saved copies by name, not generic counters', () => {
    const a = base({ id: 'a', name: '2018_11_01-14.52.36.jpg', md5: '1', size: 3e6 });
    const b = base({ id: 'b', name: '2018_11_01-14.52.36.jpg', md5: '2', size: 2e5 });
    const c = base({ id: 'c', name: 'IMG_0001.jpg', md5: '3' }), d = base({ id: 'd', name: 'IMG_0001.jpg', md5: '4' });
    const g = possibleCopies([a, b, c, d]);
    expect(g.map((x) => x.map((i) => i.id).sort())).toEqual([['a', 'b']]);
  });
  it('leaves exact copies to the exact list', () => {
    expect(possibleCopies([base({ id: 'a', name: 'x1.jpg', md5: '1' }), base({ id: 'b', name: 'x1.jpg', md5: '1' })])).toEqual([]);
  });
});

describe('copy names and wrong folders', () => {
  it('spots copy names', () => {
    expect(['a (1).jpg', 'a - Copy.jpg', 'a copie.jpg', 'a~2.jpg', 'Copy of a.jpg'].map(copyMark)).toEqual([1, 1, 1, 1, 1]);
    expect(['2020_07_29-13.33.13.jpg', 'IMG_0001.jpg', 'copycat.jpg'].map(copyMark)).toEqual([0, 0, 0]);
  });
  const paths: Record<string, string> = { w: 'My Drive/_Vacante/Romania 2020 august/2017-07', r: 'My Drive/_Vacante/Romania 2020 august/2020-07', y: 'Pics/2020', n: 'Pics/Family' };
  const p = (id?: string) => paths[id!];
  const photo = (folderId: string, o: Partial<Item> = {}) => base({ id: folderId, folderId, takenAt: '2020-07-29T13:33:13', takenFrom: 'camera', camera: 'samsung', ...o });
  it('spots photos in a folder for another date', () => {
    expect(['w', 'r', 'y', 'n'].map((f) => misplaced(photo(f), p))).toEqual([1, 0, 0, 0]);
  });
  it('keeps the copy in the right folder and says why the other goes', () => {
    const wrong = photo('w'), right = photo('r');
    expect(pickKeeper([wrong, right], p)).toBe(right);
    expect(worseReason(wrong, right, p)).toMatch(/folder date/);
  });
  it('keeps the original over "(1)" copies', () => {
    const a = photo('n', { id: 'a', name: 'x.jpg' }), b = photo('n', { id: 'b', name: 'x (1).jpg' });
    expect(pickKeeper([b, a], p)).toBe(a);
    expect(worseReason(b, a, p)).toMatch(/copy/);
  });
});

it('does not call empty files copies of each other', () => {
  expect(exactDuplicates([base({ id: 'a', name: 'MOV_0014.mp4', md5: 'e', size: 0 }), base({ id: 'b', name: 'x.jpg', md5: 'e', size: 0 })])).toEqual([]);
});
