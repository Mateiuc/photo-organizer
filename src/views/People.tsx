import { useMemo, useState } from 'react';
import type { Item } from '../lib/model';
import { findFaces, forgetAll, mergeInto, rename, splitFace, stop, usePeople } from '../faces/people';
import { MonthGrid } from './Grid';

export function People({ items, onOpen, readOnly }: { items: Item[]; onOpen: (list: Item[], i: number) => void; readOnly?: boolean }) {
  const st = usePeople();
  const [open, setOpen] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const byId = useMemo(() => new Map(items.map((x) => [x.id, x])), [items]);

  // For each person: their faces and the photos they're in (only photos currently shown, so filters apply).
  const groups = useMemo(() => {
    const m = new Map<string, { faces: string[]; items: Set<string> }>();
    for (const f of st.faces.values()) {
      if (!byId.has(f.itemId)) continue;
      const g = m.get(f.person) ?? { faces: [], items: new Set() };
      g.faces.push(f.key); g.items.add(f.itemId);
      m.set(f.person, g);
    }
    return [...m.entries()]
      .map(([id, g]) => ({ id, p: st.people.get(id)!, ...g }))
      .filter((x) => x.p)
      .sort((a, b) => Number(!!b.p.name) - Number(!!a.p.name) || b.items.size - a.items.size);
  }, [st.faces, st.people, byId, st.run.done]); // eslint-disable-line react-hooks/exhaustive-deps

  const photos = items.filter((x) => x.kind === 'photo' || x.kind === 'raw');
  const left = photos.filter((x) => !st.scanned.has(x.id)).length;
  const r = st.run;
  const shown = groups.filter((g) => showAll || g.p.name || g.items.size >= 3);
  const person = open ? groups.find((g) => g.id === open) : undefined;
  const cover = (g: (typeof groups)[number]) => st.faces.get(g.p.cover)?.crop ?? st.faces.get(g.faces[0])?.crop;

  const status = (
    <div className="panel">
      {r.running ? (
        <>
          <div className="stats"><div><b>{r.done.toLocaleString()}</b><span>of {r.total.toLocaleString()} photos looked at</span></div><div><b>{groups.length.toLocaleString()}</b><span>people so far</span></div></div>
          <div className="muted">Looking at “{r.current ?? '…'}”. You can keep using the app meanwhile; it carries on if you switch tabs inside the app.</div>
          <div className="row"><button className="btn" onClick={stop}>Pause</button></div>
        </>
      ) : (
        <>
          <p className="muted">The app finds faces in your photos and groups the same face together. This runs on this computer only: no photo or face is sent anywhere. Give each person a name once, then search for them by name in Photos.</p>
          <div className="row">
            {left > 0 && <button className="btn primary" disabled={readOnly} onClick={() => findFaces(photos)}>{st.scanned.size ? `Look at ${left.toLocaleString()} new photos` : `Find faces in ${left.toLocaleString()} photos`}</button>}
            {left === 0 && <span className="muted">All {photos.length.toLocaleString()} photos have been looked at.</span>}
            {left > 0 && <span className="muted">About {Math.max(1, Math.round(left * 0.35 / 60)).toLocaleString()} min on a typical PC. You can pause and carry on later.</span>}
          </div>
          {readOnly && <p className="muted">Open your photos first (Choose photos) so the app can read them.</p>}
        </>
      )}
      {r.slow && <p className="notice">Google Drive doesn't let the page read its small previews, so the app downloads each photo to look at it. That's slower and uses more internet. Choosing your Drive folder synced to this PC is much faster.</p>}
      {r.error && <p className="notice">{r.error}</p>}
    </div>
  );

  if (person) {
    const list = [...person.items].map((id) => byId.get(id)!).filter(Boolean);
    const others = groups.filter((g) => g.id !== person.id);
    return (
      <div className="stack" style={{ maxWidth: 'none' }}>
        <div className="row"><button className="btn" onClick={() => setOpen(null)}>← All people</button></div>
        <div className="panel person-head">
          {cover(person) && <img className="face big" src={cover(person)} alt="" />}
          <div className="stack" style={{ gap: 8 }}>
            <label style={{ display: 'grid', gap: 4 }}><span className="muted">Name</span>
              <input type="text" id="pname" defaultValue={person.p.name ?? ''} key={person.id} placeholder="Who is this?" onBlur={(e) => rename(person.id, e.target.value)} onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} />
            </label>
            <label style={{ display: 'grid', gap: 4 }}><span className="muted">Same person as…</span>
              <select id="pmerge" value="" onChange={(e) => { if (e.target.value) { mergeInto(person.id, e.target.value); setOpen(e.target.value); } }}>
                <option value="">Choose to join them</option>
                {others.filter((g) => g.p.name).map((g) => <option key={g.id} value={g.id}>{g.p.name} ({g.items.size})</option>)}
                {others.filter((g) => !g.p.name && g.items.size >= 2).slice(0, 200).map((g) => <option key={g.id} value={g.id}>Unnamed · {g.items.size} photos</option>)}
              </select>
            </label>
            <span className="muted">{list.length.toLocaleString()} photos</span>
          </div>
        </div>
        <div className="panel">
          <h2 style={{ marginTop: 0 }}>Faces</h2>
          <p className="muted">Click ✕ on a face that isn't this person.</p>
          <div className="faces">
            {person.faces.slice(0, 300).map((k) => (
              <div className="facebox" key={k}>
                <img className="face" src={st.faces.get(k)?.crop} alt="" />
                {person.faces.length > 1 && <button className="x" title="Not this person" aria-label="Not this person" onClick={() => splitFace(k)}>✕</button>}
              </div>
            ))}
          </div>
        </div>
        <MonthGrid items={list} onOpen={onOpen} />
      </div>
    );
  }

  return (
    <div className="stack" style={{ maxWidth: 'none' }}>
      {status}
      {!st.loaded ? <p className="muted">Loading…</p> : groups.length === 0 ? (
        !r.running && <p className="muted">No people yet.</p>
      ) : (
        <>
          <div className="people">
            {shown.map((g) => (
              <button className="pcard" key={g.id} onClick={() => setOpen(g.id)}>
                {cover(g) ? <img className="face" src={cover(g)} alt="" /> : <span className="face" />}
                <b>{g.p.name ?? 'Unnamed'}</b>
                <span className="muted">{g.items.size.toLocaleString()} photo{g.items.size === 1 ? '' : 's'}</span>
              </button>
            ))}
          </div>
          <div className="row">
            {groups.length > shown.length && <button className="btn" onClick={() => setShowAll(true)}>Show {(groups.length - shown.length).toLocaleString()} more faces seen only once or twice</button>}
            {!r.running && st.scanned.size > 0 && <button className="btn" onClick={() => { if (confirm('Forget all faces and names found so far? Your photos are not touched.')) forgetAll(); }}>Start over</button>}
          </div>
        </>
      )}
    </div>
  );
}
