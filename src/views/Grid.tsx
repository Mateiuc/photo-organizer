import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { fmtDuration, monthLabel, thumbUrl, type Item } from '../lib/model';
import { useLocalThumb } from '../local/thumbs';
import { directFailed, helperPicture, viaHelperOnly } from '../gphotos/api';
import { setTicked, startSelecting, toggleTick, useSelecting, useShownList, useTicked, useTickedOf } from '../lib/selection';

const noPreview = (item: Item) => <span className="ph">{item.kind === 'raw' ? 'RAW · no preview' : item.name}</span>;

/** A file on this computer: the preview is made once the tile scrolls into view. */
function LocalPreview({ item }: { item: Item }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [vis, setVis] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver((es) => { if (es[0].isIntersecting) { setVis(true); io.disconnect(); } }, { rootMargin: '400px' });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  const url = useLocalThumb(item, vis);
  if (url) return <img src={url} alt="" decoding="async" />;
  return <span ref={ref} className="ph">{url === undefined ? noPreview(item).props.children : ''}</span>;
}

/** Shows when the element scrolls near the screen. */
function useVisible(ref: RefObject<Element>, on = true) {
  const [vis, setVis] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || !on) return;
    const io = new IntersectionObserver((es) => { if (es[0].isIntersecting) { setVis(true); io.disconnect(); } }, { rootMargin: '400px' });
    io.observe(el);
    return () => io.disconnect();
  }, [ref, on]);
  return vis;
}

/**
 * A Google Photos item: Google's preview link is tried directly. If the browser won't load it, the helper
 * add-on fetches it in the Google Photos tab, and from then on every preview goes through the add-on.
 */
export function GpPicture({ item, px, className }: { item: Item; px: number; className?: string }) {
  const url = thumbUrl(item, px);
  const ref = useRef<HTMLSpanElement>(null);
  const [src, setSrc] = useState<string | undefined>(() => (viaHelperOnly() ? undefined : url));
  const [failed, setFailed] = useState(false);
  const vis = useVisible(ref, !src && !failed);
  useEffect(() => { setSrc(viaHelperOnly() ? undefined : url); setFailed(false); }, [url]);
  useEffect(() => {
    if (!vis || src || failed || !url) return;
    let live = true;
    helperPicture(url).then((d) => { if (live) d ? setSrc(d) : setFailed(true); });
    return () => { live = false; };
  }, [vis, src, failed, url]);
  if (!url || failed) return noPreview(item);
  if (!src) return <span ref={ref} className="ph" />;
  return (
    <img className={className} src={src} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer"
      onError={() => {
        if (src !== url) { setFailed(true); return; }
        helperPicture(url).then((d) => { if (d) { directFailed(); setSrc(d); } else setFailed(true); });
      }} />
  );
}

/** The picture inside a tile, for Drive, Google Photos and files on this computer. */
export function Preview({ item, px = 320, onBroken }: { item: Item; px?: number; onBroken?: (it: Item) => void }) {
  const [bad, setBad] = useState(false);
  if (item.local) return <LocalPreview item={item} />;
  if (item.gp) return <GpPicture item={item} px={px} />;
  const src = thumbUrl(item, px);
  return src && !bad
    ? <img src={src} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={() => { setBad(true); onBroken?.(item); }} />
    : noPreview(item);
}

/**
 * One photo in a grid. With `selectable`, a tick in the corner picks it for "Move to trash", and in select mode a
 * click ticks it (Shift-click ticks a range) instead of opening it.
 */
export function Thumb({ item, onOpen, onBroken, selectable }: { item: Item; onOpen: () => void; onBroken?: (it: Item) => void; selectable?: boolean }) {
  const selecting = useSelecting();
  const ticked = useTicked(item.id);
  const tile = (
    <button className="tile" onClick={(e) => (selectable && selecting ? toggleTick(item.id, e.shiftKey) : onOpen())} title={item.name}
      aria-label={selectable && selecting ? `${ticked ? 'Untick' : 'Tick'} ${item.name}` : `Open ${item.name}`} aria-pressed={selectable && selecting ? ticked : undefined}>
      <Preview item={item} onBroken={onBroken} />
      {item.kind === 'video' && <span className="badge">▶ {fmtDuration(item.durationMs)}</span>}
      {item.kind === 'raw' && <span className="badge">RAW</span>}
    </button>
  );
  if (!selectable) return tile;
  return (
    <div className={`stile${selecting ? ' selecting' : ''}${ticked ? ' ticked' : ''}`}>
      {tile}
      <button className="tick" tabIndex={selecting ? -1 : 0} aria-hidden={selecting || undefined} title={ticked ? 'Untick' : 'Select'} aria-label={`Select ${item.name}`}
        onClick={(e) => { startSelecting(); toggleTick(item.id, e.shiftKey); }}>✓</button>
    </div>
  );
}

/** The tick on a month heading: picks the whole month. */
function MonthTick({ ids, label }: { ids: string[]; label: string }) {
  const state = useTickedOf(ids);
  return (
    <button className={`mtick ${state}`} title={state === 'all' ? `Untick ${label}` : `Select all of ${label}`} aria-label={state === 'all' ? `Untick ${label}` : `Select all of ${label}`}
      aria-pressed={state === 'all' ? true : state === 'some' ? 'mixed' : false} onClick={() => { startSelecting(); setTicked(ids, state !== 'all'); }}>✓</button>
  );
}

/** Photos grouped by month, newest first, rendered in chunks as you scroll. */
export function MonthGrid({ items, onOpen, onBroken }: { items: Item[]; onOpen: (list: Item[], i: number) => void; onBroken?: (it: Item) => void }) {
  const sorted = useMemo(() => [...items].sort((a, b) => (b.takenAt ?? '').localeCompare(a.takenAt ?? '')), [items]);
  const order = useMemo(() => sorted.map((x) => x.id), [sorted]);
  useShownList(order);
  const selecting = useSelecting();
  // Every photo of each month, also the ones not drawn yet, so a month's tick takes the whole month.
  const byMonth = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const it of sorted) { const k = it.takenAt?.slice(0, 7) ?? 'unknown'; const a = m.get(k); a ? a.push(it.id) : m.set(k, [it.id]); }
    return m;
  }, [sorted]);
  const [limit, setLimit] = useState(400);
  const sentinel = useRef<HTMLDivElement>(null);
  useEffect(() => setLimit(400), [items]);
  useEffect(() => {
    const el = sentinel.current;
    if (!el) return;
    const io = new IntersectionObserver((es) => es[0].isIntersecting && setLimit((l) => l + 400), { rootMargin: '800px' });
    io.observe(el);
    return () => io.disconnect();
  }, [sorted.length]);
  const groups = useMemo(() => {
    const out: { key: string; items: Item[]; start: number }[] = [];
    sorted.slice(0, limit).forEach((it, idx) => {
      const k = it.takenAt?.slice(0, 7) ?? 'unknown';
      const last = out[out.length - 1];
      if (last && last.key === k) last.items.push(it);
      else out.push({ key: k, items: [it], start: idx });
    });
    return out;
  }, [sorted, limit]);
  if (!items.length) return <p className="muted">No photos match. Try clearing the filters.</p>;
  return (
    <div>
      {groups.map((g) => {
        const label = g.key === 'unknown' ? 'No date' : monthLabel(g.key);
        const all = byMonth.get(g.key) ?? [];
        return (
          <section className={`month${selecting ? ' selecting' : ''}`} key={g.key + g.start}>
            <h2><MonthTick ids={all} label={label} />{label} <span>{all.length.toLocaleString()}</span></h2>
            <div className="grid">
              {g.items.map((it, j) => <Thumb key={it.id} item={it} selectable onOpen={() => onOpen(sorted, g.start + j)} onBroken={onBroken} />)}
            </div>
          </section>
        );
      })}
      {limit < sorted.length && <div className="more" ref={sentinel}>Loading more…</div>}
    </div>
  );
}
