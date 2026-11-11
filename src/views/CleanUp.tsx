// Clean up: the CLIP AI sorts every photo into Junk and Keep groups. This first version only sorts and shows, so you
// can check how good it is on your own photos. Nothing here deletes or moves anything.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Item } from '../lib/model';
import { GROUP_BY_ID, GROUPS, SIDES, type Side } from '../sort/groups';
import { NEEDS_SIGN_IN, signIn } from '../drive/api';
import { checkPhoto, clearChecks, fixGroup, fresh, inDrive, needsSort, placeAll, retryUnreadable, sortable, sortPhotos, stopSorting, useSort } from '../sort/store';
import { Thumb } from './Grid';

const sideOf = (g: number) => GROUPS[g].side;
const pct = (a: number, b: number) => (b ? Math.round((100 * a) / b) : 0);
const mins = (s: number) => (s < 90 ? 'about a minute' : s < 3600 ? `about ${Math.round(s / 60)} minutes` : `about ${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min`);

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

const WHY = { ai: '', name: 'file name', face: 'face', you: 'you' } as const;

/** One photo: its picture, how sure the AI is, and the group (change it to fix a mistake). */
function CleanTile({ it, g, p, why, onOpen, check }: { it: Item; g: number; p: number; why: keyof typeof WHY; onOpen: () => void; check?: { answered?: boolean; ok?: boolean } }) {
  return (
    <div className={`ctile${why === 'you' ? ' fixed' : ''}${check?.answered ? (check.ok ? ' right' : ' wrong') : ''}`}>
      <Thumb item={it} onOpen={onOpen} />
      <span className="sure" title="How sure the AI is">{why === 'you' ? 'you' : `${Math.round(p * 100)}%`}{WHY[why] && why !== 'you' ? ` · ${WHY[why]}` : ''}</span>
      <div className="cbar">
        {check && !check.answered && <button className="ok" aria-label={`${it.name} is right`} title="Right group" onClick={() => checkPhoto(it.id, GROUPS[g].id, GROUPS[g].id)}>✓ Right</button>}
        <GroupSelect it={it} value={g} onPick={(ng) => (check && !check.answered ? checkPhoto(it.id, GROUPS[g].id, ng) : fixGroup(it.id, ng))} />
      </div>
    </div>
  );
}

/** Photos in the order given (most sure first), a few hundred at a time. */
function CleanGrid({ list, onOpen }: { list: { it: Item; g: number; p: number; why: keyof typeof WHY }[]; onOpen: (l: Item[], i: number) => void }) {
  const [limit, setLimit] = useState(300);
  const sentinel = useRef<HTMLDivElement>(null);
  const items = useMemo(() => list.map((x) => x.it), [list]);
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
        {list.slice(0, limit).map((x, i) => <CleanTile key={x.it.id} it={x.it} g={x.g} p={x.p} why={x.why} onOpen={() => onOpen(items, i)} />)}
      </div>
      {limit < list.length && <div className="more" ref={sentinel}>Loading more…</div>}
    </div>
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

  // Groups are worked out when the page opens, when sorting stops, and when you ask it to learn.
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
  const list = useMemo(() => {
    if (open == null) return [];
    const out: { it: Item; g: number; p: number; why: 'ai' | 'name' | 'face' | 'you' }[] = [];
    for (const [id, pl] of st.placed) { const it = byId.get(id); if (it && pl.g === open) out.push({ it, ...pl }); }
    return out.sort((a, b) => b.p - a.p || (b.it.takenAt ?? '').localeCompare(a.it.takenAt ?? ''));
  }, [open, st.placed, st.v, byId]); // eslint-disable-line react-hooks/exhaustive-deps

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
  const newFixes = st.fixes.size - st.learnedFrom;
  const rate = r.running && r.step === 'sorting' && r.startedAt && r.done > 5 ? r.done / ((Date.now() - r.startedAt) / 1000) : 0;

  return (
    <div className="stack" style={{ maxWidth: 'none' }}>
      <div className="panel">
        <p className="muted" style={{ margin: 0 }}>
          The app sorts your photos into groups with an AI that understands pictures and words together (CLIP, from OpenAI). It runs on this computer: no photo is sent anywhere.
          The AI is downloaded once (about 600 MB) and the browser keeps it. <b>Nothing is deleted on this page</b>: it only sorts and shows, so you can check how good it is first.
        </p>
        {r.running ? (
          <>
            {r.step === 'model' && <div className="muted">{r.model?.total ? `Downloading the AI (only the first time): ${Math.round(r.model.loaded / 1e6)} of ${Math.round(r.model.total / 1e6)} MB` : 'Starting the AI…'}</div>}
            {r.step === 'sorting' && (
              <>
                <div className="stats"><div><b>{r.done.toLocaleString()}</b><span>of {r.total.toLocaleString()} photos sorted</span></div></div>
                <div className="progress"><i style={{ width: `${r.total ? (100 * r.done) / r.total : 0}%` }} /></div>
                <div className="muted">Looking at “{r.current ?? '…'}”{rate ? ` · ${mins((r.total - r.done) / rate)} left` : ''}. You can keep using the app, or pause and carry on later.</div>
              </>
            )}
            <div className="row"><button className="btn" onClick={stopSorting}>Pause</button></div>
          </>
        ) : (
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
              <button className="btn primary" disabled={st.scoring} onClick={() => placeAll(all, pathOf)}>{st.scoring ? 'Learning…' : `Learn from my ${newFixes.toLocaleString()} ${newFixes === 1 ? 'fix' : 'fixes'}`}</button>
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
          <CleanGrid list={list} onOpen={onOpen} />
        </div>
      )}
    </div>
  );
}
