// Clean up: the SigLIP 2 AI sorts every photo into Junk and Keep groups. Open a group, tick its photos (all, or only the
// sure ones) and use the bottom bar: Move to trash (after a confirm window, with Undo) or Move to group.
// Inside a group, "Show only" narrows it to the photos with one tag (Car, Nature, People…, see sort/tags.ts), or to
// the ones the AI leaned to junk on.
import { useEffect, useMemo, useRef, useState } from 'react';
import { setTicked, startSelecting, stopSelecting, useShownList, useTickedOf } from '../lib/selection';
import type { Item } from '../lib/model';
import { GROUP_BY_ID, GROUPS, SIDES, type Side, type Why } from '../sort/groups';
import { NEEDS_SIGN_IN, signIn } from '../drive/api';
import { checkPhoto, clearChecks, fixGroup, fixGroups, fresh, inDrive, needsSort, newFixCount, placeAll, retryUnreadable, sortable, useSort } from '../sort/store';
import { sortPhotos } from '../read/reader';
import { ReadProgress } from './ReadProgress';
import { Thumb } from './Grid';
import { keepSigns, TAGS } from '../sort/tags';

const sideOf = (g: number) => GROUPS[g].side;
const pct = (a: number, b: number) => (b ? Math.round((100 * a) / b) : 0);

function GroupSelect({ it, value, onPick }: { it: Item; value: number; onPick: (g: string) => void }) {
  return (
    <select className="gsel" aria-label={`Group of ${it.name}`} value={GROUPS[value].id} onChange={(e) => onPick(e.target.value)} onClick={(e) => e.stopPropagation()}>
      {SIDES.map((s) => (
        <optgroup key={s.side} label={s.name}>
          {GROUPS.filter((g) => g.side === s.side).map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
        </optgroup>
      ))}
    </select>
  );
}

const WHY = { ai: '', name: 'file name', face: 'face', you: 'you', unsure: 'not sure', mixed: 'mixed' } as const;

/** One photo: its picture, how sure the AI is, and the group (change it to fix a mistake). */
function CleanTile({ it, g, p, why, guess, tags, onOpen, check, selectable }: { it: Item; g: number; p: number; why: keyof typeof WHY; guess?: number; tags?: number; onOpen: () => void; check?: { answered?: boolean; ok?: boolean }; selectable?: boolean }) {
  const lean = guess != null ? GROUPS[guess].name : '';
  const title = why === 'unsure' && guess != null ? `The AI leaned to ${lean}, but only ${Math.round(p * 100)}% sure: not enough to call it junk`
    : why === 'mixed' && guess != null ? `The AI leaned to ${lean} (${Math.round(p * 100)}% sure), but the photo also shows ${keepSigns(tags).map((t) => t.name).join(', ')}: worth a look before deleting`
    : 'How sure the AI is';
  return (
    <div className={`ctile${why === 'you' ? ' fixed' : ''}${check?.answered ? (check.ok ? ' right' : ' wrong') : ''}`}>
      <Thumb item={it} onOpen={onOpen} selectable={selectable} />
      <span className="sure" title={title}>{why === 'you' ? 'you' : `${Math.round(p * 100)}%`}{WHY[why] && why !== 'you' ? ` · ${WHY[why]}` : ''}</span>
      <div className="cbar">
        {check && !check.answered && <button className="ok" aria-label={`${it.name} is right`} title="Right group" onClick={() => checkPhoto(it.id, GROUPS[g].id, GROUPS[g].id)}>✓ Right</button>}
        <GroupSelect it={it} value={g} onPick={(ng) => (check && !check.answered ? checkPhoto(it.id, GROUPS[g].id, ng) : fixGroup(it.id, ng))} />
      </div>
    </div>
  );
}

/** Photos in the order given (most sure first), a few hundred at a time. */
function CleanGrid({ list, tagsOf, onOpen }: { list: { it: Item; g: number; p: number; why: keyof typeof WHY; guess?: number }[]; tagsOf: (id: string) => number | undefined; onOpen: (l: Item[], i: number) => void }) {
  const [limit, setLimit] = useState(300);
  const sentinel = useRef<HTMLDivElement>(null);
  const items = useMemo(() => list.map((x) => x.it), [list]);
  const order = useMemo(() => list.map((x) => x.it.id), [list]);
  useShownList(order); // so the bar's "Select all" and Shift-click work on this group
  useEffect(() => setLimit(300), [list.length]);
  useEffect(() => {
    const el = sentinel.current;
    if (!el) return;
    const io = new IntersectionObserver((es) => es[0].isIntersecting && setLimit((l) => l + 300), { rootMargin: '800px' });
    io.observe(el);
    return () => io.disconnect();
  }, [list.length, limit]);
  if (!list.length) return <p className="muted">No photos in this group.</p>;
  return (
    <div>
      <div className="grid">
        {list.slice(0, limit).map((x, i) => <CleanTile key={x.it.id} it={x.it} g={x.g} p={x.p} why={x.why} guess={x.guess} tags={tagsOf(x.it.id)} onOpen={() => onOpen(items, i)} selectable />)}
      </div>
      {limit < list.length && <div className="more" ref={sentinel}>Loading more…</div>}
    </div>
  );
}

/** Sure enough that a whole group's photos can be ticked without looking at each one. */
const SURE_TICK = 0.9;

/** Tick a whole group, or only the photos the AI is very sure about. */
function GroupTicks({ list }: { list: { it: Item; p: number }[] }) {
  const all = useMemo(() => list.map((x) => x.it.id), [list]);
  const sure = useMemo(() => list.filter((x) => x.p >= SURE_TICK).map((x) => x.it.id), [list]);
  const state = useTickedOf(all);
  if (!list.length) return null;
  return (
    <div className="row">
      <button className="btn small" onClick={() => { startSelecting(); setTicked(all, true); }}>Tick all {all.length.toLocaleString()}</button>
      {sure.length > 0 && sure.length < all.length && <button className="btn small" onClick={() => { startSelecting(); setTicked(all, false); setTicked(sure, true); }}>Tick only the sure ones ({Math.round(SURE_TICK * 100)}% or more) · {sure.length.toLocaleString()}</button>}
      {state !== 'none' && <button className="btn small" onClick={() => setTicked(all, false)}>Untick all</button>}
      <span className="muted small">Then use the bar at the bottom: Move to trash, or Move to group.</span>
    </div>
  );
}

/** In the bottom bar: put the ticked photos in another group at once. */
export function MoveToGroup({ ids }: { ids: string[] }) {
  return (
    <select className="gsel" aria-label="Move the ticked photos to a group" value="" onChange={async (e) => { const g = e.target.value; if (!g) return; await fixGroups(ids, g); stopSelecting(); }}>
      <option value="">Move {ids.length.toLocaleString()} to group…</option>
      {SIDES.map((s) => (
        <optgroup key={s.side} label={s.name}>
          {GROUPS.filter((g) => g.side === s.side).map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
        </optgroup>
      ))}
    </select>
  );
}

export function CleanUp({ items, all, onOpen, pathOf }: { items: Item[]; all: Item[]; onOpen: (list: Item[], i: number) => void; pathOf: (folderId?: string) => string }) {
  const st = useSort();
  const photos = useMemo(() => all.filter(sortable), [all]);
  const todo = useMemo(() => photos.filter((it) => needsSort(it, st.recs.get(it.id))), [photos, st.v]); // eslint-disable-line react-hooks/exhaustive-deps
  const left = todo.length;
  const driveLeft = useMemo(() => todo.filter(inDrive).length, [todo]);
  const unreadable = useMemo(() => photos.filter((it) => st.recs.get(it.id)?.x).length, [photos, st.v]); // eslint-disable-line react-hooks/exhaustive-deps
  const sortedN = useMemo(() => photos.filter((it) => fresh(st.recs.get(it.id))).length, [photos, st.v]); // eslint-disable-line react-hooks/exhaustive-deps
  const r = st.run;
  // Drive photos need the Google sign-in: ask for it on the click (a sign-in window is only allowed right after one).
  const [signErr, setSignErr] = useState('');
  const sort = async (signInFirst: boolean) => {
    setSignErr('');
    if (signInFirst || driveLeft) {
      try { await signIn(); } catch (e) { if (signInFirst) { setSignErr((e as Error).message); return; } }
    }
    sortPhotos(all);
  };

  // Groups are worked out when the page opens, when sorting stops, and when you ask it to learn. Only the fixes you
  // asked it to learn from teach the AI, so moving or deleting photos doesn't shift other photos by itself.
  const placedFor = useRef('');
  useEffect(() => {
    if (!st.loaded || r.running || st.scoring) return;
    const key = `${all.length}:${sortedN}`;
    if (placedFor.current === key) return;
    placedFor.current = key;
    placeAll(all, pathOf);
  }, [st.loaded, r.running, st.scoring, all, sortedN, pathOf]);

  const byId = useMemo(() => new Map(items.map((x) => [x.id, x])), [items]);
  const counts = useMemo(() => {
    const c = new Array(GROUPS.length).fill(0);
    for (const [id, pl] of st.placed) if (byId.has(id)) c[pl.g]++;
    return c;
  }, [st.placed, st.v, byId]); // eslint-disable-line react-hooks/exhaustive-deps
  const [open, setOpen] = useState<number | null>(null);
  // Inside an open group: only the photos with one tag, or only the ones the AI leaned to junk on ('lean').
  const [only, setOnly] = useState<string | null>(null);
  useEffect(() => { setOnly(null); }, [open]);
  useEffect(() => { stopSelecting(); }, [open, only]); // ticks belong to the photos on screen
  const list = useMemo(() => {
    if (open == null) return [];
    const out: { it: Item; g: number; p: number; why: Why; guess?: number }[] = [];
    for (const [id, pl] of st.placed) { const it = byId.get(id); if (it && pl.g === open) out.push({ it, ...pl }); }
    return out.sort((a, b) => b.p - a.p || (b.it.takenAt ?? '').localeCompare(a.it.takenAt ?? ''));
  }, [open, st.placed, st.v, byId]); // eslint-disable-line react-hooks/exhaustive-deps
  const tagsOf = (id: string) => st.tags.get(id);
  // What is in this group's photos: how many have each tag, and how many the AI leaned to junk on.
  const inGroup = useMemo(() => {
    const n = new Array(TAGS.length).fill(0);
    let lean = 0;
    for (const x of list) {
      if (x.why === 'unsure' || x.why === 'mixed') lean++;
      const bits = st.tags.get(x.it.id);
      if (bits) for (let t = 0; t < TAGS.length; t++) if (bits & (1 << t)) n[t]++;
    }
    return { n, lean };
  }, [list, st.tags]);
  const shownList = useMemo(() => {
    if (only == null) return list;
    if (only === 'lean') return list.filter((x) => x.why === 'unsure' || x.why === 'mixed');
    const t = TAGS.findIndex((x) => x.id === only);
    return t < 0 ? list : list.filter((x) => ((st.tags.get(x.it.id) ?? 0) & (1 << t)) !== 0);
  }, [list, only, st.tags]);

  // Checking: 50 random photos from one side; each answer is kept (and a wrong one becomes a fix).
  const [check, setCheck] = useState<{ side: 'junk' | 'rest'; ids: string[]; shown: Map<string, number> } | null>(null);
  const startCheck = (side: 'junk' | 'rest') => {
    const pool = [...st.placed].filter(([id, pl]) => byId.has(id) && pl.why !== 'you' && pl.why !== 'name' && !st.checks.has(id) && (side === 'junk' ? sideOf(pl.g) === 'junk' : sideOf(pl.g) !== 'junk'));
    for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
    const pick = pool.slice(0, 50);
    setCheck({ side, ids: pick.map(([id]) => id), shown: new Map(pick.map(([id, pl]) => [id, pl.g])) });
    setOpen(null);
  };
  const score = (side: 'junk' | 'rest') => {
    let n = 0, ok = 0;
    for (const c of st.checks.values()) {
      const g = GROUP_BY_ID.get(c.g);
      if (g == null || (side === 'junk') !== (sideOf(g) === 'junk')) continue;
      n++; if (c.ok) ok++;
    }
    return { n, ok };
  };
  const junkScore = score('junk'), restScore = score('rest');
  const newFixes = newFixCount(st);

  return (
    <div className="stack" style={{ maxWidth: 'none' }}>
      <div className="panel">
        <p className="muted" style={{ margin: 0 }}>
          The app sorts your photos into groups with an AI that understands pictures and words together (SigLIP 2, from Google). It runs on this computer: no photo is sent anywhere.
          The AI is downloaded once (about 370 MB) and the browser keeps it. Each photo is read only once: the same look also compares it for Duplicates. Sorting deletes nothing. To clean up, open a group, tick its photos and use the bar at the bottom: <b>Move to trash</b> asks you first and can be undone, <b>Move to group</b> puts them in another group.
        </p>
        {r.running ? <ReadProgress run={r} /> : (
          <div className="row">
            {left > 0 && <button className="btn primary" onClick={() => sort(false)}>{sortedN ? `Sort ${left.toLocaleString()} more photos` : `Sort ${left.toLocaleString()} photos`}</button>}
            {left > 0 && <span className="muted">{sortedN ? `${sortedN.toLocaleString()} sorted so far.` : 'The photos go in a mixed order, so after a few minutes you can already check the groups. You can pause and carry on later.'}</span>}
            {left === 0 && <span className="muted">All {photos.length.toLocaleString()} photos are sorted.{st.scoring ? ' Working out the groups…' : ''}</span>}
            {unreadable > 0 && <span className="muted">{unreadable.toLocaleString()} couldn't be read (often HEIC or RAW). <button className="link" onClick={() => retryUnreadable()}>Try them again</button></span>}
          </div>
        )}
        {r.error && !r.running && (r.error === NEEDS_SIGN_IN
          ? <div className="notice row" style={{ margin: 0 }}>
              <span>Your Google sign-in has expired{driveLeft ? `, so ${driveLeft.toLocaleString()} photos from Google Drive are waiting` : ''}. Sign in again to continue.</span>
              <button className="btn primary" onClick={() => sort(true)}>Sign in again</button>
            </div>
          : <p className="notice" style={{ margin: 0 }}>{r.error}</p>)}
        {signErr && <p className="notice" style={{ margin: 0 }}>{signErr}</p>}
      </div>

      {st.placed.size > 0 && (
        <div className="sides">
          {SIDES.map((s) => {
            const gs = GROUPS.map((g, i) => ({ g, i })).filter((x) => x.g.side === s.side);
            const total = gs.reduce((n, x) => n + counts[x.i], 0);
            return (
              <div className={`panel side ${s.side}`} key={s.side}>
                <h2>{s.name} <span>{total.toLocaleString()}</span></h2>
                <p className="muted" style={{ margin: 0 }}>{s.note}</p>
                <div className="row">
                  {gs.map(({ g, i }) => <button key={g.id} className={`chip ${open === i ? 'on' : ''}`} onClick={() => { setOpen(open === i ? null : i); setCheck(null); }}>{g.name} · {counts[i].toLocaleString()}</button>)}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {st.placed.size > 0 && (
        <div className="panel">
          <h2 style={{ margin: 0 }}>How good is it?</h2>
          <p className="muted" style={{ margin: 0 }}>Check 50 random photos: click ✓ Right, or pick the group it really belongs to. Your answers count how often the AI is right, and every wrong one becomes a fix it learns from.</p>
          <div className="row">
            <button className="btn" onClick={() => startCheck('junk')}>Check 50 from Probably junk</button>
            <button className="btn" onClick={() => startCheck('rest')}>Check 50 from the rest</button>
            {(junkScore.n > 0 || restScore.n > 0) && <button className="link" onClick={() => clearChecks()}>Start counting again</button>}
          </div>
          {(junkScore.n > 0 || restScore.n > 0) && (
            <div className="stats">
              {junkScore.n > 0 && <div><b>{pct(junkScore.ok, junkScore.n)}%</b><span>of “Probably junk” right ({junkScore.ok} of {junkScore.n})</span></div>}
              {restScore.n > 0 && <div><b>{pct(restScore.ok, restScore.n)}%</b><span>of the rest right ({restScore.ok} of {restScore.n})</span></div>}
            </div>
          )}
          {newFixes > 0 && (
            <div className="row">
              <button className="btn primary" disabled={st.scoring} onClick={() => placeAll(all, pathOf, true)}>{st.scoring ? 'Learning…' : `Learn from my ${newFixes.toLocaleString()} ${newFixes === 1 ? 'fix' : 'fixes'}`}</button>
              <span className="muted">Photos that look like the ones you fixed move to the group you chose.</span>
            </div>
          )}
          {st.learnedFrom > 0 && newFixes <= 0 && <p className="muted" style={{ margin: 0 }}>Learned from your {st.learnedFrom.toLocaleString()} {st.learnedFrom === 1 ? 'fix' : 'fixes'}.</p>}
        </div>
      )}

      {check && (
        <div className="panel">
          <div className="row">
            <h2 style={{ margin: 0 }}>Checking {check.side === 'junk' ? '“Probably junk”' : 'the rest'}: {check.ids.filter((id) => st.checks.has(id)).length} of {check.ids.length} done</h2>
            <button className="btn small" onClick={() => setCheck(null)}>Close</button>
          </div>
          {!check.ids.length && <p className="muted">No more photos to check here.</p>}
          <div className="grid">
            {check.ids.map((id, i) => {
              const it = byId.get(id);
              if (!it) return null;
              const shownG = check.shown.get(id)!;
              const c = st.checks.get(id);
              const pl = st.placed.get(id);
              return <CleanTile key={id} it={it} g={c && !c.ok ? (pl?.g ?? shownG) : shownG} p={pl?.why === 'you' ? 1 : pl?.p ?? 0} why={c && !c.ok ? 'you' : 'ai'} onOpen={() => onOpen(check.ids.map((x) => byId.get(x)!).filter(Boolean), i)} check={{ answered: !!c, ok: c?.ok }} />;
            })}
          </div>
        </div>
      )}

      {open != null && !check && (
        <div className="stack" style={{ maxWidth: 'none' }}>
          <div className="row">
            <h2 style={{ margin: 0 }}>{GROUPS[open].name} · {list.length.toLocaleString()}</h2>
            <span className="muted">Most sure first. If a photo is in the wrong group, pick the right one under it.</span>
            <button className="btn small" onClick={() => setOpen(null)}>Close</button>
          </div>
          {(inGroup.lean > 0 || inGroup.n.some((c) => c > 0)) && (
            <div className="row" aria-label="Show only">
              <span className="muted small">Show only:</span>
              <button className={`chip small ${only == null ? 'on' : ''}`} onClick={() => setOnly(null)}>All · {list.length.toLocaleString()}</button>
              {inGroup.lean > 0 && <button className={`chip small ${only === 'lean' ? 'on' : ''}`} title="Photos the AI leaned to a junk group on, but was not sure enough, or that also show something worth keeping" onClick={() => setOnly(only === 'lean' ? null : 'lean')}>Leaned to junk · {inGroup.lean.toLocaleString()}</button>}
              {TAGS.map((t, i) => inGroup.n[i] > 0 && <button key={t.id} className={`chip small ${only === t.id ? 'on' : ''}`} onClick={() => setOnly(only === t.id ? null : t.id)}>{t.name} · {inGroup.n[i].toLocaleString()}</button>)}
            </div>
          )}
          {only === 'lean' && <p className="muted small" style={{ margin: 0 }}>The AI leaned to a junk group on these, but it was not sure enough (“not sure”), or the photo also shows something worth keeping, like people, a car or a room (“mixed”). Hover the percentage to see why. Look before deleting.</p>}
          <GroupTicks list={shownList} />
          <CleanGrid list={shownList} tagsOf={tagsOf} onOpen={onOpen} />
        </div>
      )}
    </div>
  );
}
