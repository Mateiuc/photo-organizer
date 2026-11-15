// "Compare pictures": keeps a description of each photo's picture in this browser (and in the backup). The photos
// are looked at by the one read in read/reader.ts. Everything runs on this computer: no photo is sent anywhere.
import { useEffect, useState } from 'react';
import { openDB, type IDBPDatabase } from 'idb';
import type { ImageEmbedder } from '@mediapipe/tasks-vision';
import type { Item } from '../lib/model';
import { idleRun, type ReadRun } from '../read/run';
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
  /** 1: the small picture was made on this computer from a bigger one. Sharpness reads lower than from a ready-made preview. */
  d?: 1;
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
  /** The read in progress (the same one Clean up shows). */
  run: ReadRun;
  v: number;
}
const state: PicturesState = { loaded: false, recs: new Map(), run: idleRun(), v: 0 };
const listeners = new Set<() => void>();
let version = 0;
const notify = () => { state.v = ++version; listeners.forEach((f) => f()); };
/** Counter the backup watches. */
export const picChanges = { n: 0 };
export function subscribePictures(f: () => void): () => void { listeners.add(f); return () => { listeners.delete(f); }; }
/** The reader shows its progress here. */
export function showPicturesRun(run: ReadRun) { state.run = run; notify(); }

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

/**
 * How a photo's small picture was made, for sharpness (see sharpestOf): 1 = on this computer from a bigger one (every
 * file on this computer, and every photo read since the one read), 0 = a ready-made small preview from Google.
 */
export const sharpKind = (it: Item, r?: PicRec) => (r?.d || it.local ? 1 : 0);

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

/** What the reader uses to keep the description of each picture it fetched. */
export interface PicSession {
  /**
   * Describes and keeps one photo; without a picture it is marked as unreadable. `original`: the file's real size,
   * when known. `made`: the picture was made smaller on this computer.
   */
  take(it: Item, bmp: ImageBitmap | undefined, original: { width?: number; height?: number }, made: boolean): Promise<void>;
  /** Saves what is not saved yet. */
  flush(): Promise<void>;
}

/** Starts the comparison's picture model and returns the way to add photos. */
export async function picturesSession(): Promise<PicSession> {
  await load();
  const model = await embedder();
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
  return {
    async take(it, bmp, original, made) {
      let rec: PicRec = { id: it.id, x: 1 };
      if (bmp) {
        try { rec = { id: it.id, ...describe(bmp, model) }; } catch { /* stays marked as unreadable */ }
        if (!rec.x && original.width && !it.width) { rec.pw = original.width; rec.ph = original.height; }
        if (!rec.x && made) rec.d = 1;
      }
      if (it.local) rec.m = it.mtime;
      state.recs.set(it.id, rec);
      pending.push(rec);
      if (pending.length >= 50) await flush();
    },
    flush,
  };
}
