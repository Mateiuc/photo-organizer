// Finds faces in the photos and keeps the people the app has learned, in this browser.
// Everything runs on this computer: no photo or face is sent anywhere.
import { useEffect, useState } from 'react';
import { openDB, type IDBPDatabase } from 'idb';
import { NEEDS_SIGN_IN } from '../drive/api';
import type { Item } from '../lib/model';
import { loadPicture, previews } from '../lib/picture';
import { NO_HELPER, NOT_SIGNED_IN, RELOAD } from '../gphotos/bridge';
import { assign, merge as mergePeople, useLimits, without, type Face, type Person } from './cluster';
import { carryOver, previewCarry, type Carried } from './carry';
import { ADA } from './ada';
import type { WorkerFace } from './ada.worker';

const DEMO = new URLSearchParams(location.search).has('demo');
let dbp: Promise<IDBPDatabase> | null = null;
const db = () => (dbp ??= openDB(DEMO ? 'photo-organizer-faces-demo' : 'photo-organizer-faces', 2, {
  upgrade(d, old) {
    if (old < 1) {
      d.createObjectStore('scanned'); // itemId → number of faces found
      d.createObjectStore('faces', { keyPath: 'key' });
      d.createObjectStore('people', { keyPath: 'id' });
    }
    if (old < 2) {
      // Moving to the stronger face AI: every photo is read again into these, while the faces above stay in use.
      d.createObjectStore('scanned2');
      d.createObjectStore('faces2', { keyPath: 'key' });
    }
  },
}));

// ---------- in-memory state, shared by every view ----------
export interface PeopleState {
  loaded: boolean;
  people: Map<string, Person>;
  faces: Map<string, StoredFace>;
  scanned: Set<string>;
  run: { running: boolean; done: number; total: number; current?: string; error?: string; slow?: boolean; upgrade?: boolean; loading?: string; device?: string };
  /** The faces in use were found by the older face-api, so the stronger face AI can read the photos again. */
  old: boolean;
  /** Reading the photos again with the stronger face AI: faces found so far (with the backup file holding each), and photos done. */
  next: { faces: Map<string, Face & { b?: number }>; scanned: Set<string> };
  /** Goes up on every change, so views know to recompute. */
  v: number;
}
/** A face as kept in this browser: who it belongs to, and which backup file holds it (if any yet). */
export type StoredFace = Face & { person: string; b?: number };
const state: PeopleState = { loaded: false, people: new Map(), faces: new Map(), scanned: new Set(), run: { running: false, done: 0, total: 0 }, old: false, next: { faces: new Map(), scanned: new Set() }, v: 0 };
/** Which face AI the faces in use came from (a face without `m` is face-api's), and its limits. */
function settle() {
  state.old = [...state.faces.values()].some((f) => f.m !== ADA);
  useLimits(state.old ? 128 : 512);
}
const listeners = new Set<() => void>();
let version = 0;
const notify = () => { state.v = ++version; listeners.forEach((f) => f()); };

/** Counters the backup watches: hand-made edits (names, joins), faces found, and "start over". */
export const changes = { edits: 0, faces: 0, resets: 0 };
export function subscribe(f: () => void): () => void { listeners.add(f); return () => { listeners.delete(f); }; }
/** The people state, once it's loaded from this browser. */
export async function ready(): Promise<PeopleState> { await load(); return state; }

async function load() {
  if (state.loaded) return;
  const d = await db();
  const [people, faces, keys, faces2, keys2] = await Promise.all([d.getAll('people'), d.getAll('faces'), d.getAllKeys('scanned'), d.getAll('faces2'), d.getAllKeys('scanned2')]);
  people.forEach((p: Person) => state.people.set(p.id, p));
  faces.forEach((f) => state.faces.set(f.key, f));
  keys.forEach((k) => state.scanned.add(String(k)));
  faces2.forEach((f) => state.next.faces.set(f.key, f));
  keys2.forEach((k) => state.next.scanned.add(String(k)));
  settle();
  state.loaded = true;
  notify();
}

/** Re-renders when people or the face search change. */
export function usePeople(): PeopleState {
  const [, set] = useState(0);
  useEffect(() => {
    const f = () => set(version);
    listeners.add(f);
    load().catch((e) => { state.run.error = String(e?.message ?? e); notify(); });
    return () => { listeners.delete(f); };
  }, []);
  return state;
}

/** Names of the people in each photo, for search. */
export function namesByItem(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const f of state.faces.values()) {
    const name = state.people.get(f.person)?.name;
    if (!name) continue;
    const a = out.get(f.itemId);
    a ? a.includes(name) || a.push(name) : out.set(f.itemId, [name]);
  }
  return out;
}

// ---------- editing people ----------
/** Each edit returns a way to take it back (for "Undo"). */
export type Undo = () => Promise<void>;
const noUndo: Undo = async () => {};

export async function rename(id: string, name: string): Promise<Undo> {
  const p = state.people.get(id);
  if (!p) return noUndo;
  const np = { ...p, name: name.trim() || undefined };
  state.people.set(id, np);
  await (await db()).put('people', np);
  changes.edits++;
  notify();
  return async () => { if (state.people.has(id)) { state.people.set(id, p); await (await db()).put('people', p); changes.edits++; notify(); } };
}

/** Joins person `fromId` into `intoId` (they're the same person). */
export async function mergeInto(fromId: string, intoId: string): Promise<Undo> {
  const from = state.people.get(fromId), into = state.people.get(intoId);
  if (!from || !into || from === into) return noUndo;
  const np = mergePeople(from, into);
  const keys: string[] = [];
  for (const f of state.faces.values()) if (f.person === fromId) keys.push(f.key);
  await save([np], [fromId], keys, intoId);
  return async () => {
    // put both people back as they were, and give the moved faces back
    const now = state.people.get(intoId);
    if (!now) return;
    await save([from, { ...into, name: now.name === np.name ? into.name : now.name }], [], keys, fromId);
  };
}

async function save(put: Person[], del: string[], faceKeys: string[], faceOwner: string) {
  const d = await db();
  const tx = d.transaction(['people', 'faces'], 'readwrite');
  for (const k of faceKeys) { const f = state.faces.get(k); if (f) { const nf = { ...f, person: faceOwner }; state.faces.set(k, nf); tx.objectStore('faces').put(nf); } }
  for (const p of put) { state.people.set(p.id, p); tx.objectStore('people').put(p); }
  for (const id of del) { state.people.delete(id); tx.objectStore('people').delete(id); }
  await tx.done;
  changes.edits++;
  notify();
}

/**
 * Joins many unnamed people into one named person at once ("Yes, these are Nick"), and remembers the faces you left
 * unticked as "not them", so they aren't suggested for that person again. One Undo takes it all back.
 */
export async function mergeMany(fromIds: string[], intoId: string, notThem: string[] = []): Promise<Undo> {
  const into = state.people.get(intoId);
  if (!into) return noUndo;
  const froms = fromIds.map((id) => state.people.get(id)).filter((p): p is Person => !!p && p.id !== intoId);
  if (!froms.length && !notThem.length) return noUndo;
  let np: Person = into;
  for (const f of froms) np = mergePeople(f, np);
  if (notThem.length) np = { ...np, no: [...new Set([...(into.no ?? []), ...notThem])].slice(-5000) };
  const owners = new Set(froms.map((f) => f.id));
  const moved: [string, string][] = []; // face key, owner before
  for (const f of state.faces.values()) if (owners.has(f.person)) moved.push([f.key, f.person]);
  const d = await db();
  const tx = d.transaction(['people', 'faces'], 'readwrite');
  for (const [k] of moved) { const nf = { ...state.faces.get(k)!, person: intoId }; state.faces.set(k, nf); tx.objectStore('faces').put(nf); }
  state.people.set(intoId, np); tx.objectStore('people').put(np);
  for (const f of froms) { state.people.delete(f.id); tx.objectStore('people').delete(f.id); }
  await tx.done;
  changes.edits++;
  notify();
  return async () => {
    const now = state.people.get(intoId);
    if (!now) return;
    const back = { ...into, name: now.name === np.name ? into.name : now.name };
    const tx = (await db()).transaction(['people', 'faces'], 'readwrite');
    for (const [k, owner] of moved) { const f = state.faces.get(k); if (f) { const nf = { ...f, person: owner }; state.faces.set(k, nf); tx.objectStore('faces').put(nf); } }
    for (const p of [back, ...froms]) { state.people.set(p.id, p); tx.objectStore('people').put(p); }
    await tx.done;
    changes.edits++;
    notify();
  };
}

/** Sets a face aside as a stranger (true), brings it back (false), or lets size and count decide again (undefined). */
export async function setStranger(id: string, value: boolean | undefined): Promise<Undo> {
  const p = state.people.get(id);
  if (!p) return noUndo;
  const np: Person = { ...p, stranger: value };
  if (value === undefined) delete np.stranger;
  state.people.set(id, np);
  await (await db()).put('people', np);
  changes.edits++;
  notify();
  return async () => { if (state.people.has(id)) { state.people.set(id, p); await (await db()).put('people', p); changes.edits++; notify(); } };
}

/** Remembers that these faces are now in backup file number `n` (or in none, with undefined). */
export async function markBackedUp(keys: Iterable<string>, n: number | undefined) {
  const d = await db();
  const tx = d.transaction('faces', 'readwrite');
  for (const k of keys) { const f = state.faces.get(k); if (f && f.b !== n) { const nf = { ...f, b: n }; state.faces.set(k, nf); tx.store.put(nf); } }
  await tx.done;
}

/** Remembers that these re-read faces are now in backup file number `n` (or in none). */
export async function markNextBackedUp(keys: Iterable<string>, n: number | undefined) {
  const d = await db();
  const tx = d.transaction('faces2', 'readwrite');
  for (const k of keys) { const f = state.next.faces.get(k); if (f && f.b !== n) { const nf = { ...f, b: n }; state.next.faces.set(k, nf); tx.store.put(nf); } }
  await tx.done;
}

/** Replaces the photos read again with the stronger face AI with a backup's. */
export async function replaceNext(faces: (Face & { b?: number })[], scanned: string[]) {
  const d = await db();
  const tx = d.transaction(['faces2', 'scanned2'], 'readwrite');
  await Promise.all([tx.objectStore('faces2').clear(), tx.objectStore('scanned2').clear()]);
  const perItem = new Map<string, number>();
  for (const f of faces) { tx.objectStore('faces2').put(f); perItem.set(f.itemId, (perItem.get(f.itemId) ?? 0) + 1); }
  for (const id of scanned) tx.objectStore('scanned2').put(perItem.get(id) ?? 0, id);
  await tx.done;
  state.next = { faces: new Map(faces.map((f) => [f.key, f])), scanned: new Set(scanned) };
  notify();
}

/** Replaces everything about faces and people with a backup's contents. */
export async function replaceAll(people: Person[], faces: StoredFace[], scanned: string[]) {
  const d = await db();
  const tx = d.transaction(['people', 'faces', 'scanned'], 'readwrite');
  await Promise.all([tx.objectStore('people').clear(), tx.objectStore('faces').clear(), tx.objectStore('scanned').clear()]);
  const perItem = new Map<string, number>();
  for (const f of faces) { tx.objectStore('faces').put(f); perItem.set(f.itemId, (perItem.get(f.itemId) ?? 0) + 1); }
  for (const p of people) tx.objectStore('people').put(p);
  for (const id of scanned) tx.objectStore('scanned').put(perItem.get(id) ?? 0, id);
  await tx.done;
  state.loaded = false; state.people.clear(); state.faces.clear(); state.scanned.clear(); state.next.faces.clear(); state.next.scanned.clear();
  await load();
}

/** Names a person. If someone already has that name, the two are joined instead. */
export async function nameAs(id: string, name: string): Promise<Undo> {
  const n = name.trim().toLowerCase();
  const same = n ? [...state.people.values()].find((p) => p.id !== id && p.name?.toLowerCase() === n) : undefined;
  return same ? mergeInto(id, same.id) : rename(id, name);
}

/** "Not this person": the face becomes its own new person. */
export async function splitFace(key: string) {
  const f = state.faces.get(key);
  const p = f && state.people.get(f.person);
  if (!f || !p || p.n <= 1) return;
  const np = { ...without(p, f), cover: p.cover === key ? [...state.faces.values()].find((x) => x.person === p.id && x.key !== key)?.key ?? p.cover : p.cover };
  const alone: Person = { id: newId(), sum: [...f.d], n: 1, cover: key };
  const nf = { ...f, person: alone.id };
  state.people.set(np.id, np); state.people.set(alone.id, alone); state.faces.set(key, nf);
  const d = await db();
  const tx = d.transaction(['people', 'faces'], 'readwrite');
  tx.objectStore('people').put(np); tx.objectStore('people').put(alone); tx.objectStore('faces').put(nf);
  await tx.done;
  changes.edits++;
  notify();
}

export async function forgetAll() {
  stop();
  const d = await db();
  await Promise.all([d.clear('people'), d.clear('faces'), d.clear('scanned'), d.clear('faces2'), d.clear('scanned2')]);
  state.people.clear(); state.faces.clear(); state.scanned.clear(); state.next.faces.clear(); state.next.scanned.clear();
  settle();
  changes.resets++;
  notify();
}

const newId = () => 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

// ---------- finding faces ----------
type FaceApi = typeof import('@vladmandic/face-api');
let apiP: Promise<FaceApi> | null = null;
function faceApi(): Promise<FaceApi> {
  return (apiP ??= (async () => {
    const api = await import('@vladmandic/face-api');
    await (api.tf as any).ready();
    const url = import.meta.env.BASE_URL + 'models';
    await Promise.all([api.nets.ssdMobilenetv1.loadFromUri(url), api.nets.faceLandmark68Net.loadFromUri(url), api.nets.faceRecognitionNet.loadFromUri(url)]);
    return api;
  })());
}

const SIZE = 1024; // pictures are read at this width: enough for faces, quick to process
const picture = async (it: Item) => {
  const bmp = await loadPicture(it, { size: SIZE, fit: 'width' });
  if (previews.blocked) state.run.slow = true;
  return bmp;
};

function cropOf(canvas: HTMLCanvasElement, b: { x: number; y: number; width: number; height: number }): string {
  const pad = 0.25, x = Math.max(0, b.x - b.width * pad), y = Math.max(0, b.y - b.height * pad);
  const w = Math.min(canvas.width - x, b.width * (1 + 2 * pad)), h = Math.min(canvas.height - y, b.height * (1 + 2 * pad));
  const c = document.createElement('canvas'); c.width = 96; c.height = 96;
  const s = Math.max(w, h);
  c.getContext('2d')!.drawImage(canvas, x + (w - s) / 2, y + (h - s) / 2, s, s, 0, 0, 96, 96);
  return c.toDataURL('image/jpeg', 0.8);
}

let stopFlag = false;
export function stop() { stopFlag = true; }

// ---------- the stronger face AI (AdaFace), in its own worker ----------
let adaW: Worker | null = null;
let adaReady: Promise<string> | null = null;
let seq = 0;
const pending = new Map<number, { res: (f: WorkerFace[]) => void; rej: (e: Error) => void }>();
let lastNote = 0;

function adaWorker(): Promise<string> {
  return (adaReady ??= new Promise<string>((res, rej) => {
    const w = new Worker(new URL('./ada.worker.ts', import.meta.url), { type: 'module' });
    const fail = (message: string) => {
      adaReady = null; adaW = null; w.terminate();
      for (const p of pending.values()) p.rej(new Error(message));
      pending.clear();
      rej(new Error(message));
    };
    w.onmessage = (e) => {
      const m = e.data;
      if (m.op === 'progress') {
        state.run.loading = `Downloading the face AI (once): ${Math.round(m.loaded / 1e6)} of ${Math.round(m.total / 1e6)} MB`;
        if (Date.now() - lastNote > 500) { lastNote = Date.now(); notify(); }
      } else if (m.op === 'ready') {
        state.run.loading = undefined; state.run.device = m.device; notify(); res(m.device);
      } else if (m.op === 'error') fail(m.message);
      else {
        const p = pending.get(m.id);
        pending.delete(m.id);
        if (m.error) p?.rej(new Error(m.error)); else p?.res(m.faces);
      }
    };
    w.onerror = (e) => fail(e.message || 'The face AI stopped.');
    adaW = w;
    w.postMessage({ op: 'init', base: import.meta.env.BASE_URL });
  }));
}

function adaFind(canvas: HTMLCanvasElement, minPx: number): Promise<WorkerFace[]> {
  const img = canvas.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, canvas.width, canvas.height);
  const id = ++seq;
  return new Promise((res, rej) => {
    pending.set(id, { res, rej });
    adaW!.postMessage({ op: 'find', id, data: img.data.buffer, width: img.width, height: img.height, minPx }, [img.data.buffer]);
  });
}

const r3 = (x: number) => Math.round(x * 1000) / 1000;

/**
 * Looks for faces in every photo not looked at yet. Safe to stop and start again. Uses the stronger face AI, unless
 * the faces so far came from the older one (then that one, until the photos are read again with the new one).
 */
export async function findFaces(items: Item[]) {
  await load();
  return scan(items, state.old ? 'old' : 'ada');
}

/** Reads every photo again with the stronger face AI. The faces in use stay as they are until you switch. */
export async function readAgain(items: Item[]) {
  return scan(items, 'next');
}

async function scan(items: Item[], mode: 'old' | 'ada' | 'next') {
  if (state.run.running) return;
  await load();
  const done = mode === 'next' ? state.next.scanned : state.scanned;
  const todo = items.filter((it) => (it.kind === 'photo' || it.kind === 'raw') && !done.has(it.id));
  stopFlag = false;
  state.run = { running: true, done: 0, total: todo.length, slow: previews.blocked, upgrade: mode === 'next' };
  notify();
  try {
    let api: FaceApi | undefined, opts: InstanceType<FaceApi['SsdMobilenetv1Options']> | undefined;
    if (mode === 'old') { api = await faceApi(); opts = new api.SsdMobilenetv1Options({ minConfidence: 0.6 }); }
    else { state.run.loading = 'Loading the face AI…'; notify(); await adaWorker(); }
    const canvas = document.createElement('canvas');
    const d = await db();
    let last = Date.now();
    for (const it of todo) {
      if (stopFlag) break;
      state.run.current = it.name;
      let found: Face[] = [];
      try {
        const bmp = await picture(it);
        if (bmp) {
          canvas.width = bmp.width; canvas.height = bmp.height;
          canvas.getContext('2d', { willReadFrequently: true })!.drawImage(bmp, 0, 0);
          bmp.close();
          const W = canvas.width, H = canvas.height;
          if (api && opts) {
            const res = await api.detectAllFaces(canvas, opts).withFaceLandmarks().withFaceDescriptors();
            found = res
              .filter((r) => r.detection.box.width >= 40) // too small to recognise reliably
              .map((r, i) => {
                const b = r.detection.box;
                return { key: `${it.id}#${i}`, itemId: it.id, d: Array.from(r.descriptor), box: [b.x / W, b.y / H, b.width / W, b.height / H] as Face['box'], crop: cropOf(canvas, b) };
              });
          } else {
            const crops = document.createElement('canvas'); // the worker takes the pixels, so crops come from a copy
            crops.width = W; crops.height = H; crops.getContext('2d')!.drawImage(canvas, 0, 0);
            const res = await adaFind(canvas, 40);
            found = res.map((r, i) => {
              const [x, y, w, h] = r.box;
              return {
                key: `${it.id}#${i}`, itemId: it.id, d: Array.from(r.d, r3), box: [x / W, y / H, w / W, h / H] as Face['box'],
                crop: cropOf(crops, { x, y, width: w, height: h }), m: ADA, s: r3(r.score), t: Math.round(r.turn * 100) / 100,
              };
            });
          }
        }
      } catch (e) {
        if ([NEEDS_SIGN_IN, NO_HELPER, NOT_SIGNED_IN, RELOAD].includes((e as Error).message)) throw e; // stop: nothing can be read
        if (!adaReady && mode !== 'old') throw e; // the face AI itself stopped
        // one unreadable photo shouldn't stop the run
      }
      if (mode === 'next') {
        const tx = d.transaction(['faces2', 'scanned2'], 'readwrite');
        for (const f of found) { state.next.faces.set(f.key, f); tx.objectStore('faces2').put(f); }
        tx.objectStore('scanned2').put(found.length, it.id);
        await tx.done;
        state.next.scanned.add(it.id);
      } else {
        const tx = d.transaction(['people', 'faces', 'scanned'], 'readwrite');
        for (const f of found) {
          const p = assign(state.people, f, newId);
          const sf = { ...f, person: p.id };
          state.faces.set(f.key, sf);
          tx.objectStore('faces').put(sf);
          tx.objectStore('people').put(p);
        }
        tx.objectStore('scanned').put(found.length, it.id);
        await tx.done;
        state.scanned.add(it.id);
      }
      state.run.done++;
      changes.faces++;
      if (Date.now() - last > 700) { last = Date.now(); notify(); }
    }
  } catch (e) {
    state.run.error = (e as Error).message;
  } finally {
    state.run.running = false; state.run.current = undefined; state.run.loading = undefined;
    notify();
  }
}

// ---------- switching to the stronger face AI ----------
/** What switching would do, worked out without changing anything. */
export function switchPlan(): Carried {
  return carryOver(state.people, state.faces, [...state.next.faces.values()], newId);
}

/** Per named person: faces now, and faces the stronger face AI found again in the same spot. */
export function switchPreview() {
  return previewCarry(state.people, state.faces, state.next.faces.values());
}

/** Called just before switching, so the backup can keep a copy of the old faces and names. */
export const hooks: { beforeSwitch?: () => Promise<void> } = {};

/** Puts the faces found by the stronger face AI in use, with names carried over. */
export async function switchToNew(): Promise<Carried> {
  if (state.run.running) throw new Error('Pause the face search first.');
  useLimits(512); // the new faces are grouped with AdaFace's limits
  let plan: Carried;
  try { plan = switchPlan(); } catch (e) { settle(); throw e; }
  await hooks.beforeSwitch?.();
  const d = await db();
  const tx = d.transaction(['people', 'faces', 'scanned', 'faces2', 'scanned2'], 'readwrite');
  await Promise.all(['people', 'faces', 'scanned', 'faces2', 'scanned2'].map((s) => tx.objectStore(s).clear()));
  const perItem = new Map<string, number>();
  for (const f of plan.faces) { tx.objectStore('faces').put(f); perItem.set(f.itemId, (perItem.get(f.itemId) ?? 0) + 1); }
  for (const p of plan.people) tx.objectStore('people').put(p);
  for (const id of state.next.scanned) tx.objectStore('scanned').put(perItem.get(id) ?? 0, id);
  await tx.done;
  state.people = new Map(plan.people.map((p) => [p.id, p]));
  state.faces = new Map(plan.faces.map((f) => [f.key, f]));
  state.scanned = new Set(state.next.scanned);
  state.next = { faces: new Map(), scanned: new Set() };
  settle();
  changes.resets++; changes.faces++; changes.edits++;
  notify();
  return plan;
}
