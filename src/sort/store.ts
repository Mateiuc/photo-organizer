// "Clean up": looks at each photo once with the CLIP AI and keeps its fingerprint (512 numbers) in this browser and in
// the backup. From the fingerprints, every photo is put in a group (Documents, Screenshots, People, Food…), and your
// fixes teach it. Everything runs on this computer: no photo is sent anywhere. Nothing here deletes anything.
import { useEffect, useState } from 'react';
import { openDB, type IDBPDatabase } from 'idb';
import { NEEDS_SIGN_IN } from '../drive/api';
import { NO_HELPER, NOT_SIGNED_IN, RELOAD } from '../gphotos/bridge';
import type { Item } from '../lib/model';
import { loadPicture } from '../lib/picture';
import { hasFile } from '../local/fs';
import { quantize } from '../pictures/compare';
import { viaWhatsApp, whatsAppName } from '../lib/model';
import { ready as facesReady } from '../faces/people';
import { CLIP_DIM, CLIP_DTYPE, CLIP_MODEL, FP_VERSION, GROUP_BY_ID, GROUPS, LEARN, makeBank, place, promptList, PROMPTS_VERSION, unitOf, type Bank, type Examples, type Placed } from './groups';

/**
 * What the app keeps about one photo. `x` = the picture couldn't be read; `b` = which backup file holds it; `v` = which
 * AI made the fingerprint (see FP_VERSION; none = the first, compressed one).
 */
export interface SortRec { id: string; k?: Int8Array; x?: 1; m?: number; b?: number; v?: number }
/** A fingerprint made by the AI in use now. Older ones are made again, and not used until then. */
export const fresh = (r?: SortRec): r is SortRec & { k: Int8Array } => !!r?.k && r.v === FP_VERSION;
/** A photo you checked: the group it was in, and whether that was right. */
export interface Check { g: string; ok: boolean; at: number }

const DEMO = new URLSearchParams(location.search).has('demo');
let dbp: Promise<IDBPDatabase> | null = null;
const db = () => (dbp ??= openDB(DEMO ? 'photo-organizer-sort-demo' : 'photo-organizer-sort', 1, {
  upgrade(d) { d.createObjectStore('recs', { keyPath: 'id' }); d.createObjectStore('kv'); },
}));

export interface SortState {
  loaded: boolean;
  recs: Map<string, SortRec>;
  /** Your fixes: photo → group id, oldest first. */
  fixes: Map<string, string>;
  checks: Map<string, Check>;
  /** Photo → group, from the last scoring. */
  placed: Map<string, Placed>;
  /** How many fixes the last scoring learned from. */
  learnedFrom: number;
  /**
   * The fixes as they were when you last pressed "Learn from my fixes". Only these teach the AI, so groups don't shift
   * by themselves after you move or delete photos. (Older data without it: all fixes count, as before.)
   */
  learned: Map<string, string>;
  scoring: boolean;
  run: { running: boolean; done: number; total: number; step?: 'model' | 'sorting'; model?: { loaded: number; total: number }; current?: string; error?: string; startedAt?: number };
  v: number;
}
const state: SortState = { loaded: false, recs: new Map(), fixes: new Map(), checks: new Map(), placed: new Map(), learnedFrom: 0, learned: new Map(), scoring: false, run: { running: false, done: 0, total: 0 }, v: 0 };
const listeners = new Set<() => void>();
let version = 0;
const notify = () => { state.v = ++version; listeners.forEach((f) => f()); };
/** Counters the backup watches: fingerprints made, and fixes or checks. */
export const sortChanges = { n: 0, edits: 0 };
export function subscribeSort(f: () => void): () => void { listeners.add(f); return () => { listeners.delete(f); }; }

let loading: Promise<void> | null = null;
async function load() {
  if (state.loaded) return;
  await (loading ??= (async () => {
    const d = await db();
    const all: SortRec[] = await d.getAll('recs');
    all.forEach((r) => state.recs.set(r.id, r));
    const fx: [string, string][] = (await d.get('kv', 'fixes')) ?? [];
    fx.forEach(([id, g]) => state.fixes.set(id, g));
    const ln: [string, string][] | undefined = await d.get('kv', 'learned');
    state.learned = new Map(ln ?? fx);
    if (!ln) await d.put('kv', fx, 'learned'); // from now on only "Learn from my fixes" adds to it
    const ck: [string, Check][] = (await d.get('kv', 'checks')) ?? [];
    ck.forEach(([id, c]) => state.checks.set(id, c));
    if ((await d.get('kv', 'fp')) !== FP_VERSION) await changedAi(d);
    state.loaded = true;
    notify();
  })());
}
/**
 * The app moved to another AI: your checks counted the old one's answers, so they start again (your fixes stay), and
 * the old AI's files are let go from the browser.
 */
async function changedAi(d: IDBPDatabase) {
  state.checks.clear();
  await d.put('kv', [], 'checks');
  await d.delete('kv', `bank:${CLIP_MODEL}:${PROMPTS_VERSION}`);
  await d.put('kv', FP_VERSION, 'fp');
  sortChanges.edits++;
  try {
    const c = await caches.open('transformers-cache');
    for (const req of await c.keys()) if (req.url.includes(CLIP_MODEL) && /_quantized\.onnx/.test(req.url)) await c.delete(req);
  } catch { /* no cache here: nothing to free */ }
}

export async function sortReady(): Promise<SortState> { await load(); return state; }

export function useSort(): SortState {
  const [, set] = useState(0);
  useEffect(() => {
    const f = () => set(version);
    listeners.add(f);
    load().catch((e) => { state.run.error = String(e?.message ?? e); notify(); });
    return () => { listeners.delete(f); };
  }, []);
  return state;
}

export const sortable = (it: Item) => it.kind === 'photo' || it.kind === 'raw' || it.kind === 'screenshot';
/** Photos the AI still has to look at (screenshots don't need it: the file says what they are). */
export const needsSort = (it: Item, r?: SortRec) => sortable(it) && it.kind !== 'screenshot' && (!r || (!r.x && r.v !== FP_VERSION) || (!!it.local && r.m !== it.mtime));

async function saveKv() {
  const d = await db();
  await d.put('kv', [...state.fixes], 'fixes');
  await d.put('kv', [...state.checks], 'checks');
  sortChanges.edits++;
}

// ---------- the AI, in workers ----------
interface ClipWorker { w: Worker }
let workers: ClipWorker[] = [];
let starting: Promise<ClipWorker[]> | null = null;
let seq = 0;
const base = () => new URL(import.meta.env.BASE_URL, location.href).href;

function call<T>(cw: ClipWorker, msg: Record<string, unknown>, transfer: Transferable[] = []): Promise<T> {
  const id = ++seq;
  return new Promise<T>((resolve, reject) => {
    const off = () => { cw.w.removeEventListener('message', on); cw.w.removeEventListener('error', bad); };
    const on = (e: MessageEvent) => { if (e.data?.id !== id) return; off(); e.data.error ? reject(new Error(e.data.error)) : resolve(e.data as T); };
    // The worker stopped (for example out of memory): forget all workers, so the next run starts fresh.
    const bad = (e: ErrorEvent) => { off(); workers.forEach((x) => x.w.terminate()); workers = []; reject(new Error(e.message || 'The AI stopped')); };
    cw.w.addEventListener('message', on);
    cw.w.addEventListener('error', bad);
    cw.w.postMessage({ ...msg, id }, transfer);
  });
}

function startOne(onProgress?: (file: string, loaded: number, total: number) => void): Promise<ClipWorker> {
  const w = new Worker(new URL('./clip.worker.ts', import.meta.url), { type: 'module' });
  return new Promise((resolve, reject) => {
    const on = (e: MessageEvent) => {
      const m = e.data;
      if (m?.op === 'progress') onProgress?.(m.file, m.loaded, m.total);
      else if (m?.op === 'ready') { w.removeEventListener('message', on); resolve({ w }); }
      else if (m?.op === 'error') { w.removeEventListener('message', on); w.terminate(); reject(new Error(m.message)); }
    };
    w.addEventListener('message', on);
    w.addEventListener('error', (e) => { w.terminate(); reject(new Error(e.message || 'The AI couldn’t start in this browser.')); });
    w.postMessage({ op: 'init', base: base(), model: CLIP_MODEL, dtype: CLIP_DTYPE });
  });
}

/** Starts the AI: one worker first (it downloads the model once), then more from the browser's copy. */
function startWorkers(): Promise<ClipWorker[]> {
  if (workers.length) return Promise.resolve(workers);
  starting ??= (async () => {
    const files = new Map<string, [number, number]>();
    const first = await startOne((file, loaded, total) => {
      files.set(file, [loaded, total]);
      let l = 0, t = 0;
      for (const [a, b] of files.values()) { l += a; t += b; }
      state.run.model = { loaded: l, total: t };
      notify();
    });
    // Each extra worker holds its own copy of the AI (about 350 MB of memory), so only on computers that have room.
    const nav = typeof navigator !== 'undefined' ? (navigator as Navigator & { deviceMemory?: number }) : undefined;
    const cores = nav?.hardwareConcurrency || 2, mem = nav?.deviceMemory ?? 8;
    const extra = Math.min(cores >= 6 ? 2 : cores >= 4 ? 1 : 0, mem >= 8 ? 2 : mem >= 4 ? 1 : 0);
    const more = await Promise.all(Array.from({ length: extra }, () => startOne().catch(() => null)));
    workers = [first, ...more.filter((x): x is ClipWorker => !!x)];
    return workers;
  })().finally(() => { starting = null; });
  return starting;
}

let bank: Bank | null = null;
/** The sentence fingerprints, made once and kept. */
async function getBank(): Promise<Bank> {
  if (bank) return bank;
  const d = await db();
  const key = `bank:${CLIP_MODEL}:${CLIP_DTYPE}:${PROMPTS_VERSION}`;
  const saved: Float32Array | undefined = await d.get('kv', key);
  const prompts = promptList();
  if (saved && saved.length === prompts.length * CLIP_DIM) return (bank = makeBank(saved));
  const [first] = await startWorkers();
  const { emb } = await call<{ emb: Float32Array }>(first, { op: 'text', prompts: prompts.map((p) => p.text) });
  await d.put('kv', emb, key);
  return (bank = makeBank(emb));
}

// ---------- sorting ----------
let stopFlag = false;
export function stopSorting() { stopFlag = true; }
const FATAL = [NO_HELPER, NOT_SIGNED_IN, RELOAD];
/** A photo kept in Google Drive (it needs the Google sign-in, which runs out after about an hour). */
export const inDrive = (it: Item) => !it.local && !it.gp;
const SIZE = 336; // the AI looks at 224 × 224, after the shorter side is made 224

/** A number from a photo's id, the same every time: sorting in this order mixes all years and places. */
function mix(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) { h ^= id.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

/**
 * Looks at every photo not looked at yet. Safe to stop and start again. The photos go in a mixed order (not newest
 * first), so after a few minutes the groups already hold a fair sample of all your photos and can be checked.
 */
export async function sortPhotos(items: Item[]) {
  if (state.run.running) return;
  await load();
  // WhatsApp photos go last: their group comes from the name, so your camera photos are worth sorting first.
  const order = (it: Item) => (whatsAppName(it.name) ? 2 ** 32 : 0) + mix(it.id);
  const todo = items.filter((it) => needsSort(it, state.recs.get(it.id)) && (!it.local || hasFile(it.id))).map((it) => [order(it), it] as const).sort((a, b) => a[0] - b[0]).map(([, it]) => it);
  stopFlag = false;
  state.run = { running: true, done: 0, total: todo.length, step: 'model' };
  notify();
  const d = await db();
  let pending: SortRec[] = [];
  const flush = async () => {
    if (!pending.length) return;
    const batch = pending; pending = [];
    const tx = d.transaction('recs', 'readwrite');
    batch.forEach((r) => tx.store.put(r));
    await tx.done;
    sortChanges.n++;
  };
  try {
    const ws = await startWorkers();
    await getBank();
    state.run.step = 'sorting'; state.run.startedAt = Date.now();
    notify();
    // Pictures are fetched up to 6 at once; each AI worker looks at one at a time.
    type Got = { it: Item; bmp?: ImageBitmap; err?: unknown };
    const queue: Promise<Got>[] = [];
    let next = 0, last = Date.now(), signInLost = false;
    const fill = () => {
      while (queue.length < 6 && next < todo.length && !stopFlag) {
        const it = todo[next++];
        if (signInLost && inDrive(it)) continue; // left for after you sign in again
        queue.push(loadPicture(it, { size: SIZE, fit: 'long', quality: 'high' }).then((bmp) => ({ it, bmp }), (err) => ({ it, err })));
      }
    };
    const one = async (cw: ClipWorker, it: Item, bmp?: ImageBitmap) => {
      let rec: SortRec = { id: it.id, x: 1 };
      if (bmp) {
        try { const { emb } = await call<{ emb: Float32Array }>(cw, { op: 'image', bmp }, [bmp]); rec = { id: it.id, k: quantize(emb), v: FP_VERSION }; } catch (e) {
          if (!workers.length) throw e; // the AI itself stopped, not just this picture
        }
      }
      if (it.local) rec.m = it.mtime;
      state.recs.set(it.id, rec);
      pending.push(rec);
      state.run.done++;
      state.run.current = it.name;
      if (pending.length >= 50) await flush();
      if (Date.now() - last > 700) { last = Date.now(); notify(); }
    };
    fill();
    const running = new Set<Promise<void>>();
    const idle = [...ws];
    let wake: (() => void) | null = null;
    let failed: unknown;
    // When the Google sign-in runs out, the Drive photos wait and the others carry on.
    while (queue.length) {
      const { it, bmp, err } = await queue.shift()!;
      if (stopFlag || failed) { bmp?.close(); continue; }
      fill();
      if (err && (err as Error).message === NEEDS_SIGN_IN) { signInLost = true; continue; }
      if (err && FATAL.includes((err as Error).message)) throw err; // nothing can be read: stop
      while (!idle.length) await new Promise<void>((r) => { wake = r; });
      const cw = idle.shift()!;
      const p: Promise<void> = one(cw, it, bmp)
        .catch((e) => { failed ??= e; })
        .finally(() => { idle.push(cw); running.delete(p); const w = wake; wake = null; w?.(); });
      running.add(p);
    }
    await Promise.all(running);
    if (failed) throw failed;
    if (signInLost) state.run.error = NEEDS_SIGN_IN;
  } catch (e) {
    state.run.error = (e as Error).message || String(e);
  } finally {
    await flush().catch(() => {});
    state.run.running = false; state.run.current = undefined; state.run.step = undefined;
    notify();
  }
}

/** Lets the photos that couldn't be read be tried again. */
export async function retryUnreadable() {
  const failed = [...state.recs.values()].filter((r) => r.x);
  const tx = (await db()).transaction('recs', 'readwrite');
  for (const r of failed) { state.recs.delete(r.id); tx.store.delete(r.id); }
  await tx.done;
  notify();
}

// ---------- groups ----------
let scorer: Worker | null = null;
let scoreSeq = 0;
/** Puts every photo in a group: the AI's scores (with your fixes as examples), then the sure signals. */
export async function placeAll(items: Item[], pathOf: (folderId?: string) => string = () => '', learn = false) {
  await load();
  if (learn) {
    state.learned = new Map(state.fixes);
    await (await db()).put('kv', [...state.learned], 'learned');
  }
  const withK = items.filter((it) => sortable(it) && fresh(state.recs.get(it.id)));
  if (!withK.length && !state.fixes.size && !items.some((it) => it.kind === 'screenshot' || viaWhatsApp(it, pathOf))) { state.placed = new Map(); notify(); return; }
  state.scoring = true; notify();
  try {
    const b = withK.length ? await getBank() : null;
    const k = new Int8Array(withK.length * CLIP_DIM);
    withK.forEach((it, i) => k.set(state.recs.get(it.id)!.k!, i * CLIP_DIM));
    // your newest fixes that it was asked to learn from, as examples
    const fixes = [...state.fixes].filter(([id, g]) => state.learned.get(id) === g && fresh(state.recs.get(id))).slice(-LEARN.maxExamples);
    const ex: Examples = { emb: new Float32Array(fixes.length * CLIP_DIM), group: new Uint8Array(fixes.length), n: fixes.length };
    fixes.forEach(([id, g], i) => { ex.emb.set(unitOf(state.recs.get(id)!.k!), i * CLIP_DIM); ex.group[i] = GROUP_BY_ID.get(g) ?? 0; });
    let ai: { g: Uint8Array; p: Float32Array } = { g: new Uint8Array(0), p: new Float32Array(0) };
    if (b && withK.length) {
      scorer ??= new Worker(new URL('./score.worker.ts', import.meta.url), { type: 'module' });
      const id = ++scoreSeq;
      ai = await new Promise((resolve, reject) => {
        const w = scorer!;
        const on = (e: MessageEvent) => { if (e.data?.id !== id) return; w.removeEventListener('message', on); w.removeEventListener('error', bad); resolve(e.data); };
        const bad = (e: ErrorEvent) => { w.removeEventListener('message', on); w.removeEventListener('error', bad); scorer?.terminate(); scorer = null; reject(new Error(e.message || 'Sorting stopped')); };
        w.addEventListener('message', on);
        w.addEventListener('error', bad);
        w.postMessage({ id, k, n: withK.length, bank: b, ex: ex.n ? ex : undefined }, [k.buffer]);
      });
    }
    const faces = new Set([...(await facesReady()).faces.values()].map((f) => f.itemId));
    const at = new Map(withK.map((it, i) => [it.id, i]));
    const placed = new Map<string, Placed>();
    for (const it of items) {
      if (!sortable(it)) continue;
      const i = at.get(it.id);
      const fix = state.fixes.get(it.id);
      const r = place(i != null ? { g: ai.g[i], p: ai.p[i] } : undefined, { fix: fix != null ? GROUP_BY_ID.get(fix) : undefined, whatsapp: !!viaWhatsApp(it, pathOf), screenshot: it.kind === 'screenshot', face: faces.has(it.id) });
      if (r) placed.set(it.id, r);
    }
    state.placed = placed;
    state.learnedFrom = fixes.length;
  } catch (e) {
    state.run.error = (e as Error).message || String(e);
  } finally {
    state.scoring = false;
    notify();
  }
}

/** Fixes made (or changed) since you last pressed "Learn from my fixes". */
export const newFixCount = (s: SortState) => { let n = 0; for (const [id, g] of s.fixes) if (s.learned.get(id) !== g) n++; return n; };

/** You put a photo in another group. It stays there; "Learn from my fixes" uses it for similar photos. */
export const fixGroup = (id: string, g: string) => fixGroups([id], g);

/** You put many photos in another group at once (ticked ones). Like fixGroup for each. */
export async function fixGroups(ids: readonly string[], g: string) {
  await load();
  const gi = GROUP_BY_ID.get(g);
  for (const id of ids) {
    state.fixes.delete(id);
    state.fixes.set(id, g);
    if (gi != null) state.placed.set(id, { g: gi, p: 1, why: 'you' });
  }
  await saveKv();
  notify();
}

/** You checked a photo: right (it stays) or wrong (you picked the right group, which becomes a fix). */
export async function checkPhoto(id: string, shown: string, right: string) {
  await load();
  state.checks.set(id, { g: shown, ok: shown === right, at: Date.now() });
  if (shown !== right) { state.fixes.delete(id); state.fixes.set(id, right); const gi = GROUP_BY_ID.get(right); if (gi != null) state.placed.set(id, { g: gi, p: 1, why: 'you' }); }
  await saveKv();
  notify();
}

/** Forgets your checks (to measure again after learning). Fixes stay. */
export async function clearChecks() {
  await load();
  state.checks.clear();
  await saveKv();
  notify();
}

export const groupName = (id: string) => GROUPS[GROUP_BY_ID.get(id) ?? 0]?.name ?? id;

// ---------- backup ----------
export async function markSortBackedUp(ids: Iterable<string>, n: number | undefined) {
  const tx = (await db()).transaction('recs', 'readwrite');
  for (const id of ids) { const r = state.recs.get(id); if (r && r.b !== n) { const nr = { ...r, b: n }; state.recs.set(id, nr); tx.store.put(nr); } }
  await tx.done;
}

/** Replaces everything with a backup's contents. */
export async function replaceAllSort(recs: SortRec[], fixes: [string, string][], checks: [string, Check][]) {
  const d = await db();
  const tx = d.transaction('recs', 'readwrite');
  await tx.store.clear();
  for (const r of recs) tx.store.put(r);
  await tx.done;
  state.recs.clear();
  recs.forEach((r) => state.recs.set(r.id, r));
  state.fixes = new Map(fixes);
  state.learned = new Map(fixes); // a backup's fixes count as learned, as they did before
  state.checks = new Map(checks);
  await d.put('kv', fixes, 'learned');
  await d.put('kv', fixes, 'fixes');
  await d.put('kv', checks, 'checks');
  state.loaded = true;
  notify();
}
