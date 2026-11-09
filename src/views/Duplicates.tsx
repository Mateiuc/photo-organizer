import { useMemo, useState } from 'react';
import { exactDuplicates, fmtDuration, fmtSize, hasCameraData, pickKeeper, possibleCopies, type Item } from '../lib/model';
import { Preview } from './Grid';

type Tab = 'exact' | 'maybe';

/** One copy's details, so differences between copies are easy to see. */
function Details({ x, pathOf }: { x: Item; pathOf: (id?: string) => string }) {
  const src = x.takenFrom === 'camera' ? 'camera' : x.takenFrom === 'filename' ? 'file name' : x.takenFrom === 'file' ? 'file date' : 'upload date';
  return (
    <>
      <b>{x.name}</b>
      <span className="muted">{pathOf(x.folderId) || 'Folder outside the scanned folders'}</span>
      {!hasCameraData(x) && <span className="tag extra">No camera data</span>}
      <span>{x.takenAt ? x.takenAt.replace('T', ' ') : 'No date'} <span className="muted">· {src}</span></span>
      <span>{fmtSize(x.size)}{x.width ? ` · ${x.width}×${x.height}` : ''}{x.durationMs ? ` · ${fmtDuration(x.durationMs)}` : ''}</span>
      {x.kind !== 'video' && <span className="muted">{x.camera ?? 'No camera'} · {x.lat != null ? 'has place' : 'no place'}</span>}
    </>
  );
}

export function Duplicates({ items, pathOf, onTrash, onOpen, readOnly, local }: { items: Item[]; pathOf: (id?: string) => string; onTrash: (ids: string[]) => Promise<void>; onOpen: (list: Item[], i: number) => void; readOnly: boolean; local?: boolean }) {
  const [tab, setTab] = useState<Tab>('exact');
  const exact = useMemo(() => exactDuplicates(items), [items]);
  const maybe = useMemo(() => possibleCopies(items), [items]);
  const groups = tab === 'exact' ? exact : maybe;

  // What the app suggests removing. Exact copies: all but the best one. Possible copies: only the ones that lost
  // their camera data while another copy still has it; the rest is left for you to decide.
  const suggested = useMemo(() => {
    const out = new Set<string>();
    for (const g of groups) {
      const keep = pickKeeper(g, pathOf);
      if (tab === 'exact') g.forEach((x) => x !== keep && out.add(x.id));
      else if (g.some(hasCameraData)) g.forEach((x) => !hasCameraData(x) && out.add(x.id));
    }
    return out;
  }, [groups, pathOf, tab]);
  const [changed, setChanged] = useState<Map<string, boolean>>(new Map());
  const isOut = (x: Item) => changed.get(x.id) ?? suggested.has(x.id);
  const toggle = (x: Item, g: Item[]) => {
    const next = !isOut(x);
    if (next && g.filter((y) => y !== x).every(isOut)) return; // always keep at least one copy
    setChanged((m) => new Map(m).set(x.id, next));
  };

  const chosen = groups.flatMap((g) => g.filter(isOut));
  const space = chosen.reduce((s, x) => s + x.size, 0);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState('');
  const [limit, setLimit] = useState(60);
  const where = local ? 'the _Trash folder' : 'Drive trash';

  return (
    <div className="stack" style={{ maxWidth: 'none' }}>
      <div className="row">
        <button className={`chip ${tab === 'exact' ? 'on' : ''}`} onClick={() => { setTab('exact'); setLimit(60); setConfirm(false); }}>Identical files · {exact.length.toLocaleString()}</button>
        <button className={`chip ${tab === 'maybe' ? 'on' : ''}`} onClick={() => { setTab('maybe'); setLimit(60); setConfirm(false); }}>Possible copies · {maybe.length.toLocaleString()}</button>
      </div>
      <div className="panel">
        <div className="stats">
          <div><b>{groups.length.toLocaleString()}</b><span>sets</span></div>
          <div><b>{chosen.length.toLocaleString()}</b><span>marked to remove</span></div>
          <div><b>{fmtSize(space)}</b><span>you'd free</span></div>
        </div>
        {tab === 'exact' ? (
          <p className="muted">For videos, the preview picture can come from a different moment in each copy, so two identical videos may show different pictures. {local ? 'These files have identical content, checked with a fingerprint of each file.' : "These files are byte-for-byte identical, checked with Google Drive's own fingerprint of each file."} The app keeps the copy with the most camera data (date, place, camera), then the one not in WhatsApp, then the one in a folder named for the photo's month. Click any copy's button to change what is kept.</p>
        ) : (
          <p className="muted">These are probably the same photo, but the files are <b>not identical</b>. They have the same file name, or the same camera moment and picture size. Often one copy was re-saved, made smaller, or lost its camera data. Copies without camera data are marked to remove when another copy still has it. Everything else is up to you: open the photos and click to choose.</p>
        )}
        {!readOnly && !confirm && <div className="row"><button className="btn danger" disabled={!!busy || !chosen.length} onClick={() => setConfirm(true)}>Move {chosen.length.toLocaleString()} marked {chosen.length === 1 ? 'file' : 'files'} to {where}</button><span className="muted">{busy}</span></div>}
        {confirm && (
          <div className="confirm">
            <span>Move {chosen.length.toLocaleString()} files ({fmtSize(space)}) {local ? "into the _Trash folder inside your photo folder? Nothing is deleted; you can check them there and delete the folder when you're sure." : 'to your Google Drive trash? You can restore them from the trash for 30 days.'}</span>
            <div className="row">
              <button className="btn danger" onClick={async () => { setConfirm(false); setBusy('Moving…'); try { await onTrash(chosen.map((x) => x.id)); setBusy('Done.'); } catch (e) { setBusy(String((e as Error).message)); } }}>Yes, move them</button>
              <button className="btn" onClick={() => setConfirm(false)}>Cancel</button>
            </div>
          </div>
        )}
      </div>
      {!groups.length && <p className="muted">{tab === 'exact' ? 'No identical files found.' : 'No possible copies found.'}</p>}
      {groups.slice(0, limit).map((g) => (
        <section className="dup" key={g.map((x) => x.id).join('|')}>
          <h3>{g.length} copies{tab === 'exact' ? ` · ${fmtSize(g[0].size)} each` : ''}</h3>
          <div className="grid">
            {g.map((x) => {
              const out = isOut(x);
              const last = !out && g.filter((y) => y !== x).every(isOut);
              return (
                <div className={`dcard ${out ? 'extra' : 'keep'}`} key={x.id}>
                  <button className="tile" style={{ borderRadius: 0 }} onClick={() => onOpen(g, g.indexOf(x))}><Preview item={x} /></button>
                  <div className="meta">
                    <button className={`pick ${out ? 'extra' : 'keep'}`} disabled={last} title={last ? 'At least one copy is always kept' : undefined} onClick={() => toggle(x, g)}>{out ? '✕ Remove' : '✓ Keep'}</button>
                    <Details x={x} pathOf={pathOf} />
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      ))}
      {limit < groups.length && <button className="btn" onClick={() => setLimit((l) => l + 60)}>Show more sets</button>}
    </div>
  );
}
