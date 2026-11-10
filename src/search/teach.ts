// "Find more like these": makes sure the marked photos (and Google's results for the topic) have been looked at,
// then learns from the marks in a worker and keeps the matches with the topic.
import type { Item } from '../lib/model';
import { DIM } from '../pictures/compare';
import { comparable, comparePictures, needsLook, picturesReady } from '../pictures/store';
import { hasFile } from '../local/fs';
import { LEARN, type LearnInput } from './learn';
import { marksSig, saveLearned, setLearnState, topicsReady } from './topics';

let worker: Worker | null = null;
let seq = 0;
function score(input: LearnInput): Promise<Float32Array> {
  worker ??= new Worker(new URL('./learn.worker.ts', import.meta.url), { type: 'module' });
  const id = ++seq;
  return new Promise((resolve, reject) => {
    const w = worker!;
    const done = (e: MessageEvent) => { if (e.data?.id !== id) return; off(); resolve(e.data.scores); };
    const fail = (e: ErrorEvent) => { off(); worker?.terminate(); worker = null; reject(new Error(e.message || 'Learning stopped')); };
    const off = () => { w.removeEventListener('message', done); w.removeEventListener('error', fail); };
    w.addEventListener('message', done);
    w.addEventListener('error', fail);
    w.postMessage({ id, input }, [input.emb.buffer]);
  });
}

const seedOf = (s: string) => { let h = 2166136261; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0; return h || 1; };

/** Photos the app can learn from: ones it has looked at, with an AI fingerprint. */
export function withFingerprint(all: Item[], recs: Map<string, { e?: Int8Array; x?: 1 }>): Item[] {
  return all.filter((it) => { const r = recs.get(it.id); return comparable(it) && !r?.x && r?.e?.length === DIM; });
}

/** Learns topic `id` from its marks and scores every photo that has been looked at. */
export async function learnTopic(id: string, all: Item[]) {
  const ts = await topicsReady();
  if (ts.learn.id) return;
  let t = ts.topics.find((x) => x.id === id);
  if (!t) return;
  try {
    const pics = await picturesReady();
    const byId = new Map(all.map((x) => [x.id, x]));
    // 1. The marked photos and Google's results for this topic are looked at first, if they haven't been.
    const wanted = [...(t.yes ?? []), ...(t.no ?? []), ...t.keys.map((k) => 'gp:' + k)];
    const need = wanted.map((x) => byId.get(x)).filter((it): it is Item => !!it && needsLook(it, pics.recs.get(it.id)) && (!it.local || hasFile(it.id)));
    let note: string | undefined;
    if (need.length) {
      if (pics.run.running) note = 'Compare pictures is running, so some marked photos may not have been looked at yet. Search again when it finishes.';
      else {
        setLearnState({ id, step: 'looking' });
        await comparePictures(need);
        if (pics.run.error) throw new Error(pics.run.error);
      }
    }
    // 2. Learn from the marks (they may have changed while photos were looked at).
    setLearnState({ id, step: 'learning', note });
    t = (await topicsReady()).topics.find((x) => x.id === id) ?? t;
    const pool = withFingerprint(all, pics.recs);
    const index = new Map(pool.map((it, i) => [it.id, i]));
    const yes = (t.yes ?? []).map((x) => index.get(x)).filter((i): i is number => i != null);
    const no = (t.no ?? []).map((x) => index.get(x)).filter((i): i is number => i != null);
    if (!yes.length) throw new Error((t.yes?.length ? 'The photos marked Yes could not be looked at yet' : 'Mark at least one photo with ✓ first') + '.');
    const emb = new Int8Array(pool.length * DIM);
    pool.forEach((it, i) => emb.set(pics.recs.get(it.id)!.e!, i * DIM));
    const scores = await score({ emb, n: pool.length, yes, no, seed: seedOf(id) });
    const marked = new Set([...yes, ...no]);
    const order: number[] = [];
    for (let i = 0; i < pool.length; i++) if (!marked.has(i) && scores[i] >= LEARN.keep) order.push(i);
    order.sort((a, b) => scores[b] - scores[a]);
    const top = order.slice(0, 5000);
    await saveLearned(id, top.map((i) => pool[i].id), top.map((i) => Math.round(scores[i] * 1000) / 1000), marksSig(t));
    setLearnState({ note });
  } catch (e) {
    setLearnState({ error: (e as Error).message || String(e) });
  }
}
