import { useMemo, useState } from 'react';
import { exactDuplicates, fmtSize, pickKeeper, sizedThumb, type Item } from '../lib/model';

export function Duplicates({ items, pathOf, onTrash, onOpen, readOnly }: { items: Item[]; pathOf: (id?: string) => string; onTrash: (ids: string[]) => Promise<void>; onOpen: (list: Item[], i: number) => void; readOnly: boolean }) {
  const groups = useMemo(() => exactDuplicates(items).map((g) => ({ g, keep: pickKeeper(g, pathOf) })), [items, pathOf]);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState('');
  const extras = groups.flatMap(({ g, keep }) => g.filter((x) => x !== keep));
  const space = extras.reduce((s, x) => s + x.size, 0);
  const [limit, setLimit] = useState(60);
  if (!groups.length) return <p className="muted">No exact copies found. Look-alike photos (same scene, different file) come with the AI stage.</p>;
  return (
    <div className="stack" style={{ maxWidth: 'none' }}>
      <div className="panel">
        <div className="stats">
          <div><b>{groups.length.toLocaleString()}</b><span>sets of identical files</span></div>
          <div><b>{extras.length.toLocaleString()}</b><span>extra copies</span></div>
          <div><b>{fmtSize(space)}</b><span>you'd free</span></div>
        </div>
        <p className="muted">These files are byte-for-byte identical, as checked by Google Drive's own file fingerprint. In each set, one copy is kept: not the WhatsApp one, preferably the one in a folder named for the photo's month (like 2015-08), then the one with a camera date, then the one in the most specific folder.</p>
        {!readOnly && !confirm && <div className="row"><button className="btn danger" disabled={!!busy} onClick={() => setConfirm(true)}>Move {extras.length.toLocaleString()} extra copies to Drive trash</button><span className="muted">{busy}</span></div>}
        {confirm && (
          <div className="confirm">
            <span>Move {extras.length.toLocaleString()} files ({fmtSize(space)}) to your Google Drive trash? You can restore them from the trash for 30 days.</span>
            <div className="row">
              <button className="btn danger" onClick={async () => { setConfirm(false); setBusy('Moving to trash…'); try { await onTrash(extras.map((x) => x.id)); setBusy('Done.'); } catch (e) { setBusy(String((e as Error).message)); } }}>Yes, move to trash</button>
              <button className="btn" onClick={() => setConfirm(false)}>Cancel</button>
            </div>
          </div>
        )}
      </div>
      {groups.slice(0, limit).map(({ g, keep }) => (
        <section className="dup" key={g[0].md5}>
          <h3>{g.length} copies · {fmtSize(g[0].size)} each</h3>
          <div className="grid">
            {g.map((x) => (
              <div className={`dcard ${x === keep ? 'keep' : 'extra'}`} key={x.id}>
                <button className="tile" style={{ borderRadius: 0 }} onClick={() => onOpen(g, g.indexOf(x))}>{x.thumb ? <img src={sizedThumb(x.thumb, 320)} alt="" loading="lazy" referrerPolicy="no-referrer" /> : <span className="ph">{x.name}</span>}</button>
                <div className="meta"><span className={`tag ${x === keep ? 'keep' : 'extra'}`}>{x === keep ? 'keep' : 'extra copy'}</span><b>{x.name}</b><span className="muted">{pathOf(x.folderId)}</span></div>
              </div>
            ))}
          </div>
        </section>
      ))}
      {limit < groups.length && <button className="btn" onClick={() => setLimit((l) => l + 60)}>Show more sets</button>}
    </div>
  );
}
