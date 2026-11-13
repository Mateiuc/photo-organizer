import { useEffect, useMemo, useRef, useState } from 'react';
import type { Item } from '../lib/model';
import { findFaces, forgetAll, mergeInto, mergeMany, nameAs, readAgain, rename, setStranger, splitFace, stop, switchPreview, switchToNew, usePeople, type PeopleState, type Undo } from '../faces/people';
import { BEST, centre, closest, LIKELY, SURE, type Person } from '../faces/cluster';
import { batchesByPerson, isStranger, namedMatches, refOf, type Ref } from '../faces/batches';
import { MonthGrid, Preview } from './Grid';

interface Group { id: string; p: Person; faces: string[]; items: Set<string> }
interface Cand { id: string; c: Float32Array; g: Group }
const photos = (g: Group) => `${g.items.size.toLocaleString()} photo${g.items.size === 1 ? '' : 's'}`;
const label = (g: Group) => g.p.name ?? photos(g);
const hint = (d: number) => (d < SURE ? 'very likely' : d < LIKELY ? 'maybe' : 'unlikely');
/** How full the closeness bar is: full when very alike, empty at the edge of "maybe". */
const fill = (d: number) => Math.round(100 * Math.max(0.05, Math.min(1, (LIKELY + 0.05 - d) / (LIKELY + 0.05 - BEST))));
type Match = { g: Group; dist: number };
/** "40 min" or "6 hours" for `n` photos at `secs` each. */
const took = (n: number, secs: number) => { const m = Math.max(1, Math.round((n * secs) / 60)); return m < 90 ? `${m} min` : `${Math.round(m / 60).toLocaleString()} hours`; };

/** Up to 3 people a face may be: people you named first (if alike enough), then unnamed ones. */
function matchesFor(g: Group, refs: Ref[], groupById: Map<string, Group>, unnamed: Cand[], onlyAlike: boolean): Match[] {
  const c = centre(g.p);
  const named = namedMatches(refs, c, { skipNo: g.id }).map((m) => ({ g: groupById.get(m.id)!, dist: m.dist })).filter((m) => m.g && m.g.id !== g.id).slice(0, 3);
  if (named.length >= 3) return named;
  const rest = closest(unnamed, c, 3 - named.length, (x) => x.id === g.id).map((x) => ({ g: x.c.g, dist: x.dist }));
  return [...named, ...(onlyAlike ? rest.filter((x) => x.dist < LIKELY) : rest)];
}

/** Choose whose look-alikes to go through: people you named, most look-alikes first. */
function BatchList({ named, batches, cover, onPick, onClose }: { named: Group[]; batches: Map<string, { id: string; dist: number }[]>; cover: (g: Group) => string | undefined; onPick: (id: string) => void; onClose: () => void }) {
  const list = named.map((g) => ({ g, n: batches.get(g.id)?.length ?? 0 })).filter((x) => x.n > 0).sort((a, b) => b.n - a.n);
  return (
    <div className="panel">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h2 style={{ margin: 0 }}>Name in batches</h2>
        <button className="btn" onClick={onClose}>Close</button>
      </div>
      <p className="muted" style={{ margin: 0 }}>Pick a person. You'll see the unnamed faces that look like them, most alike first, and say yes to the right ones in one go. Each face is shown under the one person it looks most like.</p>
      {!list.length ? <p className="muted">No unnamed face looks like the people you named. Name a few more people (open a face and type the name), then come back.</p> : (
        <div className="people">
          {list.map(({ g, n }) => (
            <button key={g.id} className="pcard" style={{ cursor: 'pointer' }} onClick={() => onPick(g.id)}>
              {cover(g) ? <img className="face" src={cover(g)} alt="" /> : <span className="face" />}
              <b>{g.p.name}</b>
              <span className="muted">{n.toLocaleString()} look-alike{n === 1 ? '' : 's'}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** "Is this Nick?": every unnamed face that looks like one named person, the very likely ones already ticked. */
function NameBatch({ person, list, groupById, cover, crop, onYes, onNext, hasNext, onBack, onSeePhoto }: {
  person: Group; list: { id: string; dist: number }[]; groupById: Map<string, Group>; cover: (g: Group) => string | undefined; crop: (key: string) => string | undefined;
  onYes: (yes: string[], no: string[]) => Promise<void>; onNext: () => void; hasNext: boolean; onBack: () => void; onSeePhoto: (g: Group) => void;
}) {
  const name = person.p.name ?? 'this person';
  const [limit, setLimit] = useState(200);
  const shown = useMemo(() => list.slice(0, limit).filter((x) => groupById.has(x.id)), [list, limit, groupById]);
  const sig = shown.map((x) => x.id).join();
  const [ticked, setTicked] = useState<Set<string>>(() => new Set(shown.filter((x) => x.dist < SURE).map((x) => x.id)));
  const [busy, setBusy] = useState(false);
  useEffect(() => setTicked(new Set(shown.filter((x) => x.dist < SURE).map((x) => x.id))), [sig]); // eslint-disable-line react-hooks/exhaustive-deps
  const n = shown.filter((x) => ticked.has(x.id)).length;
  const toggle = (id: string) => setTicked((t) => { const nt = new Set(t); nt.has(id) ? nt.delete(id) : nt.add(id); return nt; });
  const answer = async (all: boolean) => {
    setBusy(true);
    try { await onYes(all ? shown.filter((x) => ticked.has(x.id)).map((x) => x.id) : [], shown.filter((x) => !all || !ticked.has(x.id)).map((x) => x.id)); } finally { setBusy(false); }
  };
  return (
    <div className="panel batch">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <div className="row">
          {cover(person) ? <img className="face" src={cover(person)} alt="" /> : <span className="face" />}
          <div className="stack" style={{ gap: 2 }}>
            <h2 style={{ margin: 0 }}>Is this {name}? · {list.length.toLocaleString()} look-alike{list.length === 1 ? '' : 's'}</h2>
            <div className="faces small">{person.faces.slice(0, 10).map((k) => <img key={k} className="face" src={crop(k)} alt="" title={`A face you said is ${name}`} />)}</div>
          </div>
        </div>
        <div className="row">
          <button className="btn" onClick={onBack}>← People to name</button>
          {hasNext && <button className="btn" onClick={onNext}>Next person →</button>}
        </div>
      </div>
      {!shown.length ? <p className="muted">No more faces look like {name}.{hasNext ? ' Go to the next person.' : ''}</p> : (
        <>
          <p className="muted" style={{ margin: 0 }}>Most alike first. The very likely ones are ticked for you. Click a face to tick or untick it, then press Yes. The faces you leave unticked won't be suggested for {name} again.</p>
          <div className="row">
            <button className="btn primary" disabled={!n || busy} onClick={() => answer(true)}>Yes, {n === shown.length ? (n === 1 ? 'this is' : `all ${n.toLocaleString()} are`) : `these ${n.toLocaleString()} are`} {name}</button>
            <button className="btn small" onClick={() => setTicked(new Set(shown.map((x) => x.id)))}>Tick all</button>
            {n > 0 && <button className="btn small" onClick={() => setTicked(new Set())}>Untick all</button>}
            <button className="btn small" disabled={busy} onClick={() => answer(false)}>None of {shown.length === 1 ? 'it is' : 'these are'} {name}</button>
          </div>
          <div className="bgrid">
            {shown.map((x) => {
              const g = groupById.get(x.id)!;
              const on = ticked.has(x.id);
              return (
                <div key={x.id} className={`bface${on ? ' on' : ''}`}>
                  <button className="bpick" aria-pressed={on} aria-label={`${on ? 'Untick' : 'Tick'} face ${photos(g)}`} title={on ? `Ticked: will be ${name}` : 'Click to tick'} onClick={() => toggle(x.id)}>
                    {cover(g) ? <img src={cover(g)} alt="" /> : <span />}
                    <span className="btick">✓</span>
                    {g.items.size > 1 && <span className="bcount" title={photos(g)}>{g.items.size}</span>}
                  </button>
                  <i className="bbar" title={hint(x.dist)}><b style={{ width: `${fill(x.dist)}%` }} /></i>
                  <span className="muted small">{hint(x.dist)} · <button className="link" onClick={() => onSeePhoto(g)}>photo</button></span>
                </div>
              );
            })}
          </div>
          {limit < list.length && <div className="row"><button className="btn" onClick={() => setLimit((l) => l + 200)}>Show {Math.min(200, list.length - limit).toLocaleString()} more</button></div>}
        </>
      )}
    </div>
  );
}

/** Faces set aside: seen in only one photo and small in it, or set aside by you. */
function Strangers({ list, cover, onOpen, onClose }: { list: Group[]; cover: (g: Group) => string | undefined; onOpen: (id: string) => void; onClose: () => void }) {
  const [limit, setLimit] = useState(300);
  return (
    <div className="panel">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h2 style={{ margin: 0 }}>Strangers · {list.length.toLocaleString()}</h2>
        <button className="btn" onClick={onClose}>Close</button>
      </div>
      <p className="muted" style={{ margin: 0 }}>Faces seen in only one photo and small in it (people in the background, crowds, posters), and faces you set aside. They're left out of "Sort out faces" and the people list. "Name in batches" still looks at them, so one that looks like someone you named is suggested there. Click a face to open it; there you can bring it back.</p>
      <div className="faces">
        {list.slice(0, limit).map((g) => (
          <button key={g.id} className="facebox plain" title="Open this face" onClick={() => onOpen(g.id)}>
            {cover(g) ? <img className="face" src={cover(g)} alt="" /> : <span className="face" />}
          </button>
        ))}
      </div>
      {limit < list.length && <div className="row"><button className="btn" onClick={() => setLimit((l) => l + 300)}>Show more</button></div>}
    </div>
  );
}

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
function Review({ groups, unnamedCands, refs, groupById, strangers, byId, faceOf, cover, onJoin, onName, onStranger, onUndo, canUndo, onClose }: {
  groups: Group[]; unnamedCands: Cand[]; refs: Ref[]; groupById: Map<string, Group>; strangers: Set<string>; byId: Map<string, Item>; faceOf: (g: Group) => { itemId: string } | undefined; cover: (g: Group) => string | undefined;
  onJoin: (from: Group, into: Group) => void; onName: (g: Group, name: string) => void; onStranger: (g: Group) => void; onUndo: () => void; canUndo: boolean; onClose: () => void;
}) {
  const [skipped, setSkipped] = useState<Set<string>>(new Set());
  const queue = useMemo(() => groups.filter((g) => !g.p.name && !skipped.has(g.id) && !strangers.has(g.id)).sort((a, b) => b.items.size - a.items.size), [groups, skipped, strangers]);
  const cur = queue[0];
  const opts = useMemo(() => (cur ? matchesFor(cur, refs, groupById, unnamedCands, false) : []), [cur, refs, groupById, unnamedCands]);
  const names = useMemo(() => groups.filter((g) => g.p.name).map((g) => g.p.name!).sort(), [groups]);
  const [name, setName] = useState('');
  useEffect(() => setName(''), [cur?.id]);
  const skip = () => cur && setSkipped((s) => new Set(s).add(cur.id));
  const keys = useRef({ opts, cur, skip, onJoin, onStranger, onUndo, onClose });
  keys.current = { opts, cur, skip, onJoin, onStranger, onUndo, onClose };
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      const { opts, cur, skip, onJoin, onStranger, onUndo, onClose } = keys.current;
      if (e.key === 'Escape') { onClose(); return; }
      if ((e.target as HTMLElement)?.tagName === 'INPUT' || e.ctrlKey || e.metaKey || e.altKey) return;
      const n = '123'.indexOf(e.key);
      if (n >= 0 && cur && opts[n]) { e.preventDefault(); onJoin(cur, opts[n].g); }
      else if ((e.key === 'x' || e.key === 'X') && cur) { e.preventDefault(); onStranger(cur); }
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
              <button key={o.g.id} className={`review-opt ${o.dist < SURE ? 'sure' : o.dist >= LIKELY ? 'weak' : ''}`} onClick={() => onJoin(cur, o.g)}>
                <kbd>{i + 1}</kbd>
                {cover(o.g) ? <img className="face" src={cover(o.g)} alt="" /> : <span className="face" />}
                <span className="stack" style={{ gap: 2, textAlign: 'left' }}><b>{o.g.p.name ?? 'Unnamed'}</b><span className="muted">{photos(o.g)} · {hint(o.dist)}</span></span>
              </button>
            ))}
            <div className="row">
              <button className="btn" onClick={skip}><kbd>S</kbd> Not sure, skip</button>
              <button className="btn" onClick={() => onStranger(cur)} title="Someone you don't know: set aside in the Strangers pile"><kbd>X</kbd> Stranger</button>
              <button className="btn" disabled={!canUndo} onClick={onUndo}><kbd>Z</kbd> Undo</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * The faces were found by the older face AI: offer to read every photo again with the stronger one (AdaFace), and,
 * once done, to switch, carrying the names over.
 */
function Upgrade({ st, photos, readOnly }: { st: PeopleState; photos: Item[]; readOnly?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [shown, setShown] = useState(false);
  const left = photos.filter((x) => !st.next.scanned.has(x.id)).length;
  const preview = useMemo(() => (left === 0 && shown ? switchPreview() : []), [left, shown, st.v]); // eslint-disable-line react-hooks/exhaustive-deps
  if (st.run.running) return null;
  const doSwitch = async () => {
    setBusy(true); setErr('');
    await new Promise((r) => setTimeout(r, 50)); // let "Switching…" show first
    try { await switchToNew(); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  if (left > 0) {
    const started = st.next.scanned.size > 0;
    return (
      <div className="panel">
        <h2 style={{ marginTop: 0 }}>A stronger face AI</h2>
        <p className="muted">
          The new face AI (AdaFace) tells people apart much better, also with turned heads, poor light and older photos. It reads every photo again; your
          faces and names stay as they are meanwhile. When it's done, the names you gave are carried over to the new faces (same photo, same spot), and you
          choose when to switch. The AI (about 187 MB) downloads once from Hugging Face; everything runs on this computer.
        </p>
        <div className="row">
          <button className="btn primary" disabled={readOnly} onClick={() => readAgain(photos)}>{started ? `Carry on reading again · ${left.toLocaleString()} photos left` : `Read ${left.toLocaleString()} photos again with the stronger face AI`}</button>
          <span className="muted">{started ? `${st.next.scanned.size.toLocaleString()} done, ${st.next.faces.size.toLocaleString()} faces found. ` : ''}About {took(left, 1)} (roughly a second a photo; less with a graphics card). You can pause and carry on later.</span>
        </div>
      </div>
    );
  }
  const lost = preview.filter((x) => x.before && !x.after);
  return (
    <div className="panel">
      <h2 style={{ marginTop: 0 }}>The stronger face AI has read all your photos</h2>
      <p className="muted">It found {st.next.faces.size.toLocaleString()} faces (the older AI: {st.faces.size.toLocaleString()}). Switching puts the new faces in use: each named person keeps their name, and the new AI groups the other faces again. A copy of the old faces and names stays in your backup folder (“before-new-face-ai”).</p>
      {!shown ? <div className="row"><button className="btn" onClick={() => setShown(true)}>See what happens to the names</button></div> : (
        <>
          <table className="small">
            <thead><tr><th style={{ textAlign: 'left' }}>Name</th><th>Faces now</th><th>Found again</th></tr></thead>
            <tbody>{preview.slice(0, 60).map((x) => <tr key={x.name}><td>{x.name}</td><td style={{ textAlign: 'center' }}>{x.before.toLocaleString()}</td><td style={{ textAlign: 'center' }}>{x.after.toLocaleString()}</td></tr>)}</tbody>
          </table>
          {preview.length > 60 && <p className="muted small">…and {(preview.length - 60).toLocaleString()} more people.</p>}
          {lost.length > 0 && <p className="notice">Not found again, so these names would go: {lost.map((x) => x.name).join(', ')}.</p>}
          <p className="muted small">"Found again" counts only faces in the same spot as before. After switching, the new AI may add more faces to each person by itself.</p>
        </>
      )}
      <div className="row">
        <button className="btn primary" disabled={busy} onClick={doSwitch}>{busy ? 'Switching…' : 'Switch to the stronger face AI'}</button>
      </div>
      {err && <p className="notice">{err}</p>}
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
  const [batch, setBatch] = useState<string | null>(null); // 'list', or the named person whose look-alikes are shown
  const [pile, setPile] = useState(false);
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
  const groupById = useMemo(() => new Map(groups.map((g) => [g.id, g])), [groups]);
  // Strangers: unnamed, in one photo only and small in it, or set aside by you. Left out of the queue and the list.
  const strangers = useMemo(() => new Set(groups.filter((g) => isStranger(g, (k) => st.faces.get(k)?.box[2] ?? 1)).map((g) => g.id)), [groups]); // eslint-disable-line react-hooks/exhaustive-deps
  // People you named, ready for comparing faces with; and which unnamed faces look like each of them.
  const named = useMemo(() => groups.filter((g) => g.p.name), [groups]);
  const refs = useMemo(() => named.map((g) => refOf(g.p, g.faces.map((k) => st.faces.get(k)?.d).filter((d): d is number[] => !!d))), [named]); // eslint-disable-line react-hooks/exhaustive-deps
  const unnamedCands = useMemo(() => cands.filter((c) => !c.g.p.name), [cands]);
  const batches = useMemo(() => batchesByPerson(unnamedCands, refs), [unnamedCands, refs]);
  const batchTotal = useMemo(() => [...batches.values()].reduce((n, a) => n + a.length, 0), [batches]);
  const solidUnnamed = useMemo(() => unnamedCands.filter((c) => c.g.items.size >= 2 && !strangers.has(c.id)), [unnamedCands, strangers]);
  const join = async (from: Group, into: Group) => {
    const undo = await mergeInto(from.id, into.id);
    setUndos((u) => [...u.slice(-49), { text: `Joined with ${into.p.name ?? 'an unnamed person'}`, undo }]);
  };
  const joinMany = async (into: Group, yes: string[], no: string[]) => {
    const undo = await mergeMany(yes, into.id, no);
    const name = into.p.name ?? 'this person';
    setUndos((u) => [...u.slice(-49), { text: yes.length ? `Added ${yes.length.toLocaleString()} face${yes.length === 1 ? '' : 's'} to ${name}` : `Noted: not ${name}`, undo }]);
  };
  const setAside = async (g: Group, value: boolean) => {
    const undo = await setStranger(g.id, value);
    setUndos((u) => [...u.slice(-49), { text: value ? 'Set aside as a stranger' : 'Brought back from Strangers', undo }]);
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
  const shown = groups.filter((g) => !strangers.has(g.id) && (showAll || g.p.name || g.items.size >= 3));
  const visible = shown.slice(0, limit);
  const sugg = useMemo(() => new Map(visible.filter((g) => !g.p.name).map((g) => [g.id, matchesFor(g, refs, groupById, solidUnnamed, true)])), [visible.map((g) => g.id).join(), refs, solidUnnamed, groupById]); // eslint-disable-line react-hooks/exhaustive-deps
  const undoBar = undos.length > 0 && <div className="undo-bar"><span>{undos[undos.length - 1].text}</span><button className="btn small" onClick={undoLast}>Undo</button></div>;
  const person = open ? groups.find((g) => g.id === open) : undefined;
  const cover = (g: (typeof groups)[number]) => st.faces.get(g.p.cover)?.crop ?? st.faces.get(g.faces[0])?.crop;

  const status = (
    <div className="panel">
      {r.running ? (
        <>
          {r.loading ? <div className="muted">{r.loading}</div> : r.upgrade ? (
            <div className="stats"><div><b>{r.done.toLocaleString()}</b><span>of {r.total.toLocaleString()} photos read again with the stronger face AI</span></div><div><b>{st.next.faces.size.toLocaleString()}</b><span>faces found</span></div></div>
          ) : (
            <div className="stats"><div><b>{r.done.toLocaleString()}</b><span>of {r.total.toLocaleString()} photos looked at</span></div><div><b>{groups.length.toLocaleString()}</b><span>people so far</span></div></div>
          )}
          {!r.loading && <div className="muted">Looking at “{r.current ?? '…'}”{r.device ? ` (face AI on the ${r.device})` : ''}. You can keep using the app meanwhile; it carries on if you switch tabs inside the app.</div>}
          <div className="row"><button className="btn" onClick={stop}>Pause</button></div>
        </>
      ) : (
        <>
          <p className="muted">The app finds faces in your photos and groups the same face together. This runs on this computer only: no photo or face is sent anywhere. Give each person a name once, then search for them by name in Photos.</p>
          <div className="row">
            {left > 0 && <button className="btn primary" disabled={readOnly} onClick={() => findFaces(photos)}>{st.scanned.size ? `Look at ${left.toLocaleString()} new photos` : `Find faces in ${left.toLocaleString()} photos`}</button>}
            {left === 0 && <span className="muted">All {photos.length.toLocaleString()} photos have been looked at.</span>}
            {left > 0 && <span className="muted">About {took(left, st.old ? 0.35 : 1)} on a typical PC. You can pause and carry on later.</span>}
          </div>
          {readOnly && <p className="muted">Open your photos first (Choose photos) so the app can read them.</p>}
        </>
      )}
      {r.slow && <p className="notice">Google Drive doesn't let the page read its small previews, so the app downloads each photo to look at it. That's slower and uses more internet. Choosing your Drive folder synced to this PC is much faster.</p>}
      {r.error && <p className="notice">{r.error}</p>}
    </div>
  );
  const upgrade = st.loaded && st.old && <Upgrade st={st} photos={photos} readOnly={readOnly} />;

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
            {!person.p.name && (strangers.has(person.id)
              ? <div className="row"><span className="muted">In the Strangers pile.</span><button className="btn small" onClick={() => setAside(person, false)}>Not a stranger: bring back</button></div>
              : <div className="row"><button className="btn small" onClick={() => setAside(person, true)} title="Someone you don't know: leaves the list and Sort out faces">Set aside as a stranger</button></div>)}
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

  const unnamed = groups.filter((g) => !g.p.name && !strangers.has(g.id)).length;
  const order = named.map((g) => ({ id: g.id, n: batches.get(g.id)?.length ?? 0 })).filter((x) => x.n > 0).sort((a, b) => b.n - a.n).map((x) => x.id);
  const batchPerson = batch && batch !== 'list' ? groupById.get(batch) : undefined;
  const nextPerson = batchPerson ? order.find((id) => id !== batchPerson.id && order.indexOf(id) > order.indexOf(batchPerson.id)) ?? order.find((id) => id !== batchPerson.id) : undefined;
  const pickTarget = picking ? groups.find((g) => g.id === picking) : undefined;
  return (
    <div className="stack" style={{ maxWidth: 'none' }}>
      {status}
      {upgrade}
      {undoBar}
      {!st.loaded ? <p className="muted">Loading…</p> : groups.length === 0 ? (
        !r.running && <p className="muted">No people yet.</p>
      ) : reviewing ? (
        <Review groups={groups} unnamedCands={unnamedCands} refs={refs} groupById={groupById} strangers={strangers} byId={byId} faceOf={(g) => st.faces.get(g.p.cover) ?? st.faces.get(g.faces[0])} cover={cover} onJoin={join} onName={giveName} onStranger={(g) => setAside(g, true)} onUndo={undoLast} canUndo={undos.length > 0} onClose={() => setReviewing(false)} />
      ) : batchPerson ? (
        <NameBatch key={batchPerson.id} person={batchPerson} list={batches.get(batchPerson.id) ?? []} groupById={groupById} cover={cover} crop={(k) => st.faces.get(k)?.crop}
          onYes={(yes, no) => joinMany(batchPerson, yes, no)} hasNext={!!nextPerson} onNext={() => nextPerson && setBatch(nextPerson)} onBack={() => setBatch('list')}
          onSeePhoto={(g) => { const l = [...g.items].map((id) => byId.get(id)!).filter(Boolean); if (l.length) onOpen(l, 0); }} />
      ) : batch === 'list' ? (
        <BatchList named={named} batches={batches} cover={cover} onPick={setBatch} onClose={() => setBatch(null)} />
      ) : pile ? (
        <Strangers list={groups.filter((g) => strangers.has(g.id))} cover={cover} onOpen={setOpen} onClose={() => setPile(false)} />
      ) : (
        <>
          {(unnamed > 0 || strangers.size > 0) && (
            <div className="row">
              {batchTotal > 0 && <button className="btn primary" onClick={() => setBatch('list')}>Name in batches · {batchTotal.toLocaleString()} face{batchTotal === 1 ? '' : 's'} look like people you named</button>}
              {unnamed > 0 && <button className={`btn${batchTotal ? '' : ' primary'}`} onClick={() => setReviewing(true)}>Sort out faces one by one</button>}
              {strangers.size > 0 && <button className="btn" onClick={() => setPile(true)}>Strangers · {strangers.size.toLocaleString()}</button>}
              <span className="muted">
                {unnamed.toLocaleString()} unnamed{strangers.size ? `, plus ${strangers.size.toLocaleString()} strangers set aside` : ''}.
                {!named.length ? ' Name a few people first (open a face and type the name); then "Name in batches" finds their other faces.' : ''}
              </span>
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
                          <button key={x.g.id} className={`mini ${i === 0 && x.dist < SURE ? 'sure' : ''}`} title={`Same as ${x.g.p.name ?? 'this person'} (${label(x.g)}, ${hint(x.dist)})`} onClick={() => join(g, x.g)}>
                            {cover(x.g) ? <img src={cover(x.g)} alt={x.g.p.name ?? 'Unnamed person'} /> : null}
                          </button>
                        ))}
                      </div>
                      {s[0].g.p.name && <span className="muted small">{s[0].g.p.name}?</span>}
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
