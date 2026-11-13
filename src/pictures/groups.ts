// Turns the pictures' descriptions into "same photo" sets and look-alike pairs, in a worker.
import { useEffect, useRef, useState } from 'react';
import type { Item } from '../lib/model';
import { CLIP_LEN, DIM, type Packed } from './compare';
import { comparable, usePictures, type PicRec } from './store';
import { fresh as clipReady, useSort } from '../sort/store';

export interface Similar {
  /** Sets of the same photo (identical files count once: they have their own tab). */
  same: Item[][];
  /** Look-alike pairs [i, j, closeness] as indexes into `byIndex`. */
  pairs: Float64Array;
  byIndex: Item[];
  /** How many photos have been compared, and whether the sets are being worked out right now. */
  compared: number;
  /** How many of the compared photos have a CLIP fingerprint from Clean up (used for look-alikes). */
  withClip: number;
  working: boolean;
}
const none: Similar = { same: [], pairs: new Float64Array(0), byIndex: [], compared: 0, withClip: 0, working: false };

let worker: Worker | null = null;
let seq = 0;
function compute(p: Packed): Promise<{ same: number[][]; pairs: Float64Array }> {
  worker ??= new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
  const id = ++seq;
  return new Promise((resolve, reject) => {
    const w = worker!;
    const done = (e: MessageEvent) => { if (e.data?.id !== id) return; w.removeEventListener('message', done); w.removeEventListener('error', fail); resolve(e.data); };
    const fail = (e: ErrorEvent) => { w.removeEventListener('message', done); w.removeEventListener('error', fail); worker?.terminate(); worker = null; reject(new Error(e.message)); };
    w.addEventListener('message', done);
    w.addEventListener('error', fail);
    w.postMessage({ id, p }, [p.hash.buffer, p.grid.buffer, p.emb.buffer, p.shape.buffer, p.flat.buffer, p.time.buffer, p.pixels.buffer, p.clip.buffer, p.hasClip.buffer]);
  });
}

function pack(list: { it: Item; r: PicRec; k?: Int8Array }[]): Packed {
  const n = list.length;
  const p: Packed = { n, hash: new Uint32Array(n * 8), grid: new Uint8Array(n * 1024), emb: new Int8Array(n * DIM), shape: new Float32Array(n), flat: new Float32Array(n), time: new Float64Array(n), pixels: new Float64Array(n), clip: new Int8Array(n * CLIP_LEN), hasClip: new Uint8Array(n) };
  list.forEach(({ it, r, k }, i) => {
    p.hash.set(r.h!, i * 8); p.grid.set(r.g!, i * 1024);
    if (r.e?.length === DIM) p.emb.set(r.e, i * DIM);
    if (k?.length === CLIP_LEN) { p.clip.set(k, i * CLIP_LEN); p.hasClip[i] = 1; }
    p.shape[i] = r.ar ?? 1; p.flat[i] = r.fl ?? 0;
    p.time[i] = it.takenAt ? Date.parse(it.takenAt + 'Z') : NaN; // compared with each other only, so the time zone doesn't matter
    p.pixels[i] = it.width && it.height ? it.width * it.height : it.size / 3;
  });
  return p;
}

/**
 * Works out the sets again when the photos or the comparison change: right away when idle, at most every
 * 30 seconds while pictures are being compared.
 */
export function useSimilar(items: Item[], exact: Item[][]): Similar {
  const st = usePictures();
  const sort = useSort();
  // CLIP fingerprints are picked up when Clean up's sorting is not running (it adds them by the thousand).
  const sorting = sort.run.running;
  const [res, setRes] = useState<Similar>(none);
  const last = useRef(0);
  const order = useRef({ started: 0, shown: 0, mounted: true });
  useEffect(() => () => { order.current.mounted = false; }, []);
  const running = st.run.running;
  useEffect(() => {
    if (!st.loaded) return;
    const wait = running ? Math.max(0, 30_000 - (Date.now() - last.current)) : 300;
    const t = setTimeout(async () => {
      last.current = Date.now();
      const n = ++order.current.started;
      // A newer answer may arrive first; an older one is then dropped.
      const fresh = () => order.current.mounted && n > order.current.shown;
      const extra = new Set<string>();
      for (const g of exact) g.slice(1).forEach((x) => extra.add(x.id));
      const list: { it: Item; r: PicRec; k?: Int8Array }[] = [];
      let withClip = 0;
      for (const it of items) {
        const r = st.recs.get(it.id);
        if (!(r?.h && r.g && comparable(it) && !extra.has(it.id))) continue;
        const s = sort.recs.get(it.id);
        const k = clipReady(s) ? s.k : undefined;
        if (k) withClip++;
        list.push({ it, r, k });
      }
      if (list.length < 2) { if (fresh()) { order.current.shown = n; setRes({ ...none, compared: list.length, withClip }); } return; }
      setRes((prev) => ({ ...prev, working: true }));
      try {
        const out = await compute(pack(list));
        if (!fresh()) return;
        order.current.shown = n;
        const byIndex = list.map((x) => x.it);
        setRes({ same: out.same.map((g) => g.map((i) => byIndex[i])), pairs: out.pairs, byIndex, compared: list.length, withClip, working: false });
      } catch {
        if (fresh()) setRes((prev) => ({ ...prev, working: false }));
      }
    }, wait);
    return () => clearTimeout(t);
  }, [items, exact, st.loaded, st.v, running, sort.loaded, sorting]); // eslint-disable-line react-hooks/exhaustive-deps
  return res;
}
