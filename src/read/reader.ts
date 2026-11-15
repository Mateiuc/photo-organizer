// One look per photo. A photo's picture is fetched once, and from that one copy the app makes everything it keeps
// about it: the comparison data (Duplicates, Search) and the AI fingerprint (Clean up). Before, each page fetched the
// photo for itself. Faces are found separately, in People.
//
// Whichever page starts the read leads: its photos are the ones read, in its order. For each of them the other part
// is made too when it is missing, so the photo never has to be fetched again.
import { NEEDS_SIGN_IN } from '../drive/api';
import { NO_HELPER, NOT_SIGNED_IN, RELOAD } from '../gphotos/bridge';
import type { Item } from '../lib/model';
import { loadShapes } from '../lib/picture';
import { hasFile } from '../local/fs';
import { needsLook, picturesReady, picturesSession, showPicturesRun, type PicSession } from '../pictures/store';
import { inDrive, needsSort, sortOrder, sortReady, sortSession, showSortRun, type SortSession } from '../sort/store';
import { plan, READ_SIZE } from './plan';
import type { ReadRun } from './run';

/** Who asked: 'compare' = Duplicates and Search (newest photos first), 'sort' = Clean up (mixed order). */
export type Lead = 'compare' | 'sort';
export interface ReadOptions {
  /** Only the leading part, nothing else (a few photos needed right now, so no waiting for another AI). */
  alone?: boolean;
}

/** Nothing can be read at all: stop. */
const FATAL = [NO_HELPER, NOT_SIGNED_IN, RELOAD];
let busy = false;
let stopFlag = false;
export function stopReading() { stopFlag = true; }

/**
 * Looks at every photo the leading page hasn't seen yet. Safe to stop and start again. When the Google sign-in runs
 * out, the Drive photos wait and the others carry on.
 */
export async function readPhotos(items: Item[], lead: Lead, o: ReadOptions = {}) {
  if (busy) return;
  busy = true; stopFlag = false;
  const run: ReadRun = { running: true, done: 0, total: 0, step: 'model' };
  let last = 0;
  const tell = (now = false) => {
    if (!now && Date.now() - last < 700) return;
    last = Date.now();
    showPicturesRun(run); showSortRun(run);
  };
  tell(true);
  let pics: PicSession | undefined, sort: SortSession | undefined;
  try {
    const [ps, ss] = await Promise.all([picturesReady(), sortReady()]);
    const wantPic = (it: Item) => (lead === 'compare' || !o.alone) && needsLook(it, ps.recs.get(it.id));
    const wantSort = (it: Item) => (lead === 'sort' || !o.alone) && needsSort(it, ss.recs.get(it.id));
    const leads = lead === 'compare' ? wantPic : wantSort;
    // Files on this computer can only be read once their folder is open in this visit.
    const todo = items.filter((it) => leads(it) && (!it.local || hasFile(it.id)));
    if (lead === 'compare') todo.sort((a, b) => (b.takenAt ?? '').localeCompare(a.takenAt ?? ''));
    else { const at = new Map(todo.map((it) => [it.id, sortOrder(it)])); todo.sort((a, b) => at.get(a.id)! - at.get(b.id)!); }
    run.total = todo.length;
    tell(true);

    // The leading part must start; the other one is left out of this run when it can't (its page reads them later).
    if (todo.some(wantSort)) {
      try { sort = await sortSession((loaded, total) => { run.model = { loaded, total }; tell(); }); }
      catch (e) { if (lead === 'sort') throw e; run.note = 'The Clean-up AI couldn’t start, so these photos are only compared. Clean up will sort them later.'; }
    }
    if (todo.some(wantPic)) {
      try { pics = await picturesSession(); }
      catch (e) { if (lead === 'compare') throw e; run.note = 'The picture comparison couldn’t start, so these photos are only sorted. Duplicates will compare them later.'; }
    }
    run.step = 'reading'; run.startedAt = Date.now();
    tell(true);

    // Pictures are fetched up to 6 at once. The comparison is quick and runs here; each AI worker looks at one picture
    // at a time.
    type Got = { it: Item; bmps?: ImageBitmap[]; made?: boolean[]; err?: unknown; original: { width?: number; height?: number }; p: boolean; s: boolean };
    const queue: Promise<Got>[] = [];
    let next = 0, signInLost = false;
    const fill = () => {
      while (queue.length < 6 && next < todo.length && !stopFlag) {
        const it = todo[next++];
        if (signInLost && inDrive(it)) continue; // left for after you sign in again
        const p = !!pics && wantPic(it), s = !!sort && wantSort(it);
        if (!p && !s) continue;
        const original = {};
        queue.push(loadShapes(it, READ_SIZE, plan(p, s).shapes, original).then((r) => ({ it, bmps: r?.bmps, made: r?.made, original, p, s }), (err) => ({ it, err, original, p, s })));
      }
    };
    const finished = (it: Item) => { run.done++; run.current = it.name; tell(); };
    fill();
    const running = new Set<Promise<void>>();
    const idle = sort ? [...sort.workers] : [];
    let wake: (() => void) | null = null;
    let failed: unknown;
    while (queue.length) {
      const { it, bmps, made, err, original, p, s } = await queue.shift()!;
      if (stopFlag || failed) { bmps?.forEach((b) => b.close()); continue; }
      fill();
      if (err && (err as Error).message === NEEDS_SIGN_IN) { signInLost = true; continue; }
      if (err && FATAL.includes((err as Error).message)) throw err;
      const at = plan(p, s);
      if (p) {
        const bmp = bmps?.[at.pic];
        await pics!.take(it, bmp, original, !!made?.[at.pic]);
        bmp?.close();
      }
      if (!s) { finished(it); continue; }
      while (!idle.length) await new Promise<void>((r) => { wake = r; });
      const worker = idle.shift()!;
      const job: Promise<void> = sort!.take(worker, it, bmps?.[at.sort])
        .then(() => finished(it), (e) => { failed ??= e; })
        .finally(() => { idle.push(worker); running.delete(job); const w = wake; wake = null; w?.(); });
      running.add(job);
    }
    await Promise.all(running);
    if (failed) throw failed;
    if (signInLost) run.error = NEEDS_SIGN_IN;
  } catch (e) {
    run.error = (e as Error).message || String(e);
  } finally {
    await pics?.flush().catch(() => {});
    await sort?.flush().catch(() => {});
    run.running = false; run.current = undefined; run.step = undefined;
    busy = false;
    tell(true);
  }
}

/** Duplicates and Search: looks at the photos not compared yet. */
export const comparePictures = (items: Item[], o?: ReadOptions) => readPhotos(items, 'compare', o);
/** Clean up: looks at the photos not sorted yet. */
export const sortPhotos = (items: Item[]) => readPhotos(items, 'sort');
