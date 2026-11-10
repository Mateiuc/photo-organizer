// Core data model. Pure functions only, so they run the same on web, desktop and (later) iOS.

export type Kind = 'photo' | 'video' | 'raw' | 'screenshot';

/** The Drive fields the app asks for. Keep in sync with FILE_FIELDS in drive/api.ts. */
export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  size?: string;
  md5Checksum?: string;
  createdTime?: string;
  modifiedTime?: string;
  parents?: string[];
  thumbnailLink?: string;
  webViewLink?: string;
  imageMediaMetadata?: {
    time?: string; // "2017:07:01 17:25:23"
    width?: number;
    height?: number;
    cameraMake?: string;
    cameraModel?: string;
    location?: { latitude?: number; longitude?: number; altitude?: number };
  };
  videoMediaMetadata?: { width?: number; height?: number; durationMillis?: string };
  appProperties?: Record<string, string>;
}

export interface Item {
  id: string;
  name: string;
  kind: Kind;
  mime: string;
  size: number;
  md5?: string;
  folderId?: string;
  /** ISO date-time the photo or video was taken, best available source. */
  takenAt?: string;
  takenFrom: 'camera' | 'filename' | 'upload' | 'file';
  width?: number;
  height?: number;
  camera?: string;
  lat?: number;
  lon?: number;
  durationMs?: number;
  thumb?: string;
  link?: string;
  tags: string[];
  /** Set for files read from a folder on this computer. */
  local?: boolean;
  /** Local files: last-modified time, to skip re-reading unchanged files. */
  mtime?: number;
  /** Set for items in Google Photos (read through the helper add-on). */
  gp?: GpRef;
}

/** How Google Photos knows an item. `dedup` is the same for every copy of the same file content. */
export interface GpRef {
  key: string; // media key
  dedup: string;
  albums?: string[]; // folder ids of the albums it is in ('gp:a:' + album key)
  archived?: boolean;
  fav?: boolean;
  place?: string;
  uploaded?: string; // ISO date-time it was added to Google Photos
  named?: boolean; // file name and size have been read
}

export interface Folder {
  id: string;
  name: string;
  parentId?: string;
}

const RAW_EXT = /\.(nef|cr2|cr3|arw|dng|orf|rw2|raf)$/i;
const SHOT = /screen ?shot|screenshot|schermata|captur/i;

export function kindOf(name: string, mime: string): Kind | null {
  if (mime.startsWith('video/')) return 'video';
  if (RAW_EXT.test(name) || mime.includes('nikon-nef') || mime.includes('x-dcraw')) return 'raw';
  if (mime.startsWith('image/')) return SHOT.test(name) ? 'screenshot' : 'photo';
  return null;
}

/** "2017:07:01 17:25:23" → "2017-07-01T17:25:23" */
export function exifToIso(t?: string): string | undefined {
  if (!t) return undefined;
  const m = t.match(/^(\d{4})[:-](\d\d)[:-](\d\d)[ T](\d\d):(\d\d):(\d\d)/);
  if (!m || m[1] === '0000') return undefined;
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`;
}

/** Reads dates from common phone and camera file names. */
export function dateFromName(name: string): string | undefined {
  // 2017_07_01-17.25.23.jpg · 2020-03-13_15-58-16 · IMG_20200313_155816 · 20200313_155816
  let m = name.match(/(20\d\d|19\d\d)[_\-.]?(\d\d)[_\-.]?(\d\d)[ _\-T.]+(\d\d)[_\-.:]?(\d\d)[_\-.:]?(\d\d)/);
  if (m && valid(m)) return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`;
  // IMG-20200313-WA0045.jpg (WhatsApp: date only)
  m = name.match(/(20\d\d)(\d\d)(\d\d)/) ?? name.match(/(20\d\d)[_\-](\d\d)[_\-](\d\d)/);
  if (m && valid(m)) return `${m[1]}-${m[2]}-${m[3]}T12:00:00`;
  return undefined;
}
function valid(m: RegExpMatchArray) {
  const mo = +m[2], d = +m[3];
  return mo >= 1 && mo <= 12 && d >= 1 && d <= 31;
}

export function toItem(f: DriveFile): Item | null {
  const kind = kindOf(f.name, f.mimeType);
  if (!kind) return null;
  const im = f.imageMediaMetadata, vm = f.videoMediaMetadata;
  const cam = exifToIso(im?.time);
  const fromName = cam ? undefined : dateFromName(f.name);
  const loc = im?.location;
  const hasLoc = loc && typeof loc.latitude === 'number' && typeof loc.longitude === 'number' && !(loc.latitude === 0 && loc.longitude === 0);
  return {
    id: f.id,
    name: f.name,
    kind,
    mime: f.mimeType,
    size: Number(f.size ?? 0),
    md5: f.md5Checksum,
    folderId: f.parents?.[0],
    takenAt: cam ?? fromName ?? f.createdTime?.slice(0, 19),
    takenFrom: cam ? 'camera' : fromName ? 'filename' : 'upload',
    width: im?.width ?? vm?.width,
    height: im?.height ?? vm?.height,
    camera: [im?.cameraMake, im?.cameraModel].filter(Boolean).join(' ') || undefined,
    lat: hasLoc ? loc!.latitude : undefined,
    lon: hasLoc ? loc!.longitude : undefined,
    durationMs: vm?.durationMillis ? Number(vm.durationMillis) : undefined,
    thumb: f.thumbnailLink,
    link: f.webViewLink,
    tags: f.appProperties?.po_tags ? f.appProperties.po_tags.split('|').filter(Boolean) : [],
  };
}

const MIME: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', heic: 'image/heic', heif: 'image/heif',
  bmp: 'image/bmp', tif: 'image/tiff', tiff: 'image/tiff', avif: 'image/avif',
  nef: 'image/x-nikon-nef', cr2: 'image/x-canon-cr2', cr3: 'image/x-canon-cr3', arw: 'image/x-sony-arw', dng: 'image/x-adobe-dng', orf: 'image/x-olympus-orf', rw2: 'image/x-panasonic-rw2', raf: 'image/x-fuji-raf',
  mp4: 'video/mp4', mov: 'video/quicktime', m4v: 'video/x-m4v', avi: 'video/x-msvideo', mkv: 'video/x-matroska', '3gp': 'video/3gpp', webm: 'video/webm', mts: 'video/mp2t', wmv: 'video/x-ms-wmv',
};
/** Media type from a file name, or '' when it isn't a photo or video. */
export function mimeFromName(name: string): string {
  return MIME[name.split('.').pop()?.toLowerCase() ?? ''] ?? '';
}

/** What the folder scan learns about one file on this computer. */
export interface LocalFile {
  path: string; // relative to the chosen folder's parent, e.g. "Photos/2015/a.jpg"
  name: string;
  size: number;
  mtime: number;
  folderId: string;
  exif?: { time?: string; make?: string; model?: string; width?: number; height?: number; lat?: number; lon?: number };
}

export function localToItem(f: LocalFile): Item | null {
  const mime = mimeFromName(f.name);
  const kind = mime ? kindOf(f.name, mime) : null;
  if (!kind) return null;
  const e = f.exif ?? {};
  const cam = exifToIso(e.time);
  const fromName = cam ? undefined : dateFromName(f.name);
  const hasLoc = typeof e.lat === 'number' && typeof e.lon === 'number' && isFinite(e.lat) && isFinite(e.lon) && !(e.lat === 0 && e.lon === 0);
  const d = new Date(f.mtime);
  const p = (n: number) => String(n).padStart(2, '0');
  const fileDate = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  return {
    id: 'local:' + f.path,
    name: f.name,
    kind,
    mime,
    size: f.size,
    folderId: f.folderId,
    takenAt: cam ?? fromName ?? fileDate,
    takenFrom: cam ? 'camera' : fromName ? 'filename' : 'file',
    width: e.width,
    height: e.height,
    camera: [e.make, e.model].filter(Boolean).join(' ').trim() || undefined,
    lat: hasLoc ? e.lat : undefined,
    lon: hasLoc ? e.lon : undefined,
    tags: [],
    local: true,
    mtime: f.mtime,
  };
}

/** Groups of exact copies: same content fingerprint (md5) from Drive. */
export function exactDuplicates(items: Item[]): Item[][] {
  const by = new Map<string, Item[]>();
  for (const it of items) {
    if (!it.md5 || !it.size) continue; // empty files all share one fingerprint; they're listed separately
    const key = it.md5 + ':' + it.size;
    const arr = by.get(key);
    arr ? arr.push(it) : by.set(key, [it]);
  }
  return [...by.values()].filter((g) => g.length > 1).sort((a, b) => b[0].size * (b.length - 1) - a[0].size * (a.length - 1));
}

/** How much of the camera's information a file still has. Copies sent through chat apps or re-saved often lose it. */
export function metaScore(x: Item): number {
  return (x.takenFrom === 'camera' ? 8 : 0) + (x.lat != null ? 4 : 0) + (x.camera ? 2 : 0) + (x.width ? 1 : 0);
}
/** Videos rarely carry camera data that Drive or the browser can read, so they always count as having it. */
export const hasCameraData = (x: Item) => x.kind === 'video' || x.takenFrom === 'camera' || !!x.camera;

/** 1 when the file name looks like a copy: "photo (1).jpg", "photo - Copy.jpg", "photo copie.jpg", "photo~2.jpg". */
export function copyMark(name: string): number {
  const stem = name.replace(/\.[a-z0-9]+$/i, '');
  return /(\(\d+\)|\bcop(y|ie|ia)\b|kopie|~\d+)\s*$/i.test(stem) || /\bcop(y|ie|ia) of\b/i.test(stem) ? 1 : 0;
}

/**
 * 1 when the folder is named for a date (2017, 2017-07, 2017_07) that doesn't match when the photo was taken,
 * like a July 2020 photo in a "2017-07" folder.
 */
export function misplaced(x: Item, pathOf: (folderId?: string) => string): number {
  if (!x.takenAt || x.takenFrom === 'upload' || x.takenFrom === 'file') return 0;
  const dates = [...pathOf(x.folderId).matchAll(/(?:^|[^\d])((?:19|20)\d\d)(?:[-_. ](0[1-9]|1[0-2]))?(?=[^\d]|$)/g)];
  const last = dates[dates.length - 1];
  if (!last) return 0;
  if (last[1] !== x.takenAt.slice(0, 4)) return 1;
  return last[2] && last[2] !== x.takenAt.slice(5, 7) ? 1 : 0;
}

/** Which copy to keep, in order: most camera information, in a folder that matches its date, a name that isn't a copy, not WhatsApp, in a folder named for its month, the biggest file, the most specific folder. */
export function pickKeeper(group: Item[], pathOf: (folderId?: string) => string): Item {
  const wa = (x: Item) => (/whatsapp/i.test(pathOf(x.folderId)) ? 1 : 0);
  const month = (x: Item) => {
    const m = x.takenAt?.slice(0, 7);
    return m && pathOf(x.folderId).includes(m) ? 0 : 1;
  };
  const depth = (x: Item) => pathOf(x.folderId).split('/').length;
  return [...group].sort((a, b) =>
    metaScore(b) - metaScore(a) || misplaced(a, pathOf) - misplaced(b, pathOf) || copyMark(a.name) - copyMark(b.name) ||
    wa(a) - wa(b) || month(a) - month(b) || b.size - a.size || depth(b) - depth(a) || a.name.localeCompare(b.name),
  )[0];
}

/** Why a copy is clearly worse than the one kept, or '' when it's only a matter of choice. */
export function worseReason(x: Item, keep: Item, pathOf: (folderId?: string) => string): string {
  if (x === keep) return '';
  if (!hasCameraData(x) && hasCameraData(keep)) return 'lost camera data';
  if (misplaced(x, pathOf) && !misplaced(keep, pathOf)) return 'folder date doesn\'t match the photo';
  if (copyMark(x.name) > copyMark(keep.name)) return 'name looks like a copy';
  return '';
}

const itemPixels = (x: Item) => (x.width && x.height ? x.width * x.height : 0);
/** Which copy of the same photo to keep: the one with the most camera information, then the biggest picture, then as for identical files. */
export function pickSame(group: Item[], pathOf: (folderId?: string) => string, pixels = itemPixels): Item {
  const top = Math.max(...group.map(metaScore));
  const best = group.filter((x) => metaScore(x) === top);
  const size = (x: Item) => (pixels(x) ? Math.floor(Math.log(pixels(x)) / Math.log(1.25)) : 0); // steps of 25%
  const big = Math.max(...best.map(size));
  return pickKeeper(best.filter((x) => size(x) === big), pathOf);
}

/** Why a copy of the same photo is worse than the one kept, from its picture: fewer pixels, or re-saved at lower quality. */
export function lesserCopy(x: Item, keep: Item, pixels = itemPixels): string {
  const a = pixels(x), b = pixels(keep);
  if (a && b && a < 0.7 * b) return 'smaller copy';
  // Same kind of file and as many pixels, but much smaller: saved again at a lower quality (chat apps do this).
  if (x.mime === keep.mime && (!a || !b || a >= 0.9 * b) && x.size && x.size < 0.6 * keep.size) return 'lower-quality copy';
  return '';
}

export interface Filters {
  kinds: Kind[];
  q: string;
  from?: string; // YYYY-MM-DD
  to?: string;
  minSize?: number; // bytes
  maxSize?: number;
  withPlace?: 'any' | 'yes' | 'no';
  folderId?: string; // includes subfolders
}

export const emptyFilters: Filters = { kinds: [], q: '', withPlace: 'any' };

export function applyFilters(items: Item[], f: Filters, pathOf: (id?: string) => string, inFolder: (itemFolder: string | undefined, root: string) => boolean, extra?: (it: Item) => string | undefined): Item[] {
  const q = f.q.trim().toLowerCase();
  return items.filter((it) => {
    if (f.kinds.length && !f.kinds.includes(it.kind)) return false;
    if (f.from && (!it.takenAt || it.takenAt.slice(0, 10) < f.from)) return false;
    if (f.to && (!it.takenAt || it.takenAt.slice(0, 10) > f.to)) return false;
    if (f.minSize != null && it.size < f.minSize) return false;
    if (f.maxSize != null && it.size > f.maxSize) return false;
    if (f.withPlace === 'yes' && it.lat == null) return false;
    if (f.withPlace === 'no' && it.lat != null) return false;
    if (f.folderId && !inFolder(it.folderId, f.folderId) && !it.gp?.albums?.includes(f.folderId)) return false;
    if (q && !(it.name.toLowerCase().includes(q) || pathOf(it.folderId).toLowerCase().includes(q) || (it.camera ?? '').toLowerCase().includes(q) || it.tags.some((t) => t.toLowerCase().includes(q)) || (extra?.(it) ?? '').toLowerCase().includes(q))) return false;
    return true;
  });
}

export function fmtSize(b: number): string {
  if (b >= 1e9) return (b / 1e9).toFixed(1) + ' GB';
  if (b >= 1e6) return (b / 1e6).toFixed(1) + ' MB';
  if (b >= 1e3) return Math.round(b / 1e3) + ' KB';
  return b + ' B';
}

export function fmtDuration(ms?: number): string {
  if (!ms) return '';
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export function monthLabel(ym: string): string {
  const [y, m] = ym.split('-');
  return `${MONTHS[Number(m) - 1] ?? ''} ${y}`;
}

/** A preview link at about `px` pixels, for Drive and Google Photos items. */
export function thumbUrl(it: Pick<Item, 'thumb' | 'gp'> | undefined, px: number): string | undefined {
  if (!it?.thumb) return undefined;
  return it.gp ? `${it.thumb.replace(/=[a-z0-9-]+$/i, '')}=w${px}-h${px}-k-no` : sizedThumb(it.thumb, px);
}

/** Bigger thumbnail from a Drive thumbnailLink (ends with =s220). */
export function sizedThumb(link: string | undefined, px: number): string | undefined {
  if (!link) return undefined;
  return link.replace(/=s\d+(-[a-z0-9-]+)?$/i, `=s${px}`);
}
