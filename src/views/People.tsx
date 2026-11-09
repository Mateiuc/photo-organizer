import { useEffect, useMemo, useRef, useState } from 'react';
import type { Item } from '../lib/model';
import { findFaces, forgetAll, mergeInto, nameAs, rename, splitFace, stop, usePeople, type Undo } from '../faces/people';
import { centre, closest, LIKELY, SURE, type Person } from '../faces/cluster';
import { MonthGrid, Preview } from './Grid';

interface Group { id: string; p: Person; faces: string[]; items: Set<string> }
interface Cand { id: string; c: Float32Array; g: Group }
const photos = (g: Group) => `${g.items.size.toLocaleString()} photo${g.items.size === 1 ? '' : 's'}`;
const label = (g: Group) => g.p.name ?? photos(g);
const hint = (d: number) => (d < SURE ? 'very likely' : d < LIKELY ? 'maybe' : 'unlikely');

/** Pick any person from a short searchable list: named people first, then the biggest groups. */
function Picker({ target, groups, cover, onPick, onClose }: { target: Group; groups: Group[]; cover: (g: Group) => string | undefined; onPick: (g: Group) => void; onClose: () => void }) {
  const [q, setQ] = useState('');
  const list = useMemo(() => {
    const t = q.trim().toLowerCase();
    return groups.filter((g) => g.id !== target.id && (t ? g.p.name?.toLowerCase().includes(t) : g.p.name || g.items.size >= 2))
      .sort((a, b) => Number(!!b.p.name) - Number(!!a.p.name) || (a.p.name && b.p.name ? a.p.name.localeCompare(b.p.name) : b.items.size - a.items.size)).slice(0, 60);
  }, [q, groups, target]);
  useEffect(() => { const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose(); window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k); }, [onClose]);
  return (
    <div className="pick-wrap" onClick={onClose}>
      <div className="panel picker" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Same person as">
        <div className="row" style={{ justifyContent: 'space-between' }}><b>Same person as…</b><button className="btn small" onClick={onClose}>Close</button></div>
        <input type="search" autoFocus placeholder="Type a name" value={q} onChange={(e) => setQ(e.target.value)} />
        <div className="pick-list">
          {list.map((g) => (
            <button key={g.id} className="pick-person" onClick={() => onPick(g)}>
              {cover(g) ? <img className="face" src={cover(g)} alt="" /> : <span className="face" />}
              <span>{g.p.name ?? 'Unnamed'}</span><span className="muted">{g.items.size.toLocaleString()}</span>
            </button>
          ))}
          {!list.length && <span className="muted">No one by that name yet. Open the face and type the name there.</span>}
        </div>
      </div>
    </div>
  );
}

/** One unnamed face at a time with the 3 closest people: press 1, 2 or 3 to join, S to skip, Z to undo. */
function Review({ groups, cands, byId, faceOf, cover, onJoin, onName, onUndo, canUndo, onClose }: {
  groups: Group[]; cands: Cand[]; byId: Map<string, Item>; faceOf: (g: Group) => { itemId: string } | undefined; cover: (g: Group) => string | undefined;
  onJoin: (from: Group, into: Group) => void; onName: (g: Group, name: string) => void; onUndo: () => void; canUndo: boolean; onClose: () => void;
}) {
  const [skipped, setSkipped] = useState<Set<string>>(new Set());
  const queue = useMemo(() => groups.filter((g) => !g.p.name && !skipped.has(g.id)).sort((a, b) => b.items.size - a.items.size), [groups, skipped]);
  const cur = queue[0];
  const opts = useMemo(() => (cur ? closest(cands, centre(cur.p), 3, (x) => x.id === cur.id) : []), [cur, cands]);
  const names = useMemo(() => groups.filter((g) => g.p.name).map((g) => g.p.name!).sort(), [groups]);
  const [name, setName] = useState('');
  useEffect(() => setName(''), [cur?.id]);
  const skip = () => cur && setSkipped((s) => new Set(s).add(cur.id));
  const keys = useRef({ opts, cur, skip, onJoin, onUndo, onClose });
  keys.current = { opts, cur, skip, onJoin, onUndo, onClose };
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      const { opts, cur, skip, onJoin, onUndo, onClose } = keys.current;
      if (e.key === 'Escape') { onClose(); return; }
      if ((e.target as HTMLElement)?.tagName === 'INPUT' || e.ctrlKey || e.metaKey || e.altKey) return;
      const n = '123'.indexOf(e.key);
      if (n >= 0 && cur && opts[n]) { e.preventDefault(); onJoin(cur, opts[n].c.g); }
      else if (e.key === 's' || e.key === 'S' || e.key === 'ArrowRight') { e.preventDefault(); skip(); }
      else if (e.key === 'z' || e.key === 'Z' || e.key === 'Backspace') { e.preventDefault(); onUndo(); }
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, []);
  const photo = cur && byId.get(faceOf(cur)?.itemId ?? '');
  return (
    <div className="panel review">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <b>Sort out faces · {queue.length.toLocaleString()} unnamed left</b>
        <button className="btn" onClick={onClose}>Done (Esc)</button>
      </div>
      {!cur ? <p className="muted">All faces have a name or were skipped. Nice work.</p> : (
        <div className="review-body">
          <div className="review-face">
            {cover(cur) ? <img className="face huge" src={cover(cur)} alt="" /> : <span className="face huge" />}
            {photo && <div className="tile review-photo"><Preview item={photo} px={480} /></div>}
            <span className="muted">{label(cur)}</span>
            <form className="row" onSubmit={(e) => { e.preventDefault(); if (name.trim()) { onName(cur, name); (document.activeElement as HTMLElement)?.blur(); } }}>
              <input type="text" list="known-names" placeholder="Or type who it is" value={name} onChange={(e) => setName(e.target.value)} style={{ width: 180 }} />
              <button className="btn" disabled={!name.trim()}>Name</button>
              <datalist id="known-names">{names.map((n) => <option key={n} value={n} />)}</datalist>
            </form>
          </div>
          <div className="review-opts">
            <span className="muted">Is this the same person as…</span>
            {opts.map((o, i) => (
              <button key={o.c.id} className={`review-opt ${o.dist < SURE ? 'sure' : o.dist >= LIKELY ? 'weak' : ''}`} onClick={() => onJoin(cur, o.c.g)}>
                <kbd>{i + 1}</kbd>
                {cover(o.c.g) ? <img className="face" src={cover(o.c.g)} alt="" /> : <span className="face" />}
                <span className="stack" style={{ gap: 2, textAlign: 'left' }}><b>{o.c.g.p.name ?? 'Unnamed'}</b><span className="muted">{photos(o.c.g)} · {hint(o.dist)}</span></span>
              </button>
            ))}
            <div className="row">
              <button className="btn" onClick={skip}><kbd>S</kbd> Not sure, skip</button>
              <button className="btn" disabled={!canUndo} onClick={onUndo}><kbd>Z</kbd> Undo</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export function People({ items, onOpen, readOnly }: { items: Item[]; onOpen: (list: Item[], i: number) => void; readOnly?: boolean }) {
  const st = usePeople();
  const [open, setOpen] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [limit, setLimit] = useState(240);
  const [picking, setPicking] = useState<string | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const [undos, setUndos] = useState<{ text: string; undo: Undo }[]>([]);
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
  }, [st.v, byId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Everyone's average face, for suggesting matches. Cards only suggest people with a name or 2+ photos.
  const cands = useMemo<Cand[]>(() => groups.map((g) => ({ id: g.id, c: Float32Array.from(centre(g.p)), g })), [groups]);
  const solid = useMemo(() => cands.filter((c) => c.g.p.name || c.g.items.size >= 2), [cands]);
  const join = async (from: Group, into: Group) => {
    const undo = await mergeInto(from.id, into.id);
    setUndos((u) => [...u.slice(-49), { text: `Joined with ${into.p.name ?? 'an unnamed person'}`, undo }]);
  };
  const giveName = async (g: Group, name: string) => {
    const undo = await nameAs(g.id, name);
    setUndos((u) => [...u.slice(-49), { text: `Named ${name.trim()}`, undo }]);
  };
  const undoLast = async () => {
    const last = undos[undos.length - 1];
    if (!last) return;
    setUndos((u) => u.slice(0, -1));
    await last.undo();
  };

  const photos = items.filter((x) => x.kind === 'photo' || x.kind === 'raw');
  const left = photos.filter((x) => !st.scanned.has(x.id)).length;
  const r = st.run;
  const shown = groups.filter((g) => showAll || g.p.name || g.items.size >= 3);
  const visible = shown.slice(0, limit);
  const sugg = useMemo(() => new Map(visible.filter((g) => !g.p.name).map((g) => [g.id, closest(solid, centre(g.p), 3, (x) => x.id === g.id).filter((s) => s.dist < LIKELY)])), [visible.map((g) => g.id).join(), solid]); // eslint-disable-line react-hooks/exhaustive-deps
  const undoBar = undos.length > 0 && <div className="undo-bar"><span>{undos[undos.length - 1].text}</span><button className="btn small" onClick={undoLast}>Undo</button></div>;
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
              <select id="pmerge" value="" onChange={(e) => { const into = groups.find((g) => g.id === e.target.value); if (into) { join(person, into); setOpen(into.id); } }}>
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

  const unnamed = groups.filter((g) => !g.p.name).length;
  const pickTarget = picking ? groups.find((g) => g.id === picking) : undefined;
  return (
    <div className="stack" style={{ maxWidth: 'none' }}>
      {status}
      {undoBar}
      {!st.loaded ? <p className="muted">Loading…</p> : groups.length === 0 ? (
        !r.running && <p className="muted">No people yet.</p>
      ) : reviewing ? (
        <Review groups={groups} cands={cands} byId={byId} faceOf={(g) => st.faces.get(g.p.cover) ?? st.faces.get(g.faces[0])} cover={cover} onJoin={join} onName={giveName} onUndo={undoLast} canUndo={undos.length > 0} onClose={() => setReviewing(false)} />
      ) : (
        <>
          {unnamed > 0 && (
            <div className="row">
              <button className="btn primary" onClick={() => setReviewing(true)}>Sort out faces one by one</button>
              <span className="muted">{unnamed.toLocaleString()} unnamed. Or click a suggested face under a card to join it with that person.</span>
            </div>
          )}
          <div className="people">
            {visible.map((g) => {
              const s = sugg.get(g.id) ?? [];
              return (
                <div className="pcard" key={g.id}>
                  <button className="popen" onClick={() => setOpen(g.id)} title="Open this person">
                    {cover(g) ? <img className="face" src={cover(g)} alt="" /> : <span className="face" />}
                    <b>{g.p.name ?? 'Unnamed'}</b>
                    <span className="muted">{g.items.size.toLocaleString()} photo{g.items.size === 1 ? '' : 's'}</span>
                  </button>
                  {s.length > 0 && (
                    <div className="sugg">
                      <span className="muted small">Same as?</span>
                      <div className="row" style={{ gap: 4, justifyContent: 'center' }}>
                        {s.map((x, i) => (
                          <button key={x.c.id} className={`mini ${i === 0 && x.dist < SURE ? 'sure' : ''}`} title={`Same as ${x.c.g.p.name ?? 'this person'} (${label(x.c.g)}, ${hint(x.dist)})`} onClick={() => join(g, x.c.g)}>
                            {cover(x.c.g) ? <img src={cover(x.c.g)} alt={x.c.g.p.name ?? 'Unnamed person'} /> : null}
                          </button>
                        ))}
                      </div>
                      {s[0].c.g.p.name && <span className="muted small">{s[0].c.g.p.name}?</span>}
                    </div>
                  )}
                  <button className="link" onClick={() => setPicking(g.id)}>Same as…</button>
                </div>
              );
            })}
          </div>
          {pickTarget && <Picker target={pickTarget} groups={groups} cover={cover} onPick={(into) => { setPicking(null); join(pickTarget, into); }} onClose={() => setPicking(null)} />}
          <div className="row">
            {visible.length < shown.length && <button className="btn" onClick={() => setLimit((l) => l + 240)}>Show more people</button>}
            {groups.length > shown.length && <button className="btn" onClick={() => setShowAll(true)}>Show {(groups.length - shown.length).toLocaleString()} more faces seen only once or twice</button>}
            {!r.running && st.scanned.size > 0 && <button className="btn" onClick={() => { if (confirm('Forget all faces and names found so far? Your photos are not touched.')) forgetAll(); }}>Start over</button>}
          </div>
        </>
      )}
    </div>
  );
}
