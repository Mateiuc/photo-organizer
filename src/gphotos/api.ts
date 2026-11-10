// Reading Google Photos through the helper add-on.
// The request and answer formats follow Google Photos Toolkit by xob0t (MIT licence):
// https://github.com/xob0t/google-photos-toolkit
import { kindOf, mimeFromName, type Folder, type Item } from '../lib/model';
import { ask } from './bridge';

export const GP_ROOT: Folder = { id: 'gp:root', name: 'Google Photos' };
export const albumFolderId = (albumKey: string) => 'gp:a:' + albumKey;

async function rpc(rpcid: string, data: unknown): Promise<any> {
  return (await ask<{ data: any }>({ op: 'rpc', rpcid, data })).data;
}

/** Splits a list into parts of at most n. */
export function inParts<T>(list: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n));
  return out;
}

/** Google Photos takes up to this many items in one trash or restore request. */
export const TRASH_PART = 250;

/**
 * Moves items to Google Photos' own Trash (kept there 60 days, then Google deletes them). Needs helper add-on 0.3.0.
 * `onPart` is told after each part, so items already moved are known even if a later part fails.
 */
export async function trashGp(dedupKeys: string[], onPart?: (done: string[]) => void | Promise<void>): Promise<void> {
  for (const part of inParts(dedupKeys, TRASH_PART)) {
    await rpc('XwAOJf', [null, 1, part, 3]);
    await onPart?.(part);
  }
}

/** Brings items back from Google Photos' Trash. */
export async function restoreGp(dedupKeys: string[], onPart?: (done: string[]) => void | Promise<void>): Promise<void> {
  for (const part of inParts(dedupKeys, TRASH_PART)) {
    await rpc('XwAOJf', [null, 3, part, 2]);
    await onPart?.(part);
  }
}

export async function connect(): Promise<string> {
  return (await ask<{ account: string }>({ op: 'connect' }, 90000)).account;
}

// ---------- answers → plain objects (pure, tested) ----------
export interface GpListed {
  mediaKey: string;
  dedupKey: string;
  thumb?: string;
  width?: number;
  height?: number;
  timestamp?: number; // ms, UTC
  tz?: number; // ms
  created?: number; // ms, when it was added to Google Photos
  duration?: number; // ms, videos only
  lat?: number;
  lon?: number;
  place?: string;
  archived?: boolean;
  fav?: boolean;
}

const num = (v: unknown) => (typeof v === 'number' && isFinite(v) ? v : typeof v === 'string' && v.trim() && isFinite(+v) ? +v : undefined);
const deg = (v: unknown) => { const n = num(v); return n == null ? undefined : Math.abs(n) > 360 ? n / 1e7 : n; };
const ext = (d: any) => { const e = Array.isArray(d) ? d[d.length - 1] : undefined; return e && typeof e === 'object' && !Array.isArray(e) ? e : {}; };

export function parseListed(d: any): GpListed | undefined {
  if (!Array.isArray(d) || typeof d[0] !== 'string' || !Array.isArray(d[1])) return undefined; // media key and picture
  const x = ext(d);
  const coords = x[129168200]?.[1]?.[0];
  const lat = deg(coords?.[0]), lon = deg(coords?.[1]);
  const hasPlace = lat != null && lon != null && !(lat === 0 && lon === 0);
  return {
    mediaKey: d[0],
    dedupKey: d[3],
    thumb: d[1]?.[0],
    width: num(d[1]?.[1]),
    height: num(d[1]?.[2]),
    timestamp: num(d[2]),
    tz: num(d[4]),
    created: num(d[5]),
    duration: num(x[76647426]?.[0]),
    lat: hasPlace ? lat : undefined,
    lon: hasPlace ? lon : undefined,
    place: x[129168200]?.[1]?.[4]?.[0]?.[1]?.[0]?.[0] || undefined,
    archived: !!d[13] || undefined,
    fav: !!x[163238866]?.[0] || undefined,
  };
}

export function parseTimeline(data: any): { items: GpListed[]; next?: string; lastTs?: number } {
  const items = (Array.isArray(data?.[0]) ? data[0] : []).map(parseListed).filter((x: GpListed | undefined): x is GpListed => !!x);
  return { items, next: data?.[1] || undefined, lastTs: num(data?.[2]) };
}

export interface GpInfo { name?: string; size?: number; description?: string }
export function parseBulkInfo(rows: any): Map<string, GpInfo> {
  const out = new Map<string, GpInfo>();
  for (const r of Array.isArray(rows) ? rows : []) {
    if (typeof r?.[0] !== 'string') continue;
    out.set(r[0], { name: r[1]?.[3] || undefined, size: num(r[1]?.[9]), description: r[1]?.[2] || undefined });
  }
  return out;
}

export interface GpDetails { name?: string; size?: number; camera?: string; place?: string; lat?: number; lon?: number; albums: string[]; description?: string }
export function parseDetails(data: any): GpDetails {
  const d = data?.[0] ?? [];
  const coords = d[9]?.[0] ?? d[13]?.[0];
  const lat = deg(coords?.[0]), lon = deg(coords?.[1]);
  return {
    name: d[2] || undefined,
    size: num(d[5]),
    camera: cameraText(d[23]),
    place: d[13]?.[2]?.[0]?.[1]?.[0]?.[0] || undefined,
    lat: lat != null && lon != null && !(lat === 0 && lon === 0) ? lat : undefined,
    lon: lat != null && lon != null && !(lat === 0 && lon === 0) ? lon : undefined,
    albums: (Array.isArray(d[19]) ? d[19] : []).map((a: any) => ext(a)[72930366]?.[1]).filter((t: unknown): t is string => typeof t === 'string'),
    description: d[1] || undefined,
  };
}

/** Camera make and model from the details answer (its exact layout isn't documented, so take the first words). */
function cameraText(c: any): string | undefined {
  if (!Array.isArray(c)) return undefined;
  const words: string[] = [];
  const walk = (v: any, depth: number) => {
    if (words.length >= 2 || depth > 3) return;
    if (typeof v === 'string' && /[a-z]/i.test(v) && v.length < 40) words.push(v.trim());
    else if (Array.isArray(v)) v.forEach((x) => walk(x, depth + 1));
  };
  walk(c, 0);
  if (!words.length) return undefined;
  // "Apple" + "iPhone 12" → "Apple iPhone 12", but don't repeat the make: "Canon" + "Canon EOS 80D" → "Canon EOS 80D"
  return words.length === 2 && words[1].toLowerCase().startsWith(words[0].toLowerCase()) ? words[1] : words.join(' ');
}

export interface GpAlbum { key: string; title: string; count?: number; authKey?: string }
export function parseAlbums(data: any): { albums: GpAlbum[]; next?: string } {
  const albums = (Array.isArray(data?.[0]) ? data[0] : []).map((a: any) => {
    const x = ext(a)[72930366];
    return typeof a?.[0] === 'string' ? { key: a[0], title: x?.[1] || 'Untitled album', count: num(x?.[3]), authKey: x?.[5] || undefined } : undefined;
  }).filter(Boolean) as GpAlbum[];
  return { albums, next: data?.[1] || undefined };
}

export function parseAlbumPage(data: any): { dedupKeys: string[]; next?: string } {
  const dedupKeys = (Array.isArray(data?.[1]) ? data[1] : []).map((d: any) => d?.[3]).filter((k: unknown): k is string => typeof k === 'string');
  return { dedupKeys, next: data?.[2] || undefined };
}

/** "2021-06-05T14:03:00" in the time zone where it was taken (or UTC when unknown). */
function localIso(ms: number, tz?: number): string {
  return new Date(ms + (tz ?? 0)).toISOString().slice(0, 19);
}

export function gpToItem(g: GpListed, info?: GpInfo, old?: Item): Item {
  const name = info?.name ?? old?.name ?? (g.duration ? 'Video' : 'Photo');
  const video = g.duration != null;
  const mime = mimeFromName(name) || (video ? 'video/mp4' : 'image/jpeg');
  const kind = video ? 'video' : kindOf(name, mime.startsWith('video/') ? 'image/jpeg' : mime) ?? 'photo';
  // Google Photos uses the camera's date when the file has one, otherwise the upload time.
  const fromCamera = g.timestamp != null && (g.created == null || Math.abs(g.timestamp - g.created) > 60_000);
  return {
    id: 'gp:' + g.mediaKey,
    name,
    kind,
    mime,
    size: info?.size ?? old?.size ?? 0,
    folderId: GP_ROOT.id,
    takenAt: g.timestamp != null ? localIso(g.timestamp, g.tz) : undefined,
    takenFrom: fromCamera ? 'camera' : 'upload',
    width: g.width,
    height: g.height,
    camera: old?.camera,
    lat: g.lat,
    lon: g.lon,
    durationMs: g.duration,
    thumb: g.thumb,
    link: `https://photos.google.com/photo/${g.mediaKey}`,
    tags: old?.tags ?? [],
    gp: {
      key: g.mediaKey,
      dedup: g.dedupKey,
      albums: old?.gp?.albums,
      archived: g.archived,
      fav: g.fav,
      place: g.place,
      uploaded: g.created != null ? new Date(g.created).toISOString().slice(0, 19) : undefined,
      named: !!(info?.name ?? (old?.gp?.named && old.name)),
    },
  };
}

// ---------- reading the library ----------
export interface GpProgress { files: number; current: string }

/** File names and sizes, many items per request. */
async function bulkInfo(keys: string[]): Promise<Map<string, GpInfo>> {
  const out = new Map<string, GpInfo>();
  for (let i = 0; i < keys.length; i += 1000) {
    const part = keys.slice(i, i + 1000);
    // prettier-ignore
    const data = await rpc('EWgK9e', [[[part.map((k) => [k])], [[null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, [], null, null, null, null, null, null, null, null, null, null, []]]]]);
    parseBulkInfo(data?.[0]?.[1]).forEach((v, k) => out.set(k, v));
  }
  return out;
}

/**
 * Reads every photo and video in the library (archived ones too), newest first, a page of 500 at a time.
 * File names and sizes are read only for items the app hasn't seen before.
 */
export async function scanLibrary(known: Map<string, Item>, onItems: (items: Item[]) => Promise<void>, onProgress: (p: GpProgress) => void, signal: { stop: boolean }): Promise<Item[]> {
  const all: Item[] = [];
  let pageId: string | undefined, ts: number | undefined;
  const seenPages = new Set<string>();
  const busy: Promise<void>[] = [];
  let failed: unknown;
  do {
    if (signal.stop || failed) break;
    const page = parseTimeline(await rpc('lcxiM', [pageId ?? null, ts ?? null, 500, null, 1, 3]));
    pageId = page.next;
    if (pageId && seenPages.has(pageId)) break; // the same page again: the end
    if (pageId) seenPages.add(pageId);
    ts = page.lastTs != null ? page.lastTs - 1 : undefined;
    if (!page.items.length) continue;
    const need = page.items.filter((g) => !known.get('gp:' + g.mediaKey)?.gp?.named).map((g) => g.mediaKey);
    busy.push((async () => {
      const info = need.length ? await bulkInfo(need) : new Map<string, GpInfo>();
      const its = page.items.map((g) => gpToItem(g, info.get(g.mediaKey), known.get('gp:' + g.mediaKey)));
      all.push(...its);
      await onItems(its);
      onProgress({ files: all.length, current: its[its.length - 1].takenAt?.slice(0, 7) ?? '' });
    })().catch((e) => { failed ??= e; }));
    if (busy.length >= 3) await busy.shift();
  } while (pageId);
  await Promise.all(busy);
  if (failed) throw failed;
  return all;
}

/** Every album, and which items (by content key) are in each. */
export async function scanAlbums(onProgress: (p: GpProgress) => void, signal: { stop: boolean }): Promise<{ album: GpAlbum; dedupKeys: string[] }[]> {
  const albums: GpAlbum[] = [];
  let next: string | undefined;
  do {
    const r = parseAlbums(await rpc('Z5xsfc', [next ?? null, null, null, null, 1, null, null, 100, [2], 5]));
    albums.push(...r.albums);
    next = r.next;
  } while (next && !signal.stop);
  const out: { album: GpAlbum; dedupKeys: string[] }[] = [];
  for (const [i, a] of albums.entries()) {
    if (signal.stop) break;
    onProgress({ files: i, current: `album ${i + 1} of ${albums.length}: ${a.title}` });
    const keys: string[] = [];
    let p: string | undefined;
    const seen = new Set<string>();
    do {
      const r = parseAlbumPage(await rpc('snAcKc', [a.key, p ?? null, null, a.authKey ?? null]));
      keys.push(...r.dedupKeys);
      p = r.next;
      if (p && seen.has(p)) break;
      if (p) seen.add(p);
    } while (p && !signal.stop);
    out.push({ album: a, dedupKeys: keys });
  }
  return out;
}

/**
 * Google Photos' own search, as in its search box: it knows what is in the pictures (cars, wires…) and reads
 * text in them (like a VIN). Returns every item found, page by page.
 */
export async function searchGp(query: string, onFound: (n: number) => void, signal: { stop: boolean }, max = 50_000): Promise<GpListed[]> {
  const out: GpListed[] = [];
  const seen = new Set<string>(), pages = new Set<string>();
  let next: string | undefined;
  do {
    const page = parseTimeline(await rpc('EzkLib', [query, null, next ?? null]));
    for (const g of page.items) if (!seen.has(g.mediaKey)) { seen.add(g.mediaKey); out.push(g); }
    onFound(out.length);
    next = page.next;
    if (next && pages.has(next)) break; // the same page again: the end
    if (next) pages.add(next);
  } while (next && !signal.stop && out.length < max);
  return out;
}

/** Camera, place name and albums of one item, for the viewer. */
const detailCache = new Map<string, Promise<GpDetails>>();
export function details(it: Item): Promise<GpDetails> {
  const key = it.gp!.key;
  let p = detailCache.get(key);
  if (!p) {
    p = rpc('fDcn4b', [key, 1, null, null, 1]).then(parseDetails);
    p.catch(() => detailCache.delete(key));
    detailCache.set(key, p);
  }
  return p;
}

// ---------- pictures ----------
// The page tries to show Google's preview link directly. If the browser won't load it (for example because it
// blocks Google's cookies on other sites), the add-on fetches it inside the Google Photos tab instead.
let direct = true;
const pics = new Map<string, Promise<string | undefined>>();
let running = 0;
const queue: (() => void)[] = [];

export const viaHelperOnly = () => !direct;
export function directFailed() { direct = false; }

/** A picture fetched by the add-on, as a data: URL. */
export function helperPicture(url: string): Promise<string | undefined> {
  let p = pics.get(url);
  if (!p) {
    p = (async () => {
      if (running >= 6) await new Promise<void>((r) => queue.push(r));
      running++;
      try { return (await ask<{ dataUrl: string }>({ op: 'image', url }, 60000)).dataUrl; } catch { return undefined; } finally { running--; queue.shift()?.(); }
    })();
    pics.set(url, p);
    if (pics.size > 600) pics.delete(pics.keys().next().value!); // keep memory in check
  }
  return p;
}
