import { describe, expect, it } from 'vitest';
import { gpToItem, parseAlbumPage, parseAlbums, parseBulkInfo, parseDetails, parseListed, parseTimeline } from './api';
import { thumbUrl } from '../lib/model';

// Shapes as Google Photos' web page receives them (see Google Photos Toolkit's parser).
const photo = ['AF1QipKEY1', ['https://lh3.googleusercontent.com/pw/ABC', 4032, 3024], 1625493780000, 'DEDUP1', 7200000, 1625600000000,
  null, null, null, null, null, null, null, null, { 129168200: [null, [[447700000, 260900000], null, null, null, [[null, [['Bucharest']]]]]], 163238866: [true] }];
const video = ['AF1QipKEY2', ['https://lh3.googleusercontent.com/pw/DEF', 1920, 1080], 1625400000000, 'DEDUP2', 0, 1625400000500,
  null, null, null, null, null, null, null, true, { 76647426: [15300] }];

describe('Google Photos answers', () => {
  it('reads a library page', () => {
    const p = parseTimeline([[photo, video], 'NEXT', '1625400000000']);
    expect(p.next).toBe('NEXT');
    expect(p.lastTs).toBe(1625400000000);
    expect(p.items).toHaveLength(2);
    expect(p.items[0]).toMatchObject({ mediaKey: 'AF1QipKEY1', dedupKey: 'DEDUP1', width: 4032, height: 3024, tz: 7200000, place: 'Bucharest', fav: true });
    expect(p.items[0].lat).toBeCloseTo(44.77);
    expect(p.items[0].lon).toBeCloseTo(26.09);
    expect(p.items[1]).toMatchObject({ duration: 15300, archived: true });
    expect(p.items[1].lat).toBeUndefined();
  });

  it('copes with an empty or odd page', () => {
    expect(parseTimeline(null).items).toEqual([]);
    expect(parseTimeline([[null, 'x', ['bad']]]).items).toEqual([]);
    expect(parseListed('nope')).toBeUndefined();
  });

  it('turns a listed photo into a library item', () => {
    const info = parseBulkInfo([['AF1QipKEY1', [null, null, '', 'IMG_20210705_160300.jpg', null, null, 1625493780000, 7200000, 1625600000000, 2345678]]]);
    const it = gpToItem(parseListed(photo)!, info.get('AF1QipKEY1'));
    expect(it).toMatchObject({ id: 'gp:AF1QipKEY1', name: 'IMG_20210705_160300.jpg', kind: 'photo', mime: 'image/jpeg', size: 2345678, folderId: 'gp:root', takenFrom: 'camera', width: 4032 });
    expect(it.takenAt).toBe('2021-07-05T16:03:00'); // 14:03 UTC, taken at UTC+2
    expect(it.gp).toMatchObject({ key: 'AF1QipKEY1', dedup: 'DEDUP1', place: 'Bucharest', fav: true, named: true });
    expect(it.link).toBe('https://photos.google.com/photo/AF1QipKEY1');
    expect(thumbUrl(it, 320)).toBe('https://lh3.googleusercontent.com/pw/ABC=w320-h320-k-no');
  });

  it('marks videos, and upload dates when there was no camera date', () => {
    const it = gpToItem(parseListed(video)!, { name: 'VID_1.mp4', size: 9e6 });
    expect(it.kind).toBe('video');
    expect(it.durationMs).toBe(15300);
    expect(it.takenFrom).toBe('upload'); // taken time is the upload time
    expect(it.gp?.archived).toBe(true);
  });

  it('a phone that uploads within a minute still has a camera date when the name has the same time, or it has a place', () => {
    const listed = parseListed(video)!; // taken 2021-07-04 12:00:00, uploaded half a second later
    const still = { ...listed, duration: undefined };
    expect(gpToItem(still, { name: 'IMG_20210704_120000.jpg', size: 9e6 }).takenFrom).toBe('camera');
    expect(gpToItem(still, { name: 'IMG-20210704-WA0001.jpg', size: 9e6 }).takenFrom).toBe('upload');
    expect(gpToItem({ ...still, lat: 42.2, lon: -83.7 }, { name: 'photo.jpg', size: 9e6 }).takenFrom).toBe('camera');
  });

  it('keeps what was learned before when details are not read again', () => {
    const first = gpToItem(parseListed(photo)!, { name: 'a.jpg', size: 10 });
    const again = gpToItem(parseListed(photo)!, undefined, { ...first, gp: { ...first.gp!, albums: ['gp:a:X'] } });
    expect(again).toMatchObject({ name: 'a.jpg', size: 10 });
    expect(again.gp).toMatchObject({ named: true, albums: ['gp:a:X'] });
  });

  it('reads albums and album pages', () => {
    const a = parseAlbums([[['ALB1', null, null, null, null, null, null, { 72930366: [null, 'Holiday 2021', null, 120] }]], 'N2']);
    expect(a).toEqual({ albums: [{ key: 'ALB1', title: 'Holiday 2021', count: 120, authKey: undefined }], next: 'N2' });
    const p = parseAlbumPage([null, [['albumItemKey', [], 1, 'DEDUP1'], ['k2', [], 2, 'DEDUP2']], 'P2']);
    expect(p).toEqual({ dedupKeys: ['DEDUP1', 'DEDUP2'], next: 'P2' });
  });

  it('reads one item\'s details', () => {
    const row: unknown[] = [];
    row[1] = 'At the beach'; row[2] = 'IMG_1.HEIC'; row[5] = 3456789;
    row[13] = [[447700000, 260900000], null, [[null, [['Constanța']]]]];
    row[19] = [['ALB1', null, { 72930366: [null, 'Holiday 2021'] }]];
    row[23] = ['Apple', 'iPhone 12', 4.2, 1.6];
    const d = parseDetails([row]);
    expect(d).toMatchObject({ name: 'IMG_1.HEIC', size: 3456789, camera: 'Apple iPhone 12', place: 'Constanța', albums: ['Holiday 2021'], description: 'At the beach' });
    expect(d.lat).toBeCloseTo(44.77);
  });
});
