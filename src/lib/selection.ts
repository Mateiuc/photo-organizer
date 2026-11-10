// Picking photos to act on (Move to trash): tap photos to tick them, Shift-click to tick a range, "Select all" for
// everything shown, or the tick on a month heading for the whole month.
//
// The grids on screen tell this store which photos they show, in their order, so Shift-click and "Select all" work
// on whatever page is open (Photos, a search topic, a place, a person).
import { useEffect, useSyncExternalStore } from 'react';

const listeners = new Set<() => void>();
let on = false;
let ids = new Set<string>();
let anchor: string | undefined;
let version = 0;
const lists = new Map<number, string[]>();
let listSeq = 0;
let shownCache: { at: number; ids: string[] } | undefined;

function changed() { version++; listeners.forEach((f) => f()); }
function subscribe(f: () => void) { listeners.add(f); return () => { listeners.delete(f); }; }

/** Read-only view of the selection, for the page around the grids. */
export const selection = {
  get on() { return on; },
  get ids(): ReadonlySet<string> { return ids; },
  get size() { return ids.size; },
};

/** Re-renders when anything about the selection changes. */
export function useSelection() {
  useSyncExternalStore(subscribe, () => version);
  return selection;
}
/** Re-renders only when select mode turns on or off. */
export const useSelecting = () => useSyncExternalStore(subscribe, () => on);
/** Re-renders only when this photo is ticked or unticked. */
export const useTicked = (id: string) => useSyncExternalStore(subscribe, () => ids.has(id));
/** 'all', 'some' or 'none' of these photos are ticked (for a month heading). */
export function useTickedOf(group: string[]): 'all' | 'some' | 'none' {
  return useSyncExternalStore(subscribe, () => {
    let n = 0;
    for (const id of group) if (ids.has(id)) n++;
    return n === 0 ? 'none' : n === group.length ? 'all' : 'some';
  });
}

export function startSelecting() {
  if (on) return;
  on = true;
  changed();
}

/** Leaves select mode and unticks everything. */
export function stopSelecting() {
  if (!on && !ids.size) return;
  on = false; ids = new Set(); anchor = undefined;
  changed();
}

/** The photos from `a` to `b` (both included) in the order shown, or undefined if they aren't in the same list. */
export function rangeIn(list: readonly string[], a: string, b: string): string[] | undefined {
  const i = list.indexOf(a), j = list.indexOf(b);
  if (i < 0 || j < 0) return undefined;
  return list.slice(Math.min(i, j), Math.max(i, j) + 1);
}

/**
 * Ticks or unticks one photo. With Shift held, ticks every photo between the last one clicked and this one,
 * the way file windows and Google Photos do it.
 */
export function toggleTick(id: string, shift = false) {
  const next = new Set(ids);
  let range: string[] | undefined;
  if (shift && anchor && anchor !== id) for (const l of lists.values()) if ((range = rangeIn(l, anchor, id))) break;
  if (range) range.forEach((x) => next.add(x));
  else if (next.has(id)) next.delete(id);
  else next.add(id);
  anchor = id; ids = next; on = true;
  changed();
}

/** Ticks (or unticks) many photos at once, like a whole month. */
export function setTicked(group: readonly string[], value: boolean) {
  const next = new Set(ids);
  for (const id of group) value ? next.add(id) : next.delete(id);
  ids = next; on = true;
  changed();
}

/** Unticks everything but stays in select mode. */
export function clearTicks() {
  if (!ids.size) return;
  ids = new Set(); anchor = undefined;
  changed();
}

/** Every photo the grids on screen show right now (each once). */
export function shownIds(): string[] {
  if (shownCache?.at === listSeq) return shownCache.ids;
  const seen = new Set<string>();
  for (const l of lists.values()) for (const id of l) seen.add(id);
  shownCache = { at: listSeq, ids: [...seen] };
  return shownCache.ids;
}

/** Ticks every photo the page shows. */
export const selectAllShown = () => setTicked(shownIds(), true);

/** Unticks photos that are gone (moved to the trash). */
export function forgetTicks(gone: Iterable<string>) {
  const next = new Set(ids);
  let n = 0;
  for (const id of gone) if (next.delete(id)) n++;
  if (!n) return;
  ids = next;
  changed();
}

/** Registers a list of photos on screen, in its order. Returns the function that removes it again. */
export function showList(order: readonly string[]): () => void {
  const key = ++listSeq;
  lists.set(key, order as string[]);
  changed();
  return () => { lists.delete(key); listSeq++; changed(); };
}

/** A grid calls this with the photos it shows, in its order. */
export function useShownList(order: readonly string[]) {
  useEffect(() => showList(order), [order]);
}

/** How many photos the grids on screen show (for "Select all N"). Re-renders with the selection. */
export function useShownCount() {
  useSyncExternalStore(subscribe, () => version);
  return shownIds().length;
}
