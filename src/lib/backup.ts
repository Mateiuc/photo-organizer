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
import { useEffect, useState } from 'react';
import { openDB } from 'idb';
import { changes, markBackedUp, ready, replaceAll, subscribe, type StoredFace } from '../faces/people';
import type { Person } from '../faces/cluster';
import { libraryEvents, type Library } from './store';
import { markPicsBackedUp, picChanges, picturesReady, replaceAllPics, subscribePictures, type PicRec } from '../pictures/store';

export const BACKUP_FOLDER = 'Photo Organizer backup';
type Dir = FileSystemDirectoryHandle;

export interface Manifest { app: 'Photo Organizer'; v: 1; savedAt: string; photos: number; faces: number; people: number; named: number; pictures?: number }
export interface BackupStatus {
  supported: boolean;
  folder?: string; // name of the backup folder's parent, as the user picked it
  savedAt?: string;
  saved?: Manifest;
  saving: boolean;
  needsPermission: boolean;
  unsaved: boolean;
  error?: string;
}

const supported = typeof window !== 'undefined' && 'showDirectoryPicker' in window;
const status: BackupStatus = { supported, saving: false, needsPermission: false, unsaved: false };
const listeners = new Set<() => void>();
const tell = () => listeners.forEach((f) => f());

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
type Kind = 'faces' | 'pictures';
const chunkName = (n: number, kind: Kind = 'faces') => `${kind}-${String(n).padStart(4, '0')}.json`;
const chunkNo = (name: string, kind: Kind = 'faces') => { const m = name.match(/^(faces|pictures)-(\d+)\.json$/); return m && m[1] === kind ? +m[2] : undefined; };
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

interface FaceRow { k: string; i: string; d: string; x: StoredFace['box']; c: string }
interface PersonRow { id: string; name?: string; n: number; cover: string; s: string }
interface PeopleFile { v: 1; people: PersonRow[]; who: Record<string, string>; scanned: string[] }

// ---------- saving ----------
let lib: Library | null = null;
let dir: Dir | null = null;
let libDirty = false;
let seen = { edits: 0, faces: 0, resets: 0 };
let seenPics = 0;
let timer: ReturnType<typeof setTimeout> | undefined;
let due = 0;
let wasRunning = false;
let wasComparing = false;

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
  subscribe(() => {
    if (changes.edits !== seen.edits) soon(15_000); // names and joins: saved within seconds
    else if (changes.faces !== seen.faces || changes.resets !== seen.resets) soon(300_000); // while finding faces: every 5 minutes
  });
  subscribePictures(() => { if (picChanges.n !== seenPics) soon(300_000); }); // while comparing pictures: every 5 minutes
  // Finding faces or comparing pictures stopped or finished: save what it found.
  setInterval(async () => {
    if (!dir) return;
    const st = await ready();
    if (wasRunning && !st.run.running && changes.faces !== seen.faces) soon(3_000);
    wasRunning = st.run.running;
    const ps = await picturesReady();
    if (wasComparing && !ps.run.running && picChanges.n !== seenPics) soon(3_000);
    wasComparing = ps.run.running;
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
  const ps = await picturesReady();
  const havePics = new Set(chunks(files, 'pictures'));
  const lostPics = [...ps.recs.values()].filter((r) => r.b != null && !havePics.has(r.b)).map((r) => r.id);
  if (lostPics.length) { await markPicsBackedUp(lostPics, undefined); soon(2_000); }
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
  const libWasDirty = libDirty; libDirty = false;
  try {
    const st = await ready();
    const files = await names(dir);
    // 1. Faces not in the backup yet go into new files (existing files never change).
    let next = Math.max(0, ...chunks(files, 'faces')) + 1;
    const fresh = [...st.faces.values()].filter((f) => f.b == null);
    for (let i = 0; i < fresh.length; i += 2000) {
      const part = fresh.slice(i, i + 2000);
      await writeJson(dir, chunkName(next), part.map((f): FaceRow => ({ k: f.key, i: f.itemId, d: f32(f.d), x: f.box, c: f.crop })));
      await markBackedUp(part.map((f) => f.key), next);
      next++;
    }
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
    // 2. People and names. Photos whose faces aren't all saved yet are left out, so they're looked at again after a restore.
    const unsaved = new Set([...st.faces.values()].filter((f) => f.b == null).map((f) => f.itemId));
    const who: Record<string, string> = {};
    for (const f of st.faces.values()) if (f.b != null) who[f.key] = f.person;
    const people: PersonRow[] = [...st.people.values()].map((p) => ({ id: p.id, name: p.name, n: p.n, cover: p.cover, s: f32(p.sum) }));
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
    // 3. The library, when it changed (and never an empty one over a full one).
    let photos = prev?.photos ?? 0;
    if (libWasDirty || force || !files.includes('library.json')) {
      const d = await lib.load();
      if (d.items.length || !prev?.photos) { await writeJson(dir, 'library.json', d); photos = d.items.length; }
    }
    const m: Manifest = { app: 'Photo Organizer', v: 1, savedAt: new Date().toISOString(), photos, faces: st.faces.size, people: st.people.size, named: [...st.people.values()].filter((p) => p.name).length, pictures: ps.recs.size };
    await writeJson(dir, 'backup.json', m);
    // Face files no face points to any more (after "Start over", or replaced by newer files) are removed last.
    const used = new Set([...st.faces.values()].map((f) => f.b));
    for (const n of files) { const c = chunkNo(n); if (c != null && !used.has(c)) await dir.removeEntry(n).catch(() => {}); }
    const usedPics = new Set([...ps.recs.values()].map((r) => r.b));
    for (const n of files) { const c = chunkNo(n, 'pictures'); if (c != null && !usedPics.has(c)) await dir.removeEntry(n).catch(() => {}); }
    seen = before;
    seenPics = picsBefore;
    status.saved = m; status.savedAt = m.savedAt;
    status.unsaved = changes.edits !== seen.edits || changes.faces !== seen.faces || picChanges.n !== seenPics || libDirty;
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
  // Saving over an existing backup is only offered when nothing in it can be lost.
  const canContinue = !existing || (st.faces.size >= existing.faces && st.people.size >= existing.people && named >= existing.named && photos >= existing.photos && ps.recs.size >= (existing.pictures ?? 0));
  const use = async () => {
    if (!canContinue) return;
    dir = target; status.folder = parent; status.needsPermission = false;
    status.saved = existing;
    await remember(target, parent);
    // Everything is written to this folder afresh; old face files are removed once the new ones are saved.
    await markBackedUp([...st.faces.keys()], undefined);
    await markPicsBackedUp([...ps.recs.keys()], undefined);
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
      for (const r of rows) { const person = pf.who[r.k]; if (person) faces.push({ key: r.k, itemId: r.i, d: unf32(r.d), box: r.x, crop: r.c, person, b: n }); }
    }
  }
  const pics: PicRec[] = [];
  for (const n of chunks(all, 'pictures').sort((a, b) => a - b)) {
    for (const w of await readJson<PicRow[]>(target, chunkName(n, 'pictures'))) pics.push(fromPicRow(w, n));
  }
  if (library) await lib.replaceAll(library);
  if (pics.length) await replaceAllPics(pics);
  if (pf) {
    const people: Person[] = pf.people.map((p) => ({ id: p.id, name: p.name, n: p.n, cover: p.cover, sum: unf32(p.s) }));
    await replaceAll(people, faces, pf.scanned);
  }
  dir = target; status.folder = parent; status.needsPermission = false;
  await remember(target, parent);
  seen = { ...changes };
  seenPics = picChanges.n;
  status.saved = await hasBackup(target); status.savedAt = status.saved?.savedAt; status.unsaved = false;
  tell();
}
