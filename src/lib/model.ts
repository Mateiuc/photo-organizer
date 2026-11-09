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
  takenFrom: 'camera' | 'filename' | 'upload';
  width?: number;
  height?: number;
  camera?: string;
  lat?: number;
  lon?: number;
  durationMs?: number;
  thumb?: string;
  link?: string;
  tags: string[];
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

/** Groups of exact copies: same content fingerprint (md5) from Drive. */
export function exactDuplicates(items: Item[]): Item[][] {
  const by = new Map<string, Item[]>();
  for (const it of items) {
    if (!it.md5) continue;
    const key = it.md5 + ':' + it.size;
    const arr = by.get(key);
    arr ? arr.push(it) : by.set(key, [it]);
  }
  return [...by.values()].filter((g) => g.length > 1).sort((a, b) => b[0].size * (b.length - 1) - a[0].size * (a.length - 1));
}

/** Which copy to keep: the one with the camera date, then the shortest folder path, then the oldest. */
/** Which copy to keep: not WhatsApp, in a folder named for the photo's month, with a camera date, in the most specific folder. */
export function pickKeeper(group: Item[], pathOf: (folderId?: string) => string): Item {
  const wa = (x: Item) => (/whatsapp/i.test(pathOf(x.folderId)) ? 1 : 0);
  const month = (x: Item) => {
    const m = x.takenAt?.slice(0, 7);
    return m && pathOf(x.folderId).includes(m) ? 0 : 1;
  };
  const cam = (x: Item) => (x.takenFrom === 'camera' ? 0 : 1);
  const depth = (x: Item) => pathOf(x.folderId).split('/').length;
  return [...group].sort((a, b) =>
    wa(a) - wa(b) || month(a) - month(b) || cam(a) - cam(b) || depth(b) - depth(a) || a.name.localeCompare(b.name),
  )[0];
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

export function applyFilters(items: Item[], f: Filters, pathOf: (id?: string) => string, inFolder: (itemFolder: string | undefined, root: string) => boolean): Item[] {
  const q = f.q.trim().toLowerCase();
  return items.filter((it) => {
    if (f.kinds.length && !f.kinds.includes(it.kind)) return false;
    if (f.from && (!it.takenAt || it.takenAt.slice(0, 10) < f.from)) return false;
    if (f.to && (!it.takenAt || it.takenAt.slice(0, 10) > f.to)) return false;
    if (f.minSize != null && it.size < f.minSize) return false;
    if (f.maxSize != null && it.size > f.maxSize) return false;
    if (f.withPlace === 'yes' && it.lat == null) return false;
    if (f.withPlace === 'no' && it.lat != null) return false;
    if (f.folderId && !inFolder(it.folderId, f.folderId)) return false;
    if (q && !(it.name.toLowerCase().includes(q) || pathOf(it.folderId).toLowerCase().includes(q) || (it.camera ?? '').toLowerCase().includes(q) || it.tags.some((t) => t.toLowerCase().includes(q)))) return false;
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

/** Bigger thumbnail from a Drive thumbnailLink (ends with =s220). */
export function sizedThumb(link: string | undefined, px: number): string | undefined {
  if (!link) return undefined;
  return link.replace(/=s\d+(-[a-z0-9-]+)?$/i, `=s${px}`);
}
