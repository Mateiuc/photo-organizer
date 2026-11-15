// "Clean up": keeps each photo's SigLIP 2 AI fingerprint (768 numbers) in this browser and in the backup. The photos
// are looked at by the one read in read/reader.ts. From the fingerprints, every photo is put in a group (Documents, Screenshots, People, Food…), and your
// fixes teach it. Everything runs on this computer: no photo is sent anywhere. Nothing here deletes anything.
import { useEffect, useState } from 'react';
import { openDB, type IDBPDatabase } from 'idb';
import type { Item } from '../lib/model';
import { idleRun, type ReadRun } from '../read/run';
import { quantize } from '../pictures/compare';
import { viaWhatsApp, whatsAppName } from '../lib/model';
import { ready as facesReady } from '../faces/people';
import { AI_DIM, AI_DTYPE, AI_MODEL, AI_REVISION, FP_VERSION, GROUP_BY_ID, GROUPS, LEARN, makeBank, place, OLD_AI_MODEL, promptList, PROMPTS_VERSION, scoreAll, unitOf, type Bank, type Examples, type Placed } from './groups';
import { keepSigns, makeTagBank, tagAll, TAGS_VERSION, tagSentences, type TagBank } from './tags';

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
  /** Photo → what else is in it (see sort/tags.ts: one bit per tag), from the last scoring. */
  tags: Map<string, number>;
  /** How many fixes the last scoring learned from. */
  learnedFrom: number;
  /**
   * The fixes as they were when you last pressed "Learn from my fixes". Only these teach the AI, so groups don't shift
   * by themselves after you move or delete photos. (Older data without it: all fixes count, as before.)
   */
  learned: Map<string, string>;
  scoring: boolean;
  /** The read in progress (the same one Duplicates shows). */
  run: ReadRun;
  v: number;
}
const state: SortState = { loaded: false, recs: new Map(), fixes: new Map(), checks: new Map(), placed: new Map(), tags: new Map(), learnedFrom: 0, learned: new Map(), scoring: false, run: idleRun(), v: 0 };
const listeners = new Set<() => void>();
let version = 0;
const notify = () => { state.v = ++version; listeners.forEach((f) => f()); };
/** Counters the backup watches: fingerprints made, and fixes or checks. */
export const sortChanges = { n: 0, edits: 0 };
export function subscribeSort(f: () => void): () => void { listeners.add(f); return () => { listeners.delete(f); }; }
/** The reader shows its progress here. */
export function showSortRun(run: ReadRun) { state.run = run; notify(); }

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
  await d.put('kv', FP_VERSION, 'fp');
  sortChanges.edits++;
  try {
    for (const key of await d.getAllKeys('kv')) if (typeof key === 'string' && key.startsWith('bank:')) await d.delete('kv', key);
    const c = await caches.open('transformers-cache');
    for (const req of await c.keys()) if (req.url.includes(OLD_AI_MODEL)) await c.delete(req);
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
  const w = new Worker(new URL('./ai.worker.ts', import.meta.url), { type: 'module' });
  return new Promise((resolve, reject) => {
    const on = (e: MessageEvent) => {
      const m = e.data;
      if (m?.op === 'progress') onProgress?.(m.file, m.loaded, m.total);
      else if (m?.op === 'ready') { w.removeEventListener('message', on); resolve({ w }); }
      else if (m?.op === 'error') { w.removeEventListener('message', on); w.terminate(); reject(new Error(m.message)); }
    };
    w.addEventListener('message', on);
    w.addEventListener('error', (e) => { w.terminate(); reject(new Error(e.message || 'The AI couldn’t start in this browser.')); });
    w.postMessage({ op: 'init', base: base(), model: AI_MODEL, revision: AI_REVISION, dtype: AI_DTYPE });
  });
}

/** Starts the AI: one worker first (it downloads the model once), then more from the browser's copy. */
function startWorkers(onModel?: (loaded: number, total: number) => void): Promise<ClipWorker[]> {
  if (workers.length) return Promise.resolve(workers);
  starting ??= (async () => {
    const files = new Map<string, [number, number]>();
    const first = await startOne((file, loaded, total) => {
      files.set(file, [loaded, total]);
      let l = 0, t = 0;
      for (const [a, b] of files.values()) { l += a; t += b; }
      onModel?.(l, t);
    });
    // Each extra worker holds its own copy of the AI (about 400 MB of memory), so only on computers that have room.
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
/** The sentence fingerprints. They come with the app, made ahead with the full-size AI (see scripts/sentences.mjs). */
async function getBank(): Promise<Bank> {
  if (bank) return bank;
  const res = await fetch(`${base()}ai/sentences-${PROMPTS_VERSION}.bin`);
  if (!res.ok) throw new Error('The app couldn’t load its group sentences. Reload the page.');
  const emb = new Float32Array(await res.arrayBuffer());
  if (emb.length !== promptList().length * AI_DIM) throw new Error('The app’s group sentences don’t match this version. Reload the page.');
  return (bank = makeBank(emb));
}

let tagBank: TagBank | null = null;
/** The tag sentence fingerprints, which come with the app the same way. */
async function getTagBank(): Promise<TagBank> {
  if (tagBank) return tagBank;
  const res = await fetch(`${base()}ai/tags-${TAGS_VERSION}.bin`);
  if (!res.ok) throw new Error('The app couldn’t load its tag sentences. Reload the page.');
  const emb = new Float32Array(await res.arrayBuffer());
  if (emb.length !== tagSentences().length * AI_DIM) throw new Error('The app’s tag sentences don’t match this version. Reload the page.');
  return (tagBank = makeTagBank(emb));
}

// ---------- sorting ----------
/** A photo kept in Google Drive (it needs the Google sign-in, which runs out after about an hour). */
export const inDrive = (it: Item) => !it.local && !it.gp;

/** A number from a photo's id, the same every time: sorting in this order mixes all years and places. */
function mix(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) { h ^= id.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
/**
 * The order photos are sorted in: mixed (not newest first), so after a few minutes the groups already hold a fair
 * sample of all your photos and can be checked. WhatsApp photos go last: their group comes from the name, so your
 * camera photos are worth sorting first.
 */
export const sortOrder = (it: Item) => (whatsAppName(it.name) ? 2 ** 32 : 0) + mix(it.id);

/** What the reader uses to keep the AI fingerprint of each picture it fetched. */
export interface SortSession {
  /** The AI's workers: each looks at one picture at a time. */
  workers: readonly unknown[];
  /**
   * One worker looks at one photo and its fingerprint is kept; without a picture the photo is marked as unreadable.
   * Throws only when the AI itself stopped. The picture is handed over (no need to close it).
   */
  take(worker: unknown, it: Item, bmp: ImageBitmap | undefined): Promise<void>;
  /** Saves what is not saved yet. */
  flush(): Promise<void>;
}

/** Starts the AI (the first time it is downloaded; `onModel` gets the progress in bytes) and returns the way to add photos. */
export async function sortSession(onModel?: (loaded: number, total: number) => void): Promise<SortSession> {
  await load();
  const ws = await startWorkers(onModel);
  await getBank();
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
  return {
    workers: ws,
    async take(worker, it, bmp) {
      let rec: SortRec = { id: it.id, x: 1 };
      if (bmp) {
        try { const { emb } = await call<{ emb: Float32Array }>(worker as ClipWorker, { op: 'image', bmp }, [bmp]); rec = { id: it.id, k: quantize(emb), v: FP_VERSION }; } catch (e) {
          if (!workers.length) throw e; // the AI itself stopped, not just this picture
        }
      }
      if (it.local) rec.m = it.mtime;
      state.recs.set(it.id, rec);
      pending.push(rec);
      if (pending.length >= 50) await flush();
    },
    flush,
  };
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
/** Your newest fixes that it was asked to learn from, as examples. */
function learnedExamples(): Examples {
  const fixes = [...state.fixes].filter(([id, g]) => state.learned.get(id) === g && fresh(state.recs.get(id))).slice(-LEARN.maxExamples);
  const ex: Examples = { emb: new Float32Array(fixes.length * AI_DIM), group: new Uint8Array(fixes.length), n: fixes.length };
  fixes.forEach(([id, g], i) => { ex.emb.set(unitOf(state.recs.get(id)!.k!), i * AI_DIM); ex.group[i] = GROUP_BY_ID.get(g) ?? 0; });
  return ex;
}

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
    const k = new Int8Array(withK.length * AI_DIM);
    withK.forEach((it, i) => k.set(state.recs.get(it.id)!.k!, i * AI_DIM));
    const tb = withK.length ? await getTagBank() : null;
    const ex = learnedExamples();
    let ai: { g: Uint8Array; p: Float32Array; probs: Float32Array; tags: Uint32Array } = { g: new Uint8Array(0), p: new Float32Array(0), probs: new Float32Array(0), tags: new Uint32Array(0) };
    if (b && withK.length) {
      scorer ??= new Worker(new URL('./score.worker.ts', import.meta.url), { type: 'module' });
      const id = ++scoreSeq;
      ai = await new Promise((resolve, reject) => {
        const w = scorer!;
        const on = (e: MessageEvent) => { if (e.data?.id !== id) return; w.removeEventListener('message', on); w.removeEventListener('error', bad); resolve(e.data); };
        const bad = (e: ErrorEvent) => { w.removeEventListener('message', on); w.removeEventListener('error', bad); scorer?.terminate(); scorer = null; reject(new Error(e.message || 'Sorting stopped')); };
        w.addEventListener('message', on);
        w.addEventListener('error', bad);
        w.postMessage({ id, k, n: withK.length, bank: b, ex: ex.n ? ex : undefined, tagBank: tb ?? undefined }, [k.buffer]);
      });
    }
    const faces = new Set([...(await facesReady()).faces.values()].map((f) => f.itemId));
    const at = new Map(withK.map((it, i) => [it.id, i]));
    const placed = new Map<string, Placed>();
    const tags = new Map<string, number>();
    withK.forEach((it, i) => tags.set(it.id, ai.tags[i] ?? 0));
    for (const it of items) {
      if (!sortable(it) && !(it.kind === 'video' && viaWhatsApp(it, pathOf))) continue; // WhatsApp videos join the WhatsApp group
      const i = at.get(it.id);
      const fix = state.fixes.get(it.id);
      const G = GROUPS.length;
      const r = place(i != null ? { g: ai.g[i], p: ai.p[i], probs: ai.probs.subarray(i * G, (i + 1) * G) } : undefined,
        { fix: fix != null ? GROUP_BY_ID.get(fix) : undefined, whatsapp: !!viaWhatsApp(it, pathOf), screenshot: it.kind === 'screenshot', face: faces.has(it.id), camera: !!it.camera || it.lat != null, keepSign: i != null && keepSigns(ai.tags[i]).length > 0 });
      if (r) placed.set(it.id, r);
    }
    state.placed = placed;
    state.tags = tags;
    state.learnedFrom = ex.n;
  } catch (e) {
    state.run.error = (e as Error).message || String(e);
  } finally {
    state.scoring = false;
    notify();
  }
}

/**
 * The group and the tags of one photo, for its info card: from the last scoring when there is one, else worked out
 * now for this photo alone (the same way, so both always agree).
 */
export async function knownAbout(it: Item, pathOf: (folderId?: string) => string = () => ''): Promise<{ placed?: Placed; tags: number }> {
  await load();
  const rec = state.recs.get(it.id);
  const k = fresh(rec) ? rec.k : undefined;
  let placed = state.placed.get(it.id), tags = state.tags.get(it.id);
  if (tags == null) tags = k ? tagAll(k, 1, await getTagBank())[0] : 0;
  if (!placed && (sortable(it) || (it.kind === 'video' && viaWhatsApp(it, pathOf)))) {
    const fix = state.fixes.get(it.id);
    const ex = k ? learnedExamples() : undefined;
    const ai = k ? scoreAll(k, 1, await getBank(), ex?.n ? ex : undefined) : undefined;
    const faces = (await facesReady()).faces;
    let face = false;
    for (const f of faces.values()) if (f.itemId === it.id) { face = true; break; }
    placed = place(ai ? { g: ai.g[0], p: ai.p[0], probs: ai.probs } : undefined,
      { fix: fix != null ? GROUP_BY_ID.get(fix) : undefined, whatsapp: !!viaWhatsApp(it, pathOf), screenshot: it.kind === 'screenshot', face, camera: !!it.camera || it.lat != null, keepSign: keepSigns(tags).length > 0 });
  }
  return { placed, tags };
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
