// Search topics: a name (like "Cars") and the Google Photos searches that make it up ("car", "vehicle"…).
// What each topic found is kept in this browser and in the backup, so it shows instantly next time.
import { useEffect, useState } from 'react';
import { openDB, type IDBPDatabase } from 'idb';
import { searchGp } from '../gphotos/api';

export interface Topic {
  id: string;
  name: string;
  queries: string[];
  /** Media keys of the Google Photos items found. */
  keys: string[];
  /** How many each search found, last time. */
  counts?: Record<string, number>;
  at?: string; // when last searched
  preset?: boolean;
}

/** The topics the app starts with. Each one can be edited. */
export const PRESETS: Topic[] = [
  { id: 'cars', name: 'Cars', queries: ['car', 'vehicle', 'truck', 'engine'], keys: [], preset: true },
  { id: 'vin', name: 'VIN', queries: ['VIN', 'VIN number', 'vehicle identification number'], keys: [], preset: true },
  { id: 'wires', name: 'Wires & electronics', queries: ['wires', 'cables', 'wiring', 'electronics', 'circuit board', 'electrical panel', 'fuse box', 'connector'], keys: [], preset: true },
];

/** Splits "car, vehicle; truck" into searches, without repeats. */
export function parseQueries(text: string): string[] {
  const out: string[] = [];
  for (const q of text.split(/[,;\n]/).map((x) => x.trim().replace(/\s+/g, ' ')).filter(Boolean)) if (!out.some((o) => o.toLowerCase() === q.toLowerCase())) out.push(q);
  return out;
}

/** Everything the searches found, each item once, in the order found. */
export function union(results: string[][]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of results) for (const k of r) if (!seen.has(k)) { seen.add(k); out.push(k); }
  return out;
}

const DEMO = typeof location !== 'undefined' && new URLSearchParams(location.search).has('demo');
let dbp: Promise<IDBPDatabase> | null = null;
const db = () => (dbp ??= openDB(DEMO ? 'photo-organizer-topics-demo' : 'photo-organizer-topics', 1, {
  upgrade(d) { d.createObjectStore('topics', { keyPath: 'id' }); },
}));

export interface TopicsState {
  loaded: boolean;
  topics: Topic[];
  run: { id?: string; query?: string; found: number; done: number; total: number; error?: string };
  v: number;
}
const state: TopicsState = { loaded: false, topics: [], run: { found: 0, done: 0, total: 0 }, v: 0 };
const listeners = new Set<() => void>();
let version = 0;
const notify = () => { state.v = ++version; listeners.forEach((f) => f()); };
/** Counter the backup watches. */
export const topicChanges = { n: 0 };
export function subscribeTopics(f: () => void): () => void { listeners.add(f); return () => { listeners.delete(f); }; }

let loading: Promise<void> | null = null;
async function load() {
  if (state.loaded) return;
  await (loading ??= (async () => {
    const saved: Topic[] = await (await db()).getAll('topics');
    // Presets come first, in their own order; ones not saved yet are added.
    const byId = new Map(saved.map((t) => [t.id, t]));
    state.topics = [...PRESETS.map((p) => byId.get(p.id) ?? p), ...saved.filter((t) => !PRESETS.some((p) => p.id === t.id)).sort((a, b) => a.name.localeCompare(b.name))];
    state.loaded = true;
    notify();
  })());
}
export async function topicsReady(): Promise<TopicsState> { await load(); return state; }

export function useTopics(): TopicsState {
  const [, set] = useState(0);
  useEffect(() => {
    const f = () => set(version);
    listeners.add(f);
    load().catch((e) => { state.run.error = String(e?.message ?? e); notify(); });
    return () => { listeners.delete(f); };
  }, []);
  return state;
}

async function put(t: Topic) {
  await (await db()).put('topics', t);
  const i = state.topics.findIndex((x) => x.id === t.id);
  if (i >= 0) state.topics[i] = t; else state.topics.push(t);
  state.topics = [...state.topics];
  topicChanges.n++;
  notify();
}

export async function saveTopic(name: string, queries: string[], keys: string[] = [], counts?: Record<string, number>): Promise<Topic> {
  await load();
  const t: Topic = { id: 't' + Date.now().toString(36), name: name.trim(), queries, keys, counts, at: keys.length ? new Date().toISOString() : undefined };
  await put(t);
  return t;
}

/** New searches for a topic. What was found stays until it is searched again. */
export async function editTopic(id: string, name: string, queries: string[]) {
  const t = state.topics.find((x) => x.id === id);
  if (t) await put({ ...t, name: name.trim() || t.name, queries });
}

export async function deleteTopic(id: string) {
  await (await db()).delete('topics', id);
  state.topics = state.topics.filter((t) => t.id !== id);
  topicChanges.n++;
  notify();
}

/** Replaces all topics with a backup's. */
export async function replaceAllTopics(topics: Topic[]) {
  const tx = (await db()).transaction('topics', 'readwrite');
  await tx.store.clear();
  for (const t of topics) tx.store.put(t);
  await tx.done;
  state.loaded = false; loading = null;
  await load();
}

let signal = { stop: false };
export function stopSearch() { signal.stop = true; }

/** Runs every search of one topic in Google Photos and keeps what they found together. */
export async function runTopic(id: string) {
  await load();
  const t = state.topics.find((x) => x.id === id);
  if (!t || state.run.id) return;
  signal = { stop: false };
  state.run = { id, found: 0, done: 0, total: t.queries.length };
  notify();
  try {
    const results: string[][] = [];
    const counts: Record<string, number> = {};
    for (const q of t.queries) {
      if (signal.stop) break;
      state.run.query = q; notify();
      const before = union(results).length;
      const r = (await searchGp(q, (n) => { state.run.found = before + n; notify(); }, signal)).map((g) => g.mediaKey);
      results.push(r); counts[q] = r.length;
      state.run.found = union(results).length; state.run.done++;
      notify();
    }
    if (!signal.stop) await put({ ...state.topics.find((x) => x.id === id)!, keys: union(results), counts, at: new Date().toISOString() });
    state.run = { found: 0, done: 0, total: 0 };
  } catch (e) {
    state.run = { found: 0, done: 0, total: 0, error: (e as Error).message };
  } finally {
    notify();
  }
}

/** One search that isn't saved (yet). */
export async function searchOnce(query: string, onFound: (n: number) => void): Promise<string[]> {
  signal = { stop: false };
  return (await searchGp(query, onFound, signal)).map((g) => g.mediaKey);
}

/** Topic names for each item, so the main search box finds "VIN" photos too. */
export function topicsByItem(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const t of state.topics) for (const k of t.keys) { const id = 'gp:' + k; const a = out.get(id); a ? a.push(t.name) : out.set(id, [t.name]); }
  return out;
}
