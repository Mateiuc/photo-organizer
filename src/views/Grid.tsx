import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { fmtDuration, monthLabel, thumbUrl, type Item } from '../lib/model';
import { useLocalThumb } from '../local/thumbs';
import { directFailed, helperPicture, viaHelperOnly } from '../gphotos/api';

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

export function Thumb({ item, onOpen, onBroken }: { item: Item; onOpen: () => void; onBroken?: (it: Item) => void }) {
  return (
    <button className="tile" onClick={onOpen} title={item.name} aria-label={`Open ${item.name}`}>
      <Preview item={item} onBroken={onBroken} />
      {item.kind === 'video' && <span className="badge">▶ {fmtDuration(item.durationMs)}</span>}
      {item.kind === 'raw' && <span className="badge">RAW</span>}
    </button>
  );
}

/** Photos grouped by month, newest first, rendered in chunks as you scroll. */
export function MonthGrid({ items, onOpen, onBroken }: { items: Item[]; onOpen: (list: Item[], i: number) => void; onBroken?: (it: Item) => void }) {
  const sorted = useMemo(() => [...items].sort((a, b) => (b.takenAt ?? '').localeCompare(a.takenAt ?? '')), [items]);
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
      {groups.map((g) => (
        <section className="month" key={g.key + g.start}>
          <h2>{g.key === 'unknown' ? 'No date' : monthLabel(g.key)} <span>{g.items.length.toLocaleString()}</span></h2>
          <div className="grid">
            {g.items.map((it, j) => <Thumb key={it.id} item={it} onOpen={() => onOpen(sorted, g.start + j)} onBroken={onBroken} />)}
          </div>
        </section>
      ))}
      {limit < sorted.length && <div className="more" ref={sentinel}>Loading more…</div>}
    </div>
  );
}
