// "Compare pictures": looks at each photo once and keeps a description of its picture in this browser (and in the
// backup). Everything runs on this computer: no photo is sent anywhere.
import { useEffect, useState } from 'react';
import { openDB, type IDBPDatabase } from 'idb';
import type { ImageEmbedder } from '@mediapipe/tasks-vision';
import { NEEDS_SIGN_IN } from '../drive/api';
import { NO_HELPER, NOT_SIGNED_IN, RELOAD } from '../gphotos/bridge';
import type { Item } from '../lib/model';
import { loadPicture } from '../lib/picture';
import { hasFile } from '../local/fs';
import { colour, flatness, greyGrid, hashes, quantize, sharpness } from './compare';

/** What the app keeps about one photo's picture. `x` = the picture couldn't be read; `b` = which backup file holds it. */
export interface PicRec {
  id: string;
  h?: Uint32Array; // hashes, picture turned 0°, 90°, 180°, 270°
  g?: Uint8Array; // 32×32 grey sketch
  e?: Int8Array; // AI fingerprint
  sh?: number; // sharpness
  fl?: number; // plainness
  ar?: number; // width / height
  c?: number[]; // average colour and saturation
  m?: number; // files on this computer: last-modified time when looked at
  pw?: number; // the photo's real width and height, when the whole file was read
  ph?: number;
  x?: 1;
  b?: number;
}

const DEMO = new URLSearchParams(location.search).has('demo');
let dbp: Promise<IDBPDatabase> | null = null;
const db = () => (dbp ??= openDB(DEMO ? 'photo-organizer-pictures-demo' : 'photo-organizer-pictures', 1, {
  upgrade(d) { d.createObjectStore('pics', { keyPath: 'id' }); },
}));

export interface PicturesState {
  loaded: boolean;
  recs: Map<string, PicRec>;
  run: { running: boolean; done: number; total: number; current?: string; error?: string };
  v: number;
}
const state: PicturesState = { loaded: false, recs: new Map(), run: { running: false, done: 0, total: 0 }, v: 0 };
const listeners = new Set<() => void>();
let version = 0;
const notify = () => { state.v = ++version; listeners.forEach((f) => f()); };
/** Counter the backup watches. */
export const picChanges = { n: 0 };
export function subscribePictures(f: () => void): () => void { listeners.add(f); return () => { listeners.delete(f); }; }

let loading: Promise<void> | null = null;
async function load() {
  if (state.loaded) return;
  await (loading ??= (async () => {
    const all: PicRec[] = await (await db()).getAll('pics');
    all.forEach((r) => state.recs.set(r.id, r));
    state.loaded = true;
    notify();
  })());
}
export async function picturesReady(): Promise<PicturesState> { await load(); return state; }

export function usePictures(): PicturesState {
  const [, set] = useState(0);
  useEffect(() => {
    const f = () => set(version);
    listeners.add(f);
    load().catch((e) => { state.run.error = String(e?.message ?? e); notify(); });
    return () => { listeners.delete(f); };
  }, []);
  return state;
}

export const comparable = (it: Item) => it.kind === 'photo' || it.kind === 'raw' || it.kind === 'screenshot';
/** Photos not looked at yet, or changed since (files on this computer). */
export const needsLook = (it: Item, r?: PicRec) => comparable(it) && (!r || (!!it.local && r.m !== it.mtime));

/** Remembers that these pictures are now in backup file number `n` (or in none, with undefined). */
export async function markPicsBackedUp(ids: Iterable<string>, n: number | undefined) {
  const tx = (await db()).transaction('pics', 'readwrite');
  for (const id of ids) { const r = state.recs.get(id); if (r && r.b !== n) { const nr = { ...r, b: n }; state.recs.set(id, nr); tx.store.put(nr); } }
  await tx.done;
}

/** Replaces everything with a backup's contents. */
export async function replaceAllPics(recs: PicRec[]) {
  const tx = (await db()).transaction('pics', 'readwrite');
  await tx.store.clear();
  for (const r of recs) tx.store.put(r);
  await tx.done;
  state.recs.clear();
  recs.forEach((r) => state.recs.set(r.id, r));
  state.loaded = true;
  notify();
}

/** Lets the photos that couldn't be read be tried again. */
export async function retryFailed() {
  const failed = [...state.recs.values()].filter((r) => r.x);
  const tx = (await db()).transaction('pics', 'readwrite');
  for (const r of failed) { state.recs.delete(r.id); tx.store.delete(r.id); }
  await tx.done;
  notify();
}

// ---------- the AI picture model (Google's MediaPipe, MobileNet V3) ----------
let embP: Promise<ImageEmbedder> | null = null;
function embedder(): Promise<ImageEmbedder> {
  embP ??= (async () => {
    const { FilesetResolver, ImageEmbedder } = await import('@mediapipe/tasks-vision');
    const base = new URL(import.meta.env.BASE_URL, location.href).href;
    const files = await FilesetResolver.forVisionTasks(base + 'mediapipe');
    return ImageEmbedder.createFromOptions(files, { baseOptions: { modelAssetPath: base + 'models/mobilenet_v3_large.tflite', delegate: 'CPU' }, l2Normalize: true, runningMode: 'IMAGE' });
  })();
  embP.catch(() => { embP = null; });
  return embP;
}

const SIZE = 256;
let canvas: HTMLCanvasElement | null = null;
/** Describes one picture. */
function describe(bmp: ImageBitmap, model: ImageEmbedder): Omit<PicRec, 'id'> {
  canvas ??= document.createElement('canvas');
  const w = bmp.width, h = bmp.height;
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(bmp, 0, 0);
  const px = ctx.getImageData(0, 0, w, h).data;
  const g = greyGrid(px, w, h);
  const e = model.embed(canvas).embeddings[0]?.floatEmbedding;
  if (!e) throw new Error('no fingerprint');
  return { h: hashes(g), g, e: quantize(e), sh: Math.round(sharpness(px, w, h)), fl: Math.round(flatness(g) * 10) / 10, ar: Math.round((w / h) * 1000) / 1000, c: colour(px, w, h) };
}

let stopFlag = false;
export function stopComparing() { stopFlag = true; }
const FATAL = [NEEDS_SIGN_IN, NO_HELPER, NOT_SIGNED_IN, RELOAD];

/** Looks at every photo not looked at yet, newest first. Safe to stop and start again. */
export async function comparePictures(items: Item[]) {
  if (state.run.running) return;
  await load();
  // Files on this computer can only be read once their folder is open in this visit.
  const todo = items.filter((it) => needsLook(it, state.recs.get(it.id)) && (!it.local || hasFile(it.id))).sort((a, b) => (b.takenAt ?? '').localeCompare(a.takenAt ?? ''));
  stopFlag = false;
  state.run = { running: true, done: 0, total: todo.length };
  notify();
  const d = await db();
  let pending: PicRec[] = [];
  const flush = async () => {
    if (!pending.length) return;
    const batch = pending; pending = [];
    const tx = d.transaction('pics', 'readwrite');
    batch.forEach((r) => tx.store.put(r));
    await tx.done;
    picChanges.n++;
  };
  try {
    const model = await embedder();
    // Up to 6 pictures are fetched at once while the ones already here are looked at.
    type Got = { it: Item; bmp?: ImageBitmap; err?: unknown; size: { width?: number; height?: number } };
    const queue: Promise<Got>[] = [];
    let next = 0, last = Date.now();
    const fill = () => {
      while (queue.length < 6 && next < todo.length && !stopFlag) {
        const it = todo[next++];
        const size = {};
        queue.push(loadPicture(it, { size: SIZE, fit: 'long', quality: 'high' }, size).then((bmp) => ({ it, bmp, size }), (err) => ({ it, err, size })));
      }
    };
    fill();
    while (queue.length) {
      const { it, bmp, err, size } = await queue.shift()!;
      if (stopFlag) { bmp?.close(); continue; }
      fill();
      if (err && FATAL.includes((err as Error).message)) throw err; // nothing can be read: stop
      let rec: PicRec = { id: it.id, x: 1 };
      if (bmp) {
        try { rec = { id: it.id, ...describe(bmp, model) }; } catch { /* stays marked as unreadable */ }
        if (!rec.x && size.width && !it.width) { rec.pw = size.width; rec.ph = size.height; }
        bmp.close();
      }
      if (it.local) rec.m = it.mtime;
      state.recs.set(it.id, rec);
      pending.push(rec);
      state.run.done++;
      state.run.current = it.name;
      if (pending.length >= 50) await flush();
      if (Date.now() - last > 700) { last = Date.now(); notify(); }
    }
  } catch (e) {
    state.run.error = (e as Error).message || String(e);
  } finally {
    await flush().catch(() => {});
    state.run.running = false; state.run.current = undefined;
    notify();
  }
}
