// Finds faces in the photos and keeps the people the app has learned, in this browser.
// Everything runs on this computer: no photo or face is sent anywhere.
import { useEffect, useState } from 'react';
import { openDB, type IDBPDatabase } from 'idb';
import { downloadFile, NEEDS_SIGN_IN } from '../drive/api';
import { sizedThumb, thumbUrl, type Item } from '../lib/model';
import { ask, NO_HELPER, NOT_SIGNED_IN, RELOAD } from '../gphotos/bridge';
import { getLocalFile } from '../local/fs';
import { assign, merge as mergePeople, without, type Face, type Person } from './cluster';

const DEMO = new URLSearchParams(location.search).has('demo');
let dbp: Promise<IDBPDatabase> | null = null;
const db = () => (dbp ??= openDB(DEMO ? 'photo-organizer-faces-demo' : 'photo-organizer-faces', 1, {
  upgrade(d) {
    d.createObjectStore('scanned'); // itemId → number of faces found
    d.createObjectStore('faces', { keyPath: 'key' });
    d.createObjectStore('people', { keyPath: 'id' });
  },
}));

// ---------- in-memory state, shared by every view ----------
export interface PeopleState {
  loaded: boolean;
  people: Map<string, Person>;
  faces: Map<string, Face & { person: string }>;
  scanned: Set<string>;
  run: { running: boolean; done: number; total: number; current?: string; error?: string; slow?: boolean };
}
const state: PeopleState = { loaded: false, people: new Map(), faces: new Map(), scanned: new Set(), run: { running: false, done: 0, total: 0 } };
const listeners = new Set<() => void>();
let version = 0;
const notify = () => { version++; listeners.forEach((f) => f()); };

async function load() {
  if (state.loaded) return;
  const d = await db();
  const [people, faces, keys] = await Promise.all([d.getAll('people'), d.getAll('faces'), d.getAllKeys('scanned')]);
  people.forEach((p: Person) => state.people.set(p.id, p));
  faces.forEach((f) => state.faces.set(f.key, f));
  keys.forEach((k) => state.scanned.add(String(k)));
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
export async function rename(id: string, name: string) {
  const p = state.people.get(id);
  if (!p) return;
  const np = { ...p, name: name.trim() || undefined };
  state.people.set(id, np);
  await (await db()).put('people', np);
  notify();
}

export async function mergeInto(fromId: string, intoId: string) {
  const from = state.people.get(fromId), into = state.people.get(intoId);
  if (!from || !into || from === into) return;
  const np = mergePeople(from, into);
  const d = await db();
  const tx = d.transaction(['people', 'faces'], 'readwrite');
  const moved: (Face & { person: string })[] = [];
  for (const f of state.faces.values()) if (f.person === fromId) { const nf = { ...f, person: intoId }; moved.push(nf); }
  moved.forEach((f) => { state.faces.set(f.key, f); tx.objectStore('faces').put(f); });
  state.people.set(intoId, np); state.people.delete(fromId);
  tx.objectStore('people').put(np); tx.objectStore('people').delete(fromId);
  await tx.done;
  notify();
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
  notify();
}

export async function forgetAll() {
  stop();
  const d = await db();
  await Promise.all([d.clear('people'), d.clear('faces'), d.clear('scanned')]);
  state.people.clear(); state.faces.clear(); state.scanned.clear();
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
let previewsBlocked = false; // Drive previews can't be read by the page; fall back to the full file

async function picture(it: Item): Promise<ImageBitmap | undefined> {
  let blob: Blob | undefined;
  if (it.local) blob = await getLocalFile(it.id);
  else if (DEMO) { if (it.thumb) blob = await (await fetch(it.thumb)).blob(); }
  else if (it.gp) {
    // Google Photos: the helper add-on fetches a 1024 px picture in the Google Photos tab.
    const url = thumbUrl(it, SIZE);
    if (url) blob = await (await fetch((await ask<{ dataUrl: string }>({ op: 'image', url }, 60000)).dataUrl)).blob();
  }
  else {
    if (!previewsBlocked && it.thumb) {
      try {
        const r = await fetch(sizedThumb(it.thumb, SIZE)!, { referrerPolicy: 'no-referrer' });
        if (r.ok) blob = await r.blob();
      } catch { previewsBlocked = true; state.run.slow = true; }
    }
    if (!blob && it.kind !== 'raw') blob = await downloadFile(it.id);
  }
  if (!blob) return undefined;
  try {
    const probe = await createImageBitmap(blob);
    if (probe.width <= SIZE) return probe;
    probe.close();
    return await createImageBitmap(blob, { resizeWidth: SIZE, resizeQuality: 'medium' });
  } catch { return undefined; } // a format the browser can't open (HEIC, most RAW)
}

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

/** Looks for faces in every photo not looked at yet. Safe to stop and start again. */
export async function findFaces(items: Item[]) {
  if (state.run.running) return;
  await load();
  const todo = items.filter((it) => (it.kind === 'photo' || it.kind === 'raw') && !state.scanned.has(it.id));
  stopFlag = false;
  state.run = { running: true, done: 0, total: todo.length, slow: previewsBlocked };
  notify();
  try {
    const api = await faceApi();
    const opts = new api.SsdMobilenetv1Options({ minConfidence: 0.6 });
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
          canvas.getContext('2d')!.drawImage(bmp, 0, 0);
          bmp.close();
          const res = await api.detectAllFaces(canvas, opts).withFaceLandmarks().withFaceDescriptors();
          found = res
            .filter((r) => r.detection.box.width >= 40) // too small to recognise reliably
            .map((r, i) => {
              const b = r.detection.box;
              return { key: `${it.id}#${i}`, itemId: it.id, d: Array.from(r.descriptor), box: [b.x / canvas.width, b.y / canvas.height, b.width / canvas.width, b.height / canvas.height] as Face['box'], crop: cropOf(canvas, b) };
            });
        }
      } catch (e) {
        if ([NEEDS_SIGN_IN, NO_HELPER, NOT_SIGNED_IN, RELOAD].includes((e as Error).message)) throw e; // stop: nothing can be read
        // one unreadable photo shouldn't stop the run
      }
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
      state.run.done++;
      if (Date.now() - last > 700) { last = Date.now(); notify(); }
    }
  } catch (e) {
    state.run.error = (e as Error).message;
  } finally {
    state.run.running = false; state.run.current = undefined;
    notify();
  }
}
