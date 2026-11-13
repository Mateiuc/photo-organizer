// A safe copy of everything the app has learned (library, faces, names), in a folder the user picks, outside the
// browser. Clearing Chrome's data then loses nothing: "Restore from backup" brings it all back, on any computer.
//
// Files in the backup folder:
//   backup.json            what's in the backup and when it was saved
//   library.json           the photos and videos the app knows, and their folders
//   people.json            people, names, which face belongs to whom, which photos were looked at
//   people-YYYY-MM-DD.json the same, one per day for the last 10 days (in case a day's work needs undoing)
//   faces-0001.json …      the faces themselves (fingerprint and small picture). Written once, never changed.
//   pictures-0001.json …   what "Compare pictures" learned about each photo's picture. Written once, never changed.
//   topics.json            search topics (like "Cars") and the photos each one found
//   sort-0001.json …       what the Clean-up AI (CLIP) saw in each photo. Written once, never changed.
//   cleanup.json           your fixes and checks on the Clean-up page
//   kept.json              duplicate sets you said to keep as they are ("Keep both")
//   newfaces-0001.json …   while the photos are read again with the stronger face AI: the faces found so far
//   newfaces.json          …and which photos are done
//   before-new-face-ai/    a copy of people.json and the faces-….json files from just before switching to the
//                          stronger face AI (kept, never written again)
import { useEffect, useState } from 'react';
import { openDB } from 'idb';
import { changes, hooks, markBackedUp, markNextBackedUp, ready, replaceAll, replaceNext, subscribe, type StoredFace } from '../faces/people';
import type { Face, Person } from '../faces/cluster';
import { libraryEvents, type Library, type Meta } from './store';
import type { Folder, Item } from './model';
import { markPicsBackedUp, picChanges, picturesReady, replaceAllPics, subscribePictures, type PicRec } from '../pictures/store';
import { replaceAllTopics, subscribeTopics, topicChanges, topicsReady, type Topic } from '../search/topics';
import { keptChanges, keptReady, replaceAllKept, subscribeKept } from '../pictures/kept';
import { markSortBackedUp, replaceAllSort, sortChanges, sortReady, subscribeSort, type Check, type SortRec } from '../sort/store';

export const BACKUP_FOLDER = 'Photo Organizer backup';
type Dir = FileSystemDirectoryHandle;

export interface Manifest { app: 'Photo Organizer'; v: 1; savedAt: string; photos: number; faces: number; people: number; named: number; pictures?: number; sorted?: number; fixes?: number; /** photos read again with the stronger face AI so far */ next?: number }
export interface BackupStatus {
  supported: boolean;
  folder?: string; // name of the backup folder's parent, as the user picked it
  savedAt?: string;
  saved?: Manifest;
  saving: boolean;
  needsPermission: boolean;
  unsaved: boolean;
  error?: string;
  /** The photo list became much smaller than the backup's: it isn't saved over it until you say so. */
  shrunk?: { saved: number; now: number };
}

const supported = typeof window !== 'undefined' && 'showDirectoryPicker' in window;
const status: BackupStatus = { supported, saving: false, needsPermission: false, unsaved: false };
const listeners = new Set<() => void>();
const tell = () => listeners.forEach((f) => f());

/** Much smaller: fewer than three quarters of the saved photos, and at least 500 fewer. */
export const muchSmaller = (now: number, saved: number) => saved > 0 && now < saved * 0.75 && saved - now >= 500;
let smallerOk = false;
/** You said the smaller photo list is right (for example after deleting many photos): save it. */
export async function saveSmaller() { smallerOk = true; status.shrunk = undefined; tell(); await save(true); }
/** Puts the backup's photo list back in this browser (your photos aren't touched), then reopens the app. */
export async function bringBackLibrary() {
  if (!dir || !lib) return;
  const data = await readJson<{ items: Item[]; folders: Folder[]; meta: Meta }>(dir, 'library.json');
  await lib.replaceAll(data);
  location.reload();
}

export function useBackup(): BackupStatus {
  const [, set] = useState(0);
  useEffect(() => { const f = () => set((n) => n + 1); listeners.add(f); return () => { listeners.delete(f); }; }, []);
  return status;
}

// ---------- the chosen folder is remembered by the browser ----------
const handles = () => openDB('photo-organizer-folders', 1, { upgrade: (d) => d.createObjectStore('h') });
async function remembered(): Promise<{ dir: Dir; parent: string } | undefined> {
  try { const r = await (await handles()).get('h', 'backup'); return r?.dir ? r : undefined; } catch { return undefined; }
}
async function remember(dir: Dir, parent: string) {
  try { await (await handles()).put('h', { dir, parent }, 'backup'); } catch { /* the folder is then asked for again next time */ }
}

async function permitted(dir: Dir, ask: boolean): Promise<boolean> {
  const a = dir as any;
  if ((await a.queryPermission?.({ mode: 'readwrite' })) === 'granted') return true;
  return ask && (await a.requestPermission?.({ mode: 'readwrite' })) === 'granted';
}

// ---------- files ----------
async function writeJson(dir: Dir, name: string, data: unknown) {
  const w = await (await dir.getFileHandle(name, { create: true })).createWritable();
  await w.write(JSON.stringify(data));
  await w.close(); // the old file is only replaced once the new one is complete
}
async function readJson<T>(dir: Dir, name: string): Promise<T> {
  return JSON.parse(await (await (await dir.getFileHandle(name)).getFile()).text());
}
async function names(dir: Dir): Promise<string[]> {
  const out: string[] = [];
  for await (const [n, h] of (dir as any).entries() as AsyncIterable<[string, FileSystemHandle]>) if (h.kind === 'file') out.push(n);
  return out;
}
type Kind = 'faces' | 'pictures' | 'sort' | 'newfaces';
const chunkName = (n: number, kind: Kind = 'faces') => `${kind}-${String(n).padStart(4, '0')}.json`;
const chunkNo = (name: string, kind: Kind = 'faces') => { const m = name.match(/^(faces|pictures|sort|newfaces)-(\d+)\.json$/); return m && m[1] === kind ? +m[2] : undefined; };
const chunks = (files: string[], kind: Kind) => files.map((n) => chunkNo(n, kind)).filter((n): n is number => n != null);
async function hasBackup(dir: Dir): Promise<Manifest | undefined> {
  try { return await readJson<Manifest>(dir, 'backup.json'); } catch { return undefined; }
}
/** The backup folder inside what the user picked (or the picked folder itself, if it is one). */
async function backupDirIn(picked: Dir, create: boolean): Promise<Dir | undefined> {
  if (picked.name === BACKUP_FOLDER || (await hasBackup(picked))) return picked;
  try { return await picked.getDirectoryHandle(BACKUP_FOLDER, { create }); } catch { return undefined; }
}

// Fingerprints are kept as base64 float32: a third of the size of plain numbers.
const f32 = (a: ArrayLike<number>) => { const b = new Uint8Array(Float32Array.from(a).buffer); let s = ''; for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]); return btoa(s); };
const unf32 = (s: string) => Array.from(new Float32Array(Uint8Array.from(atob(s), (c) => c.charCodeAt(0)).buffer));
const b64 = (a: ArrayBufferView) => { const b = new Uint8Array(a.buffer, a.byteOffset, a.byteLength); let s = ''; for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]); return btoa(s); };
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

interface PicRow { i: string; h?: string; g?: string; e?: string; s?: number; f?: number; a?: number; c?: number[]; m?: number; x?: 1; W?: number; H?: number }
const picRow = (r: PicRec): PicRow => (r.x ? { i: r.id, x: 1, m: r.m } : { i: r.id, h: b64(r.h!), g: b64(r.g!), e: b64(r.e!), s: r.sh, f: r.fl, a: r.ar, c: r.c, m: r.m, W: r.pw, H: r.ph });
const fromPicRow = (w: PicRow, b: number): PicRec => (w.x ? { id: w.i, x: 1, m: w.m, b } : {
  id: w.i, h: new Uint32Array(unb64(w.h!).buffer), g: unb64(w.g!), e: new Int8Array(unb64(w.e!).buffer), sh: w.s, fl: w.f, ar: w.a, c: w.c, m: w.m, pw: w.W, ph: w.H, b,
});

// v = which AI made the fingerprint (none = the first, compressed one; those are made again).
interface SortRow { i: string; k?: string; x?: 1; m?: number; v?: number }
const sortRow = (r: SortRec): SortRow => (r.x ? { i: r.id, x: 1, m: r.m } : { i: r.id, k: b64(r.k!), m: r.m, v: r.v });
const fromSortRow = (w: SortRow, b: number): SortRec => (w.x ? { id: w.i, x: 1, m: w.m, b } : { id: w.i, k: new Int8Array(unb64(w.k!).buffer), m: w.m, b, v: w.v });
interface CleanupFile { v: 1; fixes: [string, string][]; checks: [string, Check][] }

/** m, s, t: which face AI, and (AdaFace) how sure and how turned. See Face. */
interface FaceRow { k: string; i: string; d: string; x: StoredFace['box']; c: string; m?: string; s?: number; t?: number }
const faceRow = (f: Face): FaceRow => ({ k: f.key, i: f.itemId, d: f32(f.d), x: f.box, c: f.crop, ...(f.m ? { m: f.m, s: f.s, t: f.t } : {}) });
const fromFaceRow = (r: FaceRow): Face => ({ key: r.k, itemId: r.i, d: unf32(r.d), box: r.x, crop: r.c, ...(r.m ? { m: r.m, s: r.s, t: r.t } : {}) });
interface NewFacesFile { v: 1; scanned: string[] }
interface PersonRow { id: string; name?: string; n: number; cover: string; s: string; /** set aside as a stranger (1) or brought back (0) */ x?: 0 | 1; /** faces you said aren't this person */ no?: string[] }
interface PeopleFile { v: 1; people: PersonRow[]; who: Record<string, string>; scanned: string[] }

// ---------- saving ----------
let lib: Library | null = null;
let dir: Dir | null = null;
let libDirty = false;
let seen = { edits: 0, faces: 0, resets: 0 };
let seenPics = 0;
let seenTopics = 0;
let seenKept = 0;
let seenSort = { n: 0, edits: 0 };
let timer: ReturnType<typeof setTimeout> | undefined;
let due = 0;
let wasRunning = false;
let wasComparing = false;
let wasSorting = false;

/** Saves within `ms`, or sooner if a save is already planned sooner. */
function soon(ms: number) {
  if (!dir) return;
  if (!status.unsaved) { status.unsaved = true; tell(); }
  const at = Date.now() + ms;
  if (timer && due <= at) return;
  if (timer) clearTimeout(timer);
  due = at;
  timer = setTimeout(() => { timer = undefined; save().catch(() => {}); }, ms);
}

/** Starts watching for changes. Call once when the app opens. */
export async function startBackup(library: Library, demo: boolean) {
  lib = library;
  if (!supported || demo) return;
  try { await (navigator.storage as any)?.persist?.(); } catch { /* only a hint to the browser */ }
  libraryEvents.changed = () => { libDirty = true; soon(180_000); };
  hooks.beforeSwitch = keepOldFaces;
  subscribe(() => {
    if (changes.edits !== seen.edits) soon(15_000); // names and joins: saved within seconds
    else if (changes.faces !== seen.faces || changes.resets !== seen.resets) soon(300_000); // while finding faces: every 5 minutes
  });
  subscribePictures(() => { if (picChanges.n !== seenPics) soon(300_000); }); // while comparing pictures: every 5 minutes
  subscribeTopics(() => { if (topicChanges.n !== seenTopics) soon(15_000); }); // a search finished or a topic changed
  subscribeKept(() => { if (keptChanges.n !== seenKept) soon(15_000); }); // a duplicate set kept, or shown again
  subscribeSort(() => {
    if (sortChanges.edits !== seenSort.edits) soon(15_000); // fixes and checks: saved within seconds
    else if (sortChanges.n !== seenSort.n) soon(300_000); // while sorting: every 5 minutes
  });
  // Finding faces or comparing pictures stopped or finished: save what it found.
  setInterval(async () => {
    if (!dir) return;
    const st = await ready();
    if (wasRunning && !st.run.running && changes.faces !== seen.faces) soon(3_000);
    wasRunning = st.run.running;
    const ps = await picturesReady();
    if (wasComparing && !ps.run.running && picChanges.n !== seenPics) soon(3_000);
    wasComparing = ps.run.running;
    const ss = await sortReady();
    if (wasSorting && !ss.run.running && sortChanges.n !== seenSort.n) soon(3_000);
    wasSorting = ss.run.running;
  }, 5000);
  const r = await remembered();
  if (!r) return;
  dir = r.dir; status.folder = r.parent;
  try { status.saved = await hasBackup(dir); status.savedAt = status.saved?.savedAt; } catch { /* asked for permission below */ }
  if (!(await permitted(dir, false))) { status.needsPermission = true; tell(); return; }
  await check();
  tell();
}

/** Faces this browser thinks are in the backup, but whose file is gone: save them again. */
async function check() {
  if (!dir) return;
  const st = await ready();
  const files = await names(dir);
  const have = new Set(chunks(files, 'faces'));
  const lost = [...st.faces.values()].filter((f) => f.b != null && !have.has(f.b)).map((f) => f.key);
  if (lost.length) { await markBackedUp(lost, undefined); soon(2_000); }
  const haveNew = new Set(chunks(files, 'newfaces'));
  const lostNew = [...st.next.faces.values()].filter((f) => f.b != null && !haveNew.has(f.b)).map((f) => f.key);
  if (lostNew.length) { await markNextBackedUp(lostNew, undefined); soon(2_000); }
  const ps = await picturesReady();
  const havePics = new Set(chunks(files, 'pictures'));
  const lostPics = [...ps.recs.values()].filter((r) => r.b != null && !havePics.has(r.b)).map((r) => r.id);
  if (lostPics.length) { await markPicsBackedUp(lostPics, undefined); soon(2_000); }
  const ss = await sortReady();
  const haveSort = new Set(chunks(files, 'sort'));
  const lostSort = [...ss.recs.values()].filter((r) => r.b != null && !haveSort.has(r.b)).map((r) => r.id);
  if (lostSort.length) { await markSortBackedUp(lostSort, undefined); soon(2_000); }
}

/**
 * Just before switching to the stronger face AI: copies people.json and the faces files as they are into
 * "before-new-face-ai" in the backup folder, so the old faces and names are never lost. Done once; a copy already
 * there is kept as it is.
 */
async function keepOldFaces() {
  if (!dir || !(await permitted(dir, false))) return;
  await save(true); // first, everything found so far
  const files = await names(dir);
  if (!files.includes('people.json')) return;
  const keep = await dir.getDirectoryHandle('before-new-face-ai', { create: true });
  if ((await names(keep)).includes('people.json')) return;
  for (const n of files.filter((f) => chunkNo(f) != null).concat('people.json')) {
    const data = await (await (await dir.getFileHandle(n)).getFile()).arrayBuffer();
    const w = await (await keep.getFileHandle(n, { create: true })).createWritable();
    await w.write(data); await w.close();
  }
}

/** After a click: allow saving again to the remembered folder (browsers ask once per visit unless told to always allow). */
export async function allowAgain(): Promise<void> {
  if (!dir) return;
  if (!(await permitted(dir, true))) return;
  status.needsPermission = false;
  await check();
  await save(true);
}

export async function save(force = false): Promise<void> {
  if (!dir || !lib || status.saving) return;
  if (!(await permitted(dir, false))) { status.needsPermission = true; tell(); return; }
  status.saving = true; status.error = undefined; tell();
  const before = { ...changes };
  const picsBefore = picChanges.n;
  const topicsBefore = topicChanges.n;
  const keptBefore = keptChanges.n;
  const sortBefore = { ...sortChanges };
  const libWasDirty = libDirty; libDirty = false;
  try {
    const st = await ready();
    const files = await names(dir);
    // 1. Faces not in the backup yet go into new files (existing files never change).
    let next = Math.max(0, ...chunks(files, 'faces')) + 1;
    const fresh = [...st.faces.values()].filter((f) => f.b == null);
    for (let i = 0; i < fresh.length; i += 2000) {
      const part = fresh.slice(i, i + 2000);
      await writeJson(dir, chunkName(next), part.map(faceRow));
      await markBackedUp(part.map((f) => f.key), next);
      next++;
    }
    // 1a. Faces found while reading the photos again with the stronger face AI, the same way, and which photos are done.
    let nextNew = Math.max(0, ...chunks(files, 'newfaces')) + 1;
    const freshNew = [...st.next.faces.values()].filter((f) => f.b == null);
    for (let i = 0; i < freshNew.length; i += 2000) {
      const part = freshNew.slice(i, i + 2000);
      await writeJson(dir, chunkName(nextNew, 'newfaces'), part.map(faceRow));
      await markNextBackedUp(part.map((f) => f.key), nextNew);
      nextNew++;
    }
    if (st.next.scanned.size) {
      const unsavedNew = new Set([...st.next.faces.values()].filter((f) => f.b == null).map((f) => f.itemId));
      const data: NewFacesFile = { v: 1, scanned: [...st.next.scanned].filter((id) => !unsavedNew.has(id)) };
      await writeJson(dir, 'newfaces.json', data);
    } else if (files.includes('newfaces.json')) await dir.removeEntry('newfaces.json').catch(() => {});
    // 1b. Pictures compared since the last save, the same way.
    const ps = await picturesReady();
    let nextPic = Math.max(0, ...chunks(files, 'pictures')) + 1;
    const freshPics = [...ps.recs.values()].filter((r) => r.b == null);
    for (let i = 0; i < freshPics.length; i += 2000) {
      const part = freshPics.slice(i, i + 2000);
      await writeJson(dir, chunkName(nextPic, 'pictures'), part.map(picRow));
      await markPicsBackedUp(part.map((r) => r.id), nextPic);
      nextPic++;
    }
    // 1c. What the Clean-up AI saw, the same way.
    const ss = await sortReady();
    let nextSort = Math.max(0, ...chunks(files, 'sort')) + 1;
    const freshSort = [...ss.recs.values()].filter((r) => r.b == null);
    for (let i = 0; i < freshSort.length; i += 4000) {
      const part = freshSort.slice(i, i + 4000);
      await writeJson(dir, chunkName(nextSort, 'sort'), part.map(sortRow));
      await markSortBackedUp(part.map((r) => r.id), nextSort);
      nextSort++;
    }
    // 1d. Your Clean-up fixes and checks (never replaced by an empty list unless you cleared them here).
    if (sortChanges.edits !== seenSort.edits || !files.includes('cleanup.json') || force) {
      if (ss.fixes.size || ss.checks.size || !(status.saved?.fixes)) {
        const data: CleanupFile = { v: 1, fixes: [...ss.fixes], checks: [...ss.checks] };
        await writeJson(dir, 'cleanup.json', data);
      }
    }
    // 2. People and names. Photos whose faces aren't all saved yet are left out, so they're looked at again after a restore.
    const unsaved = new Set([...st.faces.values()].filter((f) => f.b == null).map((f) => f.itemId));
    const who: Record<string, string> = {};
    for (const f of st.faces.values()) if (f.b != null) who[f.key] = f.person;
    const people: PersonRow[] = [...st.people.values()].map((p) => ({ id: p.id, name: p.name, n: p.n, cover: p.cover, s: f32(p.sum), ...(p.stranger != null ? { x: p.stranger ? 1 : 0 } as const : {}), ...(p.no?.length ? { no: p.no } : {}) }));
    const prev = status.saved;
    // Never replace a backup that has people with an empty one (only "Start over" may do that).
    if (people.length || !prev?.people || changes.resets !== seen.resets) {
      const data: PeopleFile = { v: 1, people, who, scanned: [...st.scanned].filter((id) => !unsaved.has(id)) };
      await writeJson(dir, 'people.json', data);
      const day = new Date().toISOString().slice(0, 10);
      if (people.length) await writeJson(dir, `people-${day}.json`, data); // a day's copy is never emptied
      const days = files.filter((n) => /^people-\d{4}-\d\d-\d\d\.json$/.test(n) && n !== `people-${day}.json`).sort();
      for (const old of days.slice(0, Math.max(0, days.length - 9))) await dir.removeEntry(old).catch(() => {});
    }
    // 2b. Search topics, when they changed (a backup's topics are never replaced by ones that found nothing).
    const ts = await topicsReady();
    const anyFound = ts.topics.some((t) => t.keys.length || t.yes?.length || t.no?.length);
    const hasFile = files.includes('topics.json');
    if (topicChanges.n !== seenTopics || !hasFile || (force && anyFound)) {
      await writeJson(dir, 'topics.json', { v: 1, topics: ts.topics });
    }
    // 2c. Duplicate sets you kept (never replaced by an empty list unless you emptied it here).
    const ks = await keptReady();
    if (keptChanges.n !== seenKept || (!files.includes('kept.json') && ks.sets.length) || (force && ks.sets.length)) {
      if (ks.sets.length || files.includes('kept.json')) await writeJson(dir, 'kept.json', { v: 1, sets: ks.sets });
    }
    // 3. The library, when it changed: never an empty one over a full one, and a much smaller one only after you say
    // so (choosing another folder, or a Google Photos or Drive read that didn't finish, would otherwise drop most of it).
    let photos = prev?.photos ?? 0;
    if (libWasDirty || force || !files.includes('library.json')) {
      const d = await lib.load();
      const saved = prev?.photos ?? 0;
      if (d.items.length && muchSmaller(d.items.length, saved) && !smallerOk && files.includes('library.json')) {
        status.shrunk = { saved, now: d.items.length };
        libDirty = true; // saved once you decide
      } else if (d.items.length || !saved) {
        if (smallerOk && files.includes('library.json')) {
          // Keep the bigger list as a dated file too (the 3 newest are kept).
          const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
          await writeJson(dir, `library-before-${stamp}.json`, await readJson(dir, 'library.json'));
          const old = files.filter((n) => /^library-before-.+\.json$/.test(n)).sort();
          for (const n of old.slice(0, Math.max(0, old.length - 2))) await dir.removeEntry(n).catch(() => {});
        }
        await writeJson(dir, 'library.json', d); photos = d.items.length;
        smallerOk = false; status.shrunk = undefined;
      }
    }
    const m: Manifest = { app: 'Photo Organizer', v: 1, savedAt: new Date().toISOString(), photos, faces: st.faces.size, people: st.people.size, named: [...st.people.values()].filter((p) => p.name).length, pictures: ps.recs.size, sorted: ss.recs.size, fixes: ss.fixes.size, ...(st.next.scanned.size ? { next: st.next.scanned.size } : {}) };
    await writeJson(dir, 'backup.json', m);
    // Face files no face points to any more (after "Start over", or replaced by newer files) are removed last.
    const used = new Set([...st.faces.values()].map((f) => f.b));
    for (const n of files) { const c = chunkNo(n); if (c != null && !used.has(c)) await dir.removeEntry(n).catch(() => {}); }
    const usedNew = new Set([...st.next.faces.values()].map((f) => f.b));
    for (const n of files) { const c = chunkNo(n, 'newfaces'); if (c != null && !usedNew.has(c)) await dir.removeEntry(n).catch(() => {}); }
    const usedPics = new Set([...ps.recs.values()].map((r) => r.b));
    for (const n of files) { const c = chunkNo(n, 'pictures'); if (c != null && !usedPics.has(c)) await dir.removeEntry(n).catch(() => {}); }
    const usedSort = new Set([...ss.recs.values()].map((r) => r.b));
    for (const n of files) { const c = chunkNo(n, 'sort'); if (c != null && !usedSort.has(c)) await dir.removeEntry(n).catch(() => {}); }
    seen = before;
    seenPics = picsBefore;
    seenTopics = topicsBefore;
    seenKept = keptBefore;
    seenSort = sortBefore;
    status.saved = m; status.savedAt = m.savedAt;
    status.unsaved = changes.edits !== seen.edits || changes.faces !== seen.faces || picChanges.n !== seenPics || topicChanges.n !== seenTopics || keptChanges.n !== seenKept || sortChanges.n !== seenSort.n || sortChanges.edits !== seenSort.edits || libDirty;
  } catch (e) {
    libDirty ||= libWasDirty;
    status.error = `The backup couldn't be saved: ${(e as Error).message}`;
    status.unsaved = true;
  } finally {
    status.saving = false; tell();
  }
}

// ---------- choosing a folder, restoring ----------
async function pick(): Promise<Dir> {
  return (window as any).showDirectoryPicker({ id: 'po-backup', mode: 'readwrite', startIn: 'documents' });
}

/**
 * The user picks where backups go. If that folder already holds a backup, nothing is written yet: the caller asks
 * whether to restore it, or (only when this browser has at least as much) to keep saving there.
 */
export async function chooseFolder(): Promise<{ existing?: Manifest; canContinue: boolean; use: () => Promise<void>; restore: () => Promise<void> }> {
  const picked = await pick();
  const target = await backupDirIn(picked, true);
  if (!target) throw new Error('The app can’t create its backup folder there. Try another folder.');
  const parent = picked.name;
  const existing = await hasBackup(target);
  const st = await ready();
  const named = [...st.people.values()].filter((p) => p.name).length;
  const photos = (await lib?.load())?.items.length ?? 0;
  const ps = await picturesReady();
  const ss = await sortReady();
  // Saving over an existing backup is only offered when nothing in it can be lost.
  const canContinue = !existing || (st.faces.size >= existing.faces && st.people.size >= existing.people && named >= existing.named && photos >= existing.photos && ps.recs.size >= (existing.pictures ?? 0) && ss.recs.size >= (existing.sorted ?? 0) && ss.fixes.size >= (existing.fixes ?? 0));
  const use = async () => {
    if (!canContinue) return;
    dir = target; status.folder = parent; status.needsPermission = false;
    status.saved = existing;
    await remember(target, parent);
    // Everything is written to this folder afresh; old face files are removed once the new ones are saved.
    await markBackedUp([...st.faces.keys()], undefined);
    await markNextBackedUp([...st.next.faces.keys()], undefined);
    await markPicsBackedUp([...ps.recs.keys()], undefined);
    await markSortBackedUp([...ss.recs.keys()], undefined);
    await save(true);
  };
  return { existing, canContinue, use, restore: () => restoreFrom(target, parent) };
}

/** The user picks a folder holding a backup; it replaces what's in this browser. */
export async function findBackup(): Promise<{ manifest: Manifest; restore: () => Promise<void> }> {
  const picked = await pick();
  const target = await backupDirIn(picked, false);
  const manifest = target && (await hasBackup(target));
  if (!target || !manifest) throw new Error(`No backup found in “${picked.name}”. Choose the folder called “${BACKUP_FOLDER}” or the folder that contains it.`);
  return { manifest, restore: () => restoreFrom(target, picked.name) };
}

async function restoreFrom(target: Dir, parent: string) {
  if (!lib) return;
  const all = await names(target);
  const library = await readJson<Parameters<Library['replaceAll']>[0]>(target, 'library.json').catch(() => undefined);
  const pf = await readJson<PeopleFile>(target, 'people.json').catch(() => undefined);
  const faces: StoredFace[] = [];
  if (pf) {
    for (const n of chunks(all, 'faces').sort((a, b) => a - b)) {
      const rows = await readJson<FaceRow[]>(target, chunkName(n));
      for (const r of rows) { const person = pf.who[r.k]; if (person) faces.push({ ...fromFaceRow(r), person, b: n }); }
    }
  }
  const nf = await readJson<NewFacesFile>(target, 'newfaces.json').catch(() => undefined);
  const newFaces: (Face & { b: number })[] = [];
  if (nf) for (const n of chunks(all, 'newfaces').sort((a, b) => a - b)) for (const r of await readJson<FaceRow[]>(target, chunkName(n, 'newfaces'))) newFaces.push({ ...fromFaceRow(r), b: n });
  const pics: PicRec[] = [];
  for (const n of chunks(all, 'pictures').sort((a, b) => a - b)) {
    for (const w of await readJson<PicRow[]>(target, chunkName(n, 'pictures'))) pics.push(fromPicRow(w, n));
  }
  const topics = await readJson<{ topics: Topic[] }>(target, 'topics.json').catch(() => undefined);
  const sorted: SortRec[] = [];
  for (const n of chunks(all, 'sort').sort((a, b) => a - b)) {
    for (const w of await readJson<SortRow[]>(target, chunkName(n, 'sort'))) sorted.push(fromSortRow(w, n));
  }
  const cleanup = await readJson<CleanupFile>(target, 'cleanup.json').catch(() => undefined);
  const kept = await readJson<{ sets: string[][] }>(target, 'kept.json').catch(() => undefined);
  if (library) await lib.replaceAll(library);
  if (pics.length) await replaceAllPics(pics);
  if (topics?.topics?.length) await replaceAllTopics(topics.topics);
  if (kept?.sets?.length) await replaceAllKept(kept.sets);
  if (sorted.length || cleanup?.fixes?.length) await replaceAllSort(sorted, cleanup?.fixes ?? [], cleanup?.checks ?? []);
  if (pf) {
    const people: Person[] = pf.people.map((p) => ({ id: p.id, name: p.name, n: p.n, cover: p.cover, sum: unf32(p.s), ...(p.x != null ? { stranger: p.x === 1 } : {}), ...(p.no?.length ? { no: p.no } : {}) }));
    await replaceAll(people, faces, pf.scanned);
  }
  if (nf) { const done = new Set(nf.scanned); await replaceNext(newFaces.filter((f) => done.has(f.itemId)), nf.scanned); }
  dir = target; status.folder = parent; status.needsPermission = false;
  await remember(target, parent);
  seen = { ...changes };
  seenPics = picChanges.n;
  seenTopics = topicChanges.n;
  seenKept = keptChanges.n;
  seenSort = { ...sortChanges };
  status.saved = await hasBackup(target); status.savedAt = status.saved?.savedAt; status.unsaved = false;
  tell();
}
