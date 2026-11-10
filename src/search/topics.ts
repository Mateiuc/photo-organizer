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
  /** Photos marked as belonging (yes) or not (no), by item id. They teach "Find more like these". */
  yes?: string[];
  no?: string[];
  /** What learning from the marks found: item ids, best first, and how sure each one is (0 to 1). */
  found?: string[];
  foundP?: number[];
  learnedAt?: string;
  /** Which marks the last learning used, to tell when they changed. */
  learnedFrom?: string;
  /** How sure a learned match must be to count (0 to 1). */
  sure?: number;
  /** Count only learned matches that Google's search found too. */
  onlyGoogle?: boolean;
}

/** How sure a learned match must be, unless the topic says otherwise. */
export const SURE = 0.5;

/** A short fingerprint of a topic's marks. */
export function marksSig(t: Pick<Topic, 'yes' | 'no'>): string {
  const text = [...(t.yes ?? [])].sort().join(',') + '|' + [...(t.no ?? [])].sort().join(',');
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = (Math.imul(h, 33) + text.charCodeAt(i)) >>> 0;
  return `${t.yes?.length ?? 0}:${t.no?.length ?? 0}:${h.toString(36)}`;
}

/**
 * The photos a topic stands for, by item id: once it has learned from marks, the Yes photos and the learned
 * matches (never the No photos); before that, what Google Photos' search found.
 */
export function members(t: Topic): string[] {
  if (!t.learnedAt) return t.keys.map((k) => 'gp:' + k).filter((id) => !t.no?.includes(id));
  const no = new Set(t.no ?? []);
  const sure = t.sure ?? SURE;
  const google = t.onlyGoogle && t.keys.length ? new Set(t.keys.map((k) => 'gp:' + k)) : null;
  const out = (t.yes ?? []).filter((id) => !no.has(id));
  const seen = new Set(out);
  (t.found ?? []).forEach((id, i) => {
    if ((t.foundP?.[i] ?? 0) >= sure && !no.has(id) && !seen.has(id) && (!google || google.has(id))) { out.push(id); seen.add(id); }
  });
  return out;
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
  /** "Find more like these" in progress. */
  learn: { id?: string; step?: 'looking' | 'learning'; error?: string; note?: string };
  v: number;
}
const state: TopicsState = { loaded: false, topics: [], run: { found: 0, done: 0, total: 0 }, learn: {}, v: 0 };
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

/** Marks one photo as belonging to a topic (yes), not belonging (no), or neither (null). */
export async function markTopic(id: string, itemId: string, mark: 'yes' | 'no' | null) {
  await load();
  const t = state.topics.find((x) => x.id === id);
  if (!t) return;
  const yes = (t.yes ?? []).filter((x) => x !== itemId), no = (t.no ?? []).filter((x) => x !== itemId);
  if (mark === 'yes') yes.push(itemId);
  if (mark === 'no') no.push(itemId);
  await put({ ...t, yes, no });
}

/** Changes how sure a learned match must be, or whether it must also be in Google's results. */
export async function tuneTopic(id: string, change: Pick<Topic, 'sure'> | Pick<Topic, 'onlyGoogle'>) {
  const t = state.topics.find((x) => x.id === id);
  if (t) await put({ ...t, ...change });
}

/** Keeps what learning found. */
export async function saveLearned(id: string, found: string[], foundP: number[], from: string) {
  const t = state.topics.find((x) => x.id === id);
  if (t) await put({ ...t, found, foundP, learnedFrom: from, learnedAt: new Date().toISOString() });
}

/** Forgets a topic's marks and what was learned from them. Google's results stay. */
export async function clearLearning(id: string) {
  const t = state.topics.find((x) => x.id === id);
  if (!t) return;
  const rest: Topic = { ...t };
  for (const k of ['yes', 'no', 'found', 'foundP', 'learnedAt', 'learnedFrom', 'sure', 'onlyGoogle'] as const) delete rest[k];
  await put(rest);
}

export function setLearnState(l: TopicsState['learn']) { state.learn = l; notify(); }

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
  for (const t of state.topics) for (const id of members(t)) { const a = out.get(id); a ? a.push(t.name) : out.set(id, [t.name]); }
  return out;
}
