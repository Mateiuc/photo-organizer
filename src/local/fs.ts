// Photos in a folder on this computer: any disk, USB stick, or a Google Drive / OneDrive / Dropbox folder synced to the PC.
// Uses the browser's folder access (Chrome and Edge). Nothing is uploaded; files are read where they are.
import exifr from 'exifr';
import { openDB } from 'idb';
import { localToItem, mimeFromName, type Folder, type Item, type LocalFile } from '../lib/model';

export const TRASH = '_Trash';
type Dir = FileSystemDirectoryHandle;
type Entry = FileSystemFileHandle | File;

/** Full folder access (read, and move to _Trash) is in Chrome and Edge. Other browsers can only read a folder. */
export const canWrite = typeof window !== 'undefined' && 'showDirectoryPicker' in window;

// What this browser session can open: file id → file, folder id → folder.
const files = new Map<string, Entry>();
const dirs = new Map<string, Dir>();
let root: Dir | null = null;
export const isOpen = () => files.size > 0 || !!root;
export const hasFile = (id: string) => files.has(id);

export async function getLocalFile(id: string): Promise<File | undefined> {
  const e = files.get(id);
  if (!e) return undefined;
  return e instanceof File ? e : e.getFile();
}

// The chosen folder is remembered by the browser so it can be reopened with one click.
const handles = () => openDB('photo-organizer-folders', 1, { upgrade: (d) => d.createObjectStore('h') });
export async function rememberedFolder(): Promise<Dir | undefined> {
  try { return await (await handles()).get('h', 'root'); } catch { return undefined; }
}

export async function pickFolder(): Promise<Dir> {
  const h: Dir = await (window as any).showDirectoryPicker({ id: 'photos', mode: 'readwrite' });
  try { await (await handles()).put('h', h, 'root'); } catch { /* remembering is a convenience */ }
  return h;
}

export async function askAccess(h: Dir, write = false): Promise<boolean> {
  const mode = write ? 'readwrite' : 'read';
  const a = h as any;
  if ((await a.queryPermission?.({ mode })) === 'granted') return true;
  return (await a.requestPermission?.({ mode })) === 'granted';
}

export interface LocalProgress { folders: number; files: number; current: string }

async function readExif(file: File): Promise<LocalFile['exif']> {
  try {
    const e = await exifr.parse(file, {
      tiff: true, exif: true, gps: true, ifd1: false, xmp: false, icc: false, iptc: false, jfif: false, reviveValues: false,
      pick: ['DateTimeOriginal', 'CreateDate', 'Make', 'Model', 'ExifImageWidth', 'ExifImageHeight', 'ImageWidth', 'ImageHeight', 'GPSLatitude', 'GPSLatitudeRef', 'GPSLongitude', 'GPSLongitudeRef'],
    });
    if (!e) return undefined;
    return {
      time: e.DateTimeOriginal ?? e.CreateDate, make: e.Make, model: e.Model,
      width: e.ExifImageWidth ?? e.ImageWidth, height: e.ExifImageHeight ?? e.ImageHeight,
      lat: e.latitude, lon: e.longitude,
    };
  } catch { return undefined; }
}

async function toLocalItem(file: File, path: string, folderId: string, known: Map<string, Item>): Promise<Item | null> {
  const id = 'local:' + path;
  const old = known.get(id);
  if (old && old.size === file.size && old.mtime === file.lastModified) return old; // unchanged since last scan
  const isVideo = mimeFromName(file.name).startsWith('video/');
  const exif = isVideo ? undefined : await readExif(file);
  return localToItem({ path, name: file.name, size: file.size, mtime: file.lastModified, folderId, exif });
}

const skip = (name: string) => name.startsWith('.') || name === TRASH || name === '$RECYCLE.BIN' || name === 'System Volume Information';

/** Reads every photo and video in the folder and its subfolders, a folder at a time. */
export async function scanFolder(
  top: Dir,
  known: Map<string, Item>,
  onFolder: (folder: Folder, items: Item[], subs: Folder[]) => Promise<void>,
  onProgress: (p: LocalProgress) => void,
  signal: { stop: boolean },
): Promise<Folder> {
  root = top; files.clear(); dirs.clear();
  const rootFolder: Folder = { id: 'local:' + top.name, name: top.name };
  const queue: { dir: Dir; folder: Folder; path: string }[] = [{ dir: top, folder: rootFolder, path: top.name }];
  let nFolders = 0, nFiles = 0;
  // 1. List every folder first (quick), several at a time.
  const tasks: { h: FileSystemFileHandle; path: string; folderId: string }[] = [];
  const listOne = async ({ dir, folder, path }: (typeof queue)[number]) => {
    dirs.set(folder.id, dir);
    const subs: Folder[] = [];
    for await (const [name, h] of (dir as any).entries() as AsyncIterable<[string, FileSystemHandle]>) {
      if (skip(name)) continue;
      if (h.kind === 'directory') {
        const f: Folder = { id: 'local:' + path + '/' + name, name, parentId: folder.id };
        subs.push(f);
        queue.push({ dir: h as Dir, folder: f, path: path + '/' + name });
      } else if (mimeFromName(name)) {
        tasks.push({ h: h as FileSystemFileHandle, path: path + '/' + name, folderId: folder.id });
      }
    }
    nFolders++;
    onProgress({ folders: nFolders, files: tasks.length, current: path });
    await onFolder(folder, [], subs);
  };
  let listing = 0;
  await new Promise<void>((done, fail) => {
    const pump = () => {
      if (signal.stop) { if (!listing) done(); return; }
      while (listing < 8 && queue.length) {
        listing++;
        listOne(queue.shift()!).then(() => { listing--; pump(); }, fail);
      }
      if (!listing && !queue.length) done();
    };
    pump();
  });

  // 2. Read the files, many at once: with cloud folders (Google Drive, OneDrive) each file
  //    may have to come from the internet, so waiting on one at a time is what makes it slow.
  let next = 0, ready: Item[] = [], last = Date.now();
  const flush = async () => { if (ready.length) { const out = ready; ready = []; await onFolder(rootFolder, out, []); } };
  const worker = async () => {
    while (next < tasks.length && !signal.stop) {
      const t = tasks[next++];
      try {
        const file = await t.h.getFile();
        const it = await toLocalItem(file, t.path, t.folderId, known);
        if (it) { files.set(it.id, t.h); ready.push(it); nFiles++; }
      } catch { /* unreadable file: skip it */ }
      if (Date.now() - last > 500) {
        last = Date.now();
        onProgress({ folders: nFolders, files: nFiles, current: t.path.slice(0, t.path.lastIndexOf('/')) + ` (${nFiles.toLocaleString()} of ${tasks.length.toLocaleString()})` });
        if (ready.length >= 200) await flush();
      }
    }
  };
  await Promise.all(Array.from({ length: 24 }, worker));
  await flush();
  return rootFolder;
}

/** For browsers without folder access: the files from an <input webkitdirectory>. Read only. */
export async function scanFileList(
  list: File[],
  known: Map<string, Item>,
  onFolder: (folder: Folder, items: Item[], subs: Folder[]) => Promise<void>,
  onProgress: (p: LocalProgress) => void,
  signal: { stop: boolean },
): Promise<Folder | undefined> {
  root = null; files.clear(); dirs.clear();
  const media = list.filter((f) => mimeFromName(f.name) && !(f as any).webkitRelativePath.split('/').some(skip));
  if (!media.length) return undefined;
  const folders = new Map<string, Folder>();
  const fresh: Folder[] = [];
  const folderOf = (dirPath: string): Folder => {
    let f = folders.get(dirPath);
    if (f) return f;
    const cut = dirPath.lastIndexOf('/');
    f = { id: 'local:' + dirPath, name: dirPath.slice(cut + 1), parentId: cut > 0 ? folderOf(dirPath.slice(0, cut)).id : undefined };
    folders.set(dirPath, f);
    fresh.push(f);
    return f;
  };
  let n = 0;
  for (let i = 0; i < media.length && !signal.stop; i += 8) {
    const its = (await Promise.all(media.slice(i, i + 8).map(async (file) => {
      const p: string = (file as any).webkitRelativePath;
      const it = await toLocalItem(file, p, folderOf(p.slice(0, p.lastIndexOf('/'))).id, known);
      if (it) files.set(it.id, file);
      return it;
    }))).filter((x): x is Item => !!x);
    n += its.length;
    onProgress({ folders: folders.size, files: n, current: media[i].webkitRelativePath.split('/').slice(0, -1).join('/') });
    await onFolder({ id: '', name: '' }, its, fresh.splice(0));
  }
  return folderOf((media[0] as any).webkitRelativePath.split('/')[0]);
}

/**
 * Content fingerprint for duplicate checks. Small files are hashed whole; big videos by size plus their
 * first and last 4 MB, which is enough to tell real copies apart without reading gigabytes.
 */
export async function fingerprint(id: string): Promise<string | undefined> {
  const file = await getLocalFile(id);
  if (!file) return undefined;
  const CHUNK = 4 * 1024 * 1024;
  const data = file.size <= 64 * 1024 * 1024
    ? await file.arrayBuffer()
    : await new Blob([file.slice(0, CHUNK), file.slice(file.size - CHUNK), String(file.size)]).arrayBuffer();
  const h = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(h).slice(0, 16)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const errText = (e: unknown) => (e as Error)?.message || String(e);
const hasEntry = (d: Dir, name: string) => d.getFileHandle(name).then(() => true, () => false);
async function walkTo(from: Dir, path: string[], create: boolean): Promise<Dir> {
  let d = from;
  for (const part of path) d = await d.getDirectoryHandle(part, { create });
  return d;
}
/**
 * Where a file goes in the trash, in order of preference: _Trash in the chosen folder, keeping the file's sub-folders;
 * or, when no folder can be made at the top (like the top of a Google Drive "G:" drive, which only holds "My Drive"),
 * _Trash inside its first sub-folder ("My Drive/_Trash/…").
 */
function trashPaths(item: Item): string[][] {
  const below = item.id.slice('local:'.length).split('/').slice(1, -1);
  return below.length ? [[TRASH, ...below], [below[0], TRASH, ...below.slice(1)]] : [[TRASH]];
}

/** Moves a file into _Trash inside the chosen folder, keeping its folder path, so it can be checked or put back. */
export async function moveToTrash(item: Item): Promise<void> {
  if (!root) throw new Error('Open the folder again first (Drive & scan, then Scan).');
  const top = root;
  const h = files.get(item.id);
  const parent = item.folderId ? dirs.get(item.folderId) : undefined;
  if (!h || h instanceof File || !parent) throw new Error(`Can't reach ${item.name}. Scan the folder again.`);
  if (!(await askAccess(top, true))) throw new Error('The app needs permission to change files in this folder.');
  let dest: Dir | undefined;
  let why: unknown;
  for (const path of trashPaths(item)) {
    try { dest = await walkTo(top, path, true); break; } catch (e) { why = e; }
  }
  if (!dest) throw new Error(`Couldn't make a ${TRASH} folder in “${top.name}” for ${item.name}: ${errText(why)}`);
  const fh = h as any;
  if (typeof fh.move === 'function') {
    try { await fh.move(dest); files.delete(item.id); return; } catch {
      // Some drives (like Google Drive's G:) finish the move but still report an error: check before copying.
      if ((await hasEntry(dest, item.name)) && !(await hasEntry(parent, item.name))) { files.delete(item.id); return; }
    }
  }
  try {
    const src = await h.getFile();
    const out = await dest.getFileHandle(item.name, { create: true });
    const w = await (out as any).createWritable();
    await src.stream().pipeTo(w);
    await parent.removeEntry(item.name);
  } catch (e) {
    throw new Error(`Couldn't move ${item.name} into ${TRASH}: ${errText(e)}`);
  }
  files.delete(item.id);
}

/** Puts a file moved by moveToTrash back where it was (Undo). */
export async function restoreFromTrash(item: Item): Promise<void> {
  if (!root) throw new Error('Open the folder again first (Choose photos).');
  const top = root;
  const parent = item.folderId ? dirs.get(item.folderId) : undefined;
  if (!parent) throw new Error(`Can't find the folder of ${item.name}. Scan the folder again.`);
  if (!(await askAccess(top, true))) throw new Error('The app needs permission to change files in this folder.');
  let from: Dir | undefined;
  let h: FileSystemFileHandle | undefined;
  for (const path of trashPaths(item)) {
    try { const d = await walkTo(top, path, false); h = await d.getFileHandle(item.name); from = d; break; } catch { /* not here */ }
  }
  if (!from || !h) throw new Error(`Couldn't find ${item.name} in ${TRASH}.`);
  const taken = await hasEntry(parent, item.name);
  if (taken) throw new Error(`There is already a file called ${item.name} in its folder, so it was left in ${TRASH}.`);
  const fh = h as any;
  if (typeof fh.move === 'function') {
    try { await fh.move(parent); files.set(item.id, h); return; } catch {
      if ((await hasEntry(parent, item.name)) && !(await hasEntry(from, item.name))) { files.set(item.id, await parent.getFileHandle(item.name)); return; }
    }
  }
  const out = await parent.getFileHandle(item.name, { create: true });
  const w = await (out as any).createWritable();
  await (await h.getFile()).stream().pipeTo(w);
  await from.removeEntry(item.name);
  files.set(item.id, out);
}
