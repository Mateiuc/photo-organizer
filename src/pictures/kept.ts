// Duplicate sets you said to keep as they are ("Keep both"): they are not shown as duplicates again. Kept in this
// browser and in the backup (kept.json). Nothing here deletes anything.
import { useEffect, useState } from 'react';
import { openDB, type IDBPDatabase } from 'idb';

const DEMO = typeof location !== 'undefined' && new URLSearchParams(location.search).has('demo');
let dbp: Promise<IDBPDatabase> | null = null;
const db = () => (dbp ??= openDB(DEMO ? 'photo-organizer-kept-demo' : 'photo-organizer-kept', 1, {
  upgrade(d) { d.createObjectStore('sets'); },
}));

/** Each set: the ids of the photos or videos you said to keep together, sorted. */
export interface KeptState { loaded: boolean; sets: string[][]; v: number }
const state: KeptState = { loaded: false, sets: [], v: 0 };
export const keptChanges = { n: 0 };
const listeners = new Set<() => void>();
function notify() { state.v++; listeners.forEach((f) => f()); }
export function subscribeKept(f: () => void): () => void { listeners.add(f); return () => { listeners.delete(f); }; }

let loading: Promise<void> | null = null;
function load() {
  return (loading ??= (async () => {
    try { state.sets = ((await (await db()).get('sets', 'all')) as string[][] | undefined) ?? []; } catch { /* starts empty */ }
    state.loaded = true;
    notify();
  })());
}
export async function keptReady(): Promise<KeptState> { await load(); return state; }
export function useKept(): KeptState {
  const [, set] = useState(0);
  useEffect(() => { load(); return subscribeKept(() => set((x) => x + 1)); }, []);
  return state;
}

async function store() {
  keptChanges.n++;
  notify();
  await (await db()).put('sets', state.sets, 'all');
}

/** Keeps these photos together: their set isn't shown as duplicates again. */
export async function keepTogether(ids: readonly string[]) {
  await load();
  state.sets = [...state.sets, [...ids].sort()];
  await store();
}
/** Undoes keepTogether for exactly this set. */
export async function forgetKept(ids: readonly string[]) {
  await load();
  const key = [...ids].sort().join('|');
  state.sets = state.sets.filter((s) => s.join('|') !== key);
  await store();
}
/** From a backup. */
export async function replaceAllKept(sets: string[][]) {
  state.sets = sets.map((s) => [...s].sort());
  state.loaded = true;
  await store();
}

/**
 * True when every photo of a duplicate set is inside one set you kept (so a set that lost a photo stays hidden, and
 * a set that gained a new copy shows again).
 */
export function isKept(sets: string[][], ids: readonly string[]): boolean {
  return sets.some((s) => ids.every((id) => s.includes(id)));
}
