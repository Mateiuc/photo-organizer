import { useMemo, useState } from 'react';
import { exactDuplicates, fmtDuration, fmtSize, hasCameraData, lesserCopy, pickKeeper, pickSame, worseReason, type Item } from '../lib/model';
import { coloursDiffer, lookAlikes } from '../pictures/compare';
import type { Similar } from '../pictures/groups';
import { comparable, comparePictures, needsLook, retryFailed, stopComparing, usePictures } from '../pictures/store';
import { Preview } from './Grid';

type Tab = 'exact' | 'same' | 'alike' | 'empty';
const newest = (a: Item[], b: Item[]) => (b[0].takenAt ?? '').localeCompare(a[0].takenAt ?? '');

/** One copy's details, so differences between copies are easy to see. */
function Details({ x, pathOf, why, note, dims }: { x: Item; pathOf: (id?: string) => string; why: string; note?: string; dims?: number[] }) {
  const src = x.takenFrom === 'camera' ? 'camera' : x.takenFrom === 'filename' ? 'file name' : x.takenFrom === 'file' ? 'file date' : 'upload date';
  return (
    <>
      <b>{x.name}</b>
      <span className="muted">{x.gp ? 'Google Photos' : pathOf(x.folderId) || 'Folder outside the scanned folders'}</span>
      {why ? <span className="tag extra">{why}</span> : !hasCameraData(x) && <span className="tag extra">No camera data</span>}
      {note && <span className="tag info">{note}</span>}
      <span>{x.takenAt ? x.takenAt.replace('T', ' ') : 'No date'} <span className="muted">· {src}</span></span>
      <span>{fmtSize(x.size)}{x.width ? ` · ${x.width}×${x.height}` : dims ? ` · ${dims[0]}×${dims[1]}` : ''}{x.durationMs ? ` · ${fmtDuration(x.durationMs)}` : ''}</span>
      {x.kind !== 'video' && <span className="muted">{x.camera ?? 'No camera'} · {x.lat != null ? 'has place' : 'no place'}</span>}
    </>
  );
}

/** Start, pause and progress of "Compare pictures". */
function ComparePanel({ all, readOnly, similar }: { all: Item[]; readOnly: boolean; similar: Similar }) {
  const st = usePictures();
  const photos = useMemo(() => all.filter(comparable), [all]);
  const left = useMemo(() => photos.filter((x) => needsLook(x, st.recs.get(x.id))).length, [photos, st.v]); // eslint-disable-line react-hooks/exhaustive-deps
  const failed = useMemo(() => photos.filter((x) => st.recs.get(x.id)?.x).length, [photos, st.v]); // eslint-disable-line react-hooks/exhaustive-deps
  const r = st.run;
  if (!st.loaded) return <div className="panel"><span className="muted">Opening the picture comparison…</span></div>;
  return (
    <div className="panel">
      {r.running ? (
        <>
          <div className="stats"><div><b>{r.done.toLocaleString()}</b><span>of {r.total.toLocaleString()} photos compared</span></div></div>
          <div className="progress"><i style={{ width: `${r.total ? (100 * r.done) / r.total : 0}%` }} /></div>
          <div className="muted">Looking at “{r.current ?? '…'}”. The sets below update every half minute. You can keep using the app meanwhile.</div>
          <div className="row"><button className="btn" onClick={stopComparing}>Pause</button></div>
        </>
      ) : (
        <>
          {left > 0 && <p className="muted">To find copies that aren't identical files, the app compares the pictures themselves, with an AI picture model from Google (MediaPipe). It looks at a small copy of each photo once, on this computer: no photo is sent anywhere. What it learns is kept in this browser and in your backup.</p>}
          <div className="row">
            {left > 0 && <button className="btn primary" disabled={readOnly && !all.some((x) => x.gp)} onClick={() => comparePictures(all)}>{left < photos.length ? `Compare ${left.toLocaleString()} new photos` : `Compare ${left.toLocaleString()} photos`}</button>}
            {left > 0 && <span className="muted">You can pause and carry on later.</span>}
            {left === 0 && <span className="muted">All {photos.length.toLocaleString()} photos have been compared, on this computer, with an AI picture model.{similar.working ? ' Working out the sets…' : ''}</span>}
            {failed > 0 && <span className="muted">{failed.toLocaleString()} couldn't be read (often HEIC or RAW files the browser can't open). <button className="link" onClick={() => retryFailed()}>Try them again</button></span>}
          </div>
          {readOnly && left > 0 && !all.some((x) => x.gp) && <p className="muted">Open your photos first (Choose photos) so the app can read them.</p>}
        </>
      )}
      {r.error && <p className="notice">{r.error}</p>}
    </div>
  );
}

export function Duplicates({ items, all, similar, pathOf, onTrash, onOpen, readOnly, local }: {
  items: Item[]; all: Item[]; similar: Similar; pathOf: (id?: string) => string; onTrash: (list: Item[]) => void; onOpen: (list: Item[], i: number) => void; readOnly: boolean; local?: boolean;
}) {
  // Google Photos copies go to Google Photos' Trash through the helper add-on; files in a folder or Drive need it open.
  const canRemove = (x: Item) => !!x.gp || !readOnly;
  const [tab, setTab] = useState<Tab>('exact');
  const pics = usePictures();
  const [alike, setAlike] = useState(() => { try { return Number(localStorage.getItem('po.alike')) || 90; } catch { return 90; } });
  const shownIds = useMemo(() => new Set(items.map((x) => x.id)), [items]);
  const inView = (gs: Item[][]) => gs.map((g) => g.filter((x) => shownIds.has(x.id))).filter((g) => g.length > 1);
  const exact = useMemo(() => exactDuplicates(items), [items]);
  const same = useMemo(() => inView(similar.same).sort(newest), [similar.same, shownIds]); // eslint-disable-line react-hooks/exhaustive-deps
  const alikeGroups = useMemo(() => inView(lookAlikes(similar.pairs, alike / 100).map((g) => g.map((i) => similar.byIndex[i]).sort((a, b) => (a.takenAt ?? '').localeCompare(b.takenAt ?? '')))).sort(newest), [similar.pairs, similar.byIndex, alike, shownIds]); // eslint-disable-line react-hooks/exhaustive-deps
  // Google Photos items whose size isn't known yet also show 0 bytes, so they never count as empty.
  const empty = useMemo(() => { const e = items.filter((x) => x.size === 0 && !x.gp); return e.length ? [e] : []; }, [items]);
  const groups = tab === 'exact' ? exact : tab === 'same' ? same : tab === 'alike' ? alikeGroups : empty;
  const rec = (x: Item) => pics.recs.get(x.id);
  // Picture size: from the file's own data, or else as measured when the picture was compared.
  const dims = (x: Item) => { const r = rec(x); return !x.width && r?.pw && r.ph ? [r.pw, r.ph] : undefined; };
  const pixels = (x: Item) => (x.width && x.height ? x.width * x.height : (rec(x)?.pw ?? 0) * (rec(x)?.ph ?? 0));
  const keeperOf = (g: Item[]) => (tab === 'same' ? pickSame(g, pathOf, pixels) : pickKeeper(g, pathOf));
  const edited = (x: Item, keep: Item) => { const a = rec(x)?.c, b = rec(keep)?.c; return x !== keep && !!a && !!b && coloursDiffer(a, b); };
  const reason = (x: Item, keep: Item) => {
    if (tab === 'alike' || tab === 'empty' || x === keep) return '';
    if (tab === 'same' && edited(x, keep)) return '';
    return worseReason(x, keep, pathOf) || (tab === 'same' ? lesserCopy(x, keep, pixels) : '');
  };

  // What the app suggests removing. Identical files: all but the best one. Same photo: only copies that are clearly
  // worse than the one kept. Look-alikes: nothing; that's for you to choose.
  const suggested = useMemo(() => {
    const out = new Set<string>();
    if (tab === 'empty') { groups.flat().forEach((x) => out.add(x.id)); return out; }
    if (tab === 'alike') return out;
    for (const g of groups) {
      const keep = keeperOf(g);
      // A Google Photos copy is only suggested when the copy kept is in Google Photos too; otherwise it's your choice.
      const ok = (x: Item) => canRemove(x) && (!x.gp || !!keep.gp);
      if (tab === 'exact') g.forEach((x) => x !== keep && ok(x) && out.add(x.id));
      else g.forEach((x) => ok(x) && reason(x, keep) && out.add(x.id));
    }
    return out;
  }, [groups, pathOf, tab, pics.v]); // eslint-disable-line react-hooks/exhaustive-deps
  const [changed, setChanged] = useState<Map<string, boolean>>(new Map());
  const isOut = (x: Item) => canRemove(x) && (changed.get(x.id) ?? suggested.has(x.id));
  const toggle = (x: Item, g: Item[]) => {
    const next = !isOut(x);
    if (next && tab !== 'empty' && g.filter((y) => y !== x).every(isOut)) return; // always keep at least one copy
    setChanged((m) => new Map(m).set(x.id, next));
  };
  const keepSharpest = (g: Item[]) => {
    const best = g.reduce((a, b) => ((rec(b)?.sh ?? 0) > (rec(a)?.sh ?? 0) ? b : a));
    setChanged((m) => { const n = new Map(m); g.forEach((x) => n.set(x.id, x !== best)); return n; });
  };

  const chosen = groups.flatMap((g) => g.filter(isOut));
  const space = chosen.reduce((s, x) => s + x.size, 0);
  const [limit, setLimit] = useState(60);
  const go = (t: Tab) => { setTab(t); setLimit(60); };
  const extras = (gs: Item[][]) => gs.reduce((s, g) => s + g.length - 1, 0);

  return (
    <div className="stack" style={{ maxWidth: 'none' }}>
      <div className="row">
        <button className={`chip ${tab === 'exact' ? 'on' : ''}`} onClick={() => go('exact')}>Identical files · {exact.length.toLocaleString()}</button>
        <button className={`chip ${tab === 'same' ? 'on' : ''}`} onClick={() => go('same')}>Same photo · {same.length.toLocaleString()}</button>
        <button className={`chip ${tab === 'alike' ? 'on' : ''}`} onClick={() => go('alike')}>Look-alikes · {alikeGroups.length.toLocaleString()}</button>
        {empty.length > 0 && <button className={`chip ${tab === 'empty' ? 'on' : ''}`} onClick={() => go('empty')}>Empty files · {empty[0].length.toLocaleString()}</button>}
      </div>
      {(tab === 'same' || tab === 'alike') && <ComparePanel all={all} readOnly={readOnly} similar={similar} />}
      <div className="panel">
        <div className="stats">
          <div><b>{groups.length.toLocaleString()}</b><span>sets</span></div>
          {tab !== 'alike' && tab !== 'empty' && <div><b>{extras(groups).toLocaleString()}</b><span>extra copies</span></div>}
          <div><b>{chosen.length.toLocaleString()}</b><span>marked to remove</span></div>
          <div><b>{fmtSize(space)}</b><span>you'd free</span></div>
        </div>
        {tab === 'empty' ? (
          <p className="muted">These files are empty (0 bytes): there is no photo or video inside, usually because an upload or copy failed. They can't be opened and are safe to remove. Click any file to keep it.</p>
        ) : tab === 'exact' ? (
          <p className="muted">For videos, the preview picture can come from a different moment in each copy, so two identical videos may show different pictures. {local ? 'These files have identical content, checked with a fingerprint of each file.' : "These files are byte-for-byte identical, checked with Google Drive's own fingerprint of each file."} The app keeps the copy with the most camera data (date, place, camera). Copies are marked to remove when they lost camera data, sit in a folder for another date (like a 2020 photo in “2017-07”), or have a copy-style name (like “photo (1).jpg”). Click any copy's button to change what is kept.</p>
        ) : tab === 'same' ? (
          <p className="muted">The same photo, found by comparing the pictures themselves (not the names): one copy was made smaller, re-saved, sent through a chat app, turned sideways, or had its colours changed. The files are <b>not identical</b>. A copy is marked to remove only when another copy is clearly better: a bigger picture, still has camera data, in the folder for its date, or the original name. Copies with different colours are never marked, because one may be an edit you want. Click any copy's button to change what is kept.</p>
        ) : (
          <>
            <p className="muted">Photos taken close together (within a day) that look very alike: bursts, retakes, a cropped copy. They are <b>different photos</b>, so nothing is marked: open them, pick the ones to remove, or use “Keep only the sharpest”. Move the slider to the left to find more sets that are less alike, or to the right for only very close ones.</p>
            <label className="row slider">How alike: <input type="range" min={80} max={98} step={1} value={alike} onChange={(e) => { const v = Number(e.target.value); setAlike(v); try { localStorage.setItem('po.alike', String(v)); } catch { /* only a convenience */ } }} /> <b>{alike}%</b></label>
          </>
        )}
        {groups.some((g) => g.some((x) => x.gp)) && <p className="muted" style={{ margin: 0 }}>Google Photos copies can be removed too: they go to Google Photos' Trash (restorable for 60 days). The app only suggests removing a Google Photos copy when the copy it keeps is also in Google Photos; otherwise click it yourself.</p>}
        {groups.some((g) => g.some(canRemove)) && <div className="row"><button className="btn danger" disabled={!chosen.length} onClick={() => onTrash(chosen)}>Move {chosen.length.toLocaleString()} marked {chosen.length === 1 ? 'copy' : 'copies'} to the trash…</button><span className="muted">You'll see them and where they go before anything moves.</span></div>}
      </div>
      {!groups.length && <p className="muted">{tab === 'exact' ? 'No identical files found.' : tab === 'same' ? (similar.compared ? 'No other copies of the same photo found so far.' : 'Compare the pictures first.') : tab === 'alike' ? (similar.compared ? 'No look-alikes at this setting.' : 'Compare the pictures first.') : ''}</p>}
      {groups.slice(0, limit).map((g0) => {
        const keep = keeperOf(g0);
        const g = tab === 'exact' || tab === 'same' ? [keep, ...g0.filter((x) => x !== keep)] : g0; // the copy kept comes first
        const sharpest = tab === 'alike' ? g.reduce((a, b) => ((rec(b)?.sh ?? 0) > (rec(a)?.sh ?? 0) ? b : a)) : undefined;
        return (
          <section className="dup" key={g0.map((x) => x.id).join('|')}>
            <div className="row">
              <h3>{tab === 'empty' ? `${g.length} empty files` : tab === 'alike' ? `${g.length} look-alikes` : `${g.length} copies${tab === 'exact' ? ` · ${fmtSize(g[0].size)} each` : ''}`}</h3>
              {tab === 'alike' && g.some(canRemove) && <button className="btn small" onClick={() => keepSharpest(g)}>Keep only the sharpest</button>}
            </div>
            <div className="grid">
              {g.map((x) => {
                const out = isOut(x);
                const last = tab !== 'empty' && !out && g.filter((y) => y !== x).every(isOut);
                const note = tab === 'same' && edited(x, keep) ? 'colours differ: an edit?' : x === sharpest ? 'sharpest' : undefined;
                return (
                  <div className={`dcard ${out ? 'extra' : 'keep'}`} key={x.id}>
                    <button className="tile" style={{ borderRadius: 0 }} onClick={() => onOpen(g, g.indexOf(x))}><Preview item={x} /></button>
                    <div className="meta">
                      {canRemove(x)
                        ? <button className={`pick ${out ? 'extra' : 'keep'}`} disabled={last} title={last ? 'At least one copy is always kept' : undefined} onClick={() => toggle(x, g)}>{out ? '✕ Remove' : '✓ Keep'}</button>
                        : <span className="pick keep" title="Open your photos first (Choose photos) to remove copies">✓ Keep</span>}
                      <Details x={x} pathOf={pathOf} why={reason(x, keep)} note={note} dims={dims(x)} />
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        );
      })}
      {limit < groups.length && <button className="btn" onClick={() => setLimit((l) => l + 60)}>Show more sets</button>}
    </div>
  );
}
