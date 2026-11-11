import { useEffect, useMemo, useRef, useState } from 'react';
import type { Item } from '../lib/model';
import { helperVersion, OLD_HELPER, older, SEARCH_VERSION } from '../gphotos/bridge';
import { comparable, comparePictures, stopComparing, usePictures } from '../pictures/store';
import { clearLearning, deleteTopic, editTopic, markTopic, marksSig, members, parseQueries, PRESETS, runTopic, saveTopic, searchOnce, stopSearch, SURE, tuneTopic, useTopics, type Topic } from '../search/topics';
import { learnTopic, withFingerprint } from '../search/teach';
import { MonthGrid, Thumb } from './Grid';
import { when } from './Backup';
import { UpdateHelper } from './Helper';
import { useShownList } from '../lib/selection';

type Mark = 'yes' | 'no' | null;
const markOf = (t: Topic, id: string): Mark => (t.yes?.includes(id) ? 'yes' : t.no?.includes(id) ? 'no' : null);

/** A photo with ✓ and ✗ buttons: does it belong to the topic? */
function MarkTile({ it, mark, sure, onMark, onOpen }: { it: Item; mark: Mark; sure?: number; onMark: (m: Mark) => void; onOpen: () => void }) {
  return (
    <div className={`mtile ${mark ?? ''}`}>
      <Thumb item={it} onOpen={onOpen} selectable />
      <div className="marks">
        <button className={mark === 'yes' ? 'on' : ''} title="Belongs to this topic" aria-label={`${it.name} belongs`} aria-pressed={mark === 'yes'} onClick={() => onMark(mark === 'yes' ? null : 'yes')}>✓</button>
        <button className={mark === 'no' ? 'on' : ''} title="Doesn't belong" aria-label={`${it.name} doesn't belong`} aria-pressed={mark === 'no'} onClick={() => onMark(mark === 'no' ? null : 'no')}>✗</button>
      </div>
      {sure != null && <span className="sure" title="How sure the app is that this photo belongs">{Math.round(sure * 100)}%</span>}
    </div>
  );
}

/** Photos in the order given (best match first), shown a few hundred at a time. */
function MarkGrid({ items, t, sureOf, onOpen }: { items: Item[]; t: Topic; sureOf?: Map<string, number>; onOpen: (list: Item[], i: number) => void }) {
  const [limit, setLimit] = useState(300);
  const sentinel = useRef<HTMLDivElement>(null);
  const order = useMemo(() => items.map((x) => x.id), [items]);
  useShownList(order);
  useEffect(() => setLimit(300), [items]);
  useEffect(() => {
    const el = sentinel.current;
    if (!el) return;
    const io = new IntersectionObserver((es) => es[0].isIntersecting && setLimit((l) => l + 300), { rootMargin: '800px' });
    io.observe(el);
    return () => io.disconnect();
  }, [items.length, limit]);
  if (!items.length) return <p className="muted">No photos here yet.</p>;
  return (
    <div>
      <div className="grid">
        {items.slice(0, limit).map((it, i) => <MarkTile key={it.id} it={it} mark={markOf(t, it.id)} sure={sureOf?.get(it.id)} onMark={(m) => markTopic(t.id, it.id, m)} onOpen={() => onOpen(items, i)} />)}
      </div>
      {limit < items.length && <div className="more" ref={sentinel}>Loading more…</div>}
    </div>
  );
}

function TopicCard({ t, n, away, google, missing, busy, gp, open, onOpen, onEdit }: { t: Topic; n: number; away: number; google: number; missing: number; busy: boolean; gp: boolean; open: boolean; onOpen: () => void; onEdit: () => void }) {
  const st = useTopics();
  const r = st.run;
  const mine = r.id === t.id;
  const marks = (t.yes?.length ?? 0) + (t.no?.length ?? 0);
  // Only photos in the app are counted; when none of a topic's photos are, it says so without numbers.
  const notHere = "Its photos aren't in the app right now: read your photos again (Choose photos) to see them.";
  const status = t.learnedAt
    ? (n === 0 && away > 0 ? notHere : `${n.toLocaleString()} photos · learned from ${t.yes?.length ?? 0} ✓ and ${t.no?.length ?? 0} ✗, ${when(t.learnedAt)}`)
    : t.at ? (google === 0 && missing > 0 ? notHere : `${google.toLocaleString()} photos found by Google Photos' search, ${when(t.at)}`)
      : marks ? `${marks} marked so far` : gp && t.queries.length ? 'Not searched yet' : 'No photos marked yet';
  return (
    <div className={`panel topic ${open ? 'on' : ''}`}>
      <div className="row" style={{ justifyContent: 'space-between' }}><b>{t.name}</b><button className="link" onClick={onEdit}>Edit</button></div>
      {gp && t.queries.length > 0 && <span className="muted small">Google Photos searches: {t.queries.map((q) => (t.counts?.[q] != null ? `${q} (${t.counts[q].toLocaleString()})` : q)).join(', ')}</span>}
      {mine ? (
        <>
          <span>Searching “{r.query}” ({Math.min(r.done + 1, r.total)} of {r.total}): {r.found.toLocaleString()} found</span>
          <div className="progress"><i style={{ width: `${r.total ? (100 * r.done) / r.total : 0}%` }} /></div>
          <div className="row"><button className="btn small" onClick={stopSearch}>Stop</button></div>
        </>
      ) : (
        <>
          <span className="muted small">{status}</span>
          <div className="row">
            <button className={`btn small ${open ? 'primary' : ''}`} onClick={onOpen}>{open ? 'Showing' : 'Show'}{t.learnedAt || t.at ? ` ${(t.learnedAt ? n : google).toLocaleString()}` : ''}</button>
            {gp && t.queries.length > 0 && <button className="btn small" disabled={busy} onClick={() => runTopic(t.id)}>{t.at ? 'Search Google again' : 'Search Google Photos'}</button>}
          </div>
        </>
      )}
    </div>
  );
}

function EditTopic({ t, onDone }: { t: Topic; onDone: () => void }) {
  const [name, setName] = useState(t.name);
  const [text, setText] = useState(t.queries.join(', '));
  const preset = PRESETS.find((p) => p.id === t.id);
  const queries = parseQueries(text);
  const marks = (t.yes?.length ?? 0) + (t.no?.length ?? 0);
  return (
    <div className="panel">
      <b>Edit “{t.name}”</b>
      <label className="field">Name<input value={name} onChange={(e) => setName(e.target.value)} /></label>
      <label className="field">Google Photos searches, separated by commas (optional). Each one is typed into Google Photos' search, and what they find becomes the starting point you mark ✓ or ✗.
        <textarea rows={3} value={text} onChange={(e) => setText(e.target.value)} />
      </label>
      <p className="muted small" style={{ margin: 0 }}>Google's search is loose: “VIN” also finds screens and documents with text on them. Marking photos ✓ and ✗ and using “Find more like these” is what makes a topic accurate.</p>
      <div className="row">
        <button className="btn primary" disabled={!name.trim()} onClick={async () => { await editTopic(t.id, name, queries); onDone(); }}>Save</button>
        <button className="btn" onClick={onDone}>Cancel</button>
        {preset && <button className="btn" onClick={() => { setName(preset.name); setText(preset.queries.join(', ')); }}>Back to the suggested searches</button>}
        {(marks > 0 || t.learnedAt) && <button className="btn" onClick={async () => { if (confirm(`Forget the ${marks} photos marked ✓ or ✗ for “${t.name}” and what was learned from them? Your photos are not touched.`)) { await clearLearning(t.id); onDone(); } }}>Forget marks</button>}
        {!preset && <button className="btn danger" onClick={async () => { if (confirm(`Remove the topic “${t.name}”? Your photos are not touched.`)) { await deleteTopic(t.id); onDone(); } }}>Remove topic</button>}
      </div>
    </div>
  );
}

function NewTopic({ onMade }: { onMade: (t: Topic) => void }) {
  const [name, setName] = useState('');
  return (
    <form className="row" onSubmit={async (e) => { e.preventDefault(); if (!name.trim()) return; const t = await saveTopic(name, []); setName(''); onMade(t); }}>
      <input type="text" placeholder="New topic, like “Dashboards”" value={name} onChange={(e) => setName(e.target.value)} style={{ flex: '1 1 200px' }} />
      <button className="btn" disabled={!name.trim()}>Add topic</button>
    </form>
  );
}

type Tab = 'found' | 'google' | 'marks';

/** One topic's photos, with marking and "Find more like these". */
function TopicView({ t, all, shownIds, byKey, gp, onOpen, onClose, onSetup }: { t: Topic; all: Item[]; shownIds: Set<string>; byKey: Map<string, Item>; gp: boolean; onOpen: (list: Item[], i: number) => void; onClose: () => void; onSetup: () => void }) {
  const st = useTopics();
  const pics = usePictures();
  const byId = useMemo(() => new Map(all.map((x) => [x.id, x])), [all]);
  const ids = (list: string[]) => list.map((x) => byId.get(x)).filter((x): x is Item => !!x && shownIds.has(x.id));
  const [tab, setTab] = useState<Tab>(t.learnedAt ? 'found' : t.keys.length ? 'google' : 'marks');
  useEffect(() => { if (t.learnedAt) setTab('found'); }, [t.learnedAt]);
  const sure = t.sure ?? SURE;
  const [slider, setSlider] = useState(Math.round(sure * 100));
  useEffect(() => setSlider(Math.round((t.sure ?? SURE) * 100)), [t.sure]);
  const sureOf = useMemo(() => new Map((t.found ?? []).map((id, i) => [id, t.foundP?.[i] ?? 0])), [t.found, t.foundP]);
  const foundIds = useMemo(() => members({ ...t, sure: slider / 100 }), [t, slider]);
  const googleIds = useMemo(() => t.keys.map((k) => byKey.get(k)?.id ?? 'gp:' + k), [t.keys, byKey]);
  const markIds = useMemo(() => [...(t.yes ?? []), ...(t.no ?? [])], [t.yes, t.no]);
  const found = useMemo(() => ids(foundIds), [foundIds, byId, shownIds]); // eslint-disable-line react-hooks/exhaustive-deps
  const google = useMemo(() => ids(googleIds).sort((a, b) => (b.takenAt ?? '').localeCompare(a.takenAt ?? '')), [googleIds, byId, shownIds]); // eslint-disable-line react-hooks/exhaustive-deps
  const marked = useMemo(() => ids(markIds), [markIds, byId, shownIds]); // eslint-disable-line react-hooks/exhaustive-deps
  const yes = t.yes?.length ?? 0, no = t.no?.length ?? 0;
  const learning = st.learn.id === t.id;
  const changed = !!t.learnedAt && t.learnedFrom !== marksSig(t);
  // Learning can only use photos the app has looked at (Compare pictures).
  const canLook = useMemo(() => all.filter(comparable), [all]);
  const looked = useMemo(() => withFingerprint(canLook, pics.recs).length, [canLook, pics.v]); // eslint-disable-line react-hooks/exhaustive-deps
  const notLooked = canLook.length - looked;
  const list = tab === 'found' ? found : tab === 'google' ? google : marked;
  // Photos of this tab that can't be shown: not in the app's list now, or hidden by the filters at the top.
  const unseen = useMemo(() => {
    let out = 0, hidden = 0;
    for (const id of tab === 'found' ? foundIds : tab === 'google' ? googleIds : markIds) { if (!byId.has(id)) out++; else if (!shownIds.has(id)) hidden++; }
    return { out, hidden };
  }, [tab, foundIds, googleIds, markIds, byId, shownIds]);
  const step = st.learn.id === t.id ? st.learn.step : undefined;
  return (
    <>
      <div className="panel">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <h2 style={{ margin: 0 }}>{t.name}</h2>
          <button className="btn small" onClick={onClose}>Close</button>
        </div>
        <p className="muted" style={{ margin: 0 }}>
          Teach the app what belongs: tap <b>✓</b> on photos that belong and <b>✗</b> on ones that don't (open a photo to mark it there too). Then <b>Find more like these</b> learns what the ✓ photos have in common and looks through all your photos.
          It compares what the pictures look like; it can't read text, so a sticker that only looks like a VIN sticker can still show up. Marking it ✗ teaches the app to leave it out.
        </p>
        <div className="row">
          <button className="btn primary" disabled={!yes || !!st.learn.id} onClick={() => learnTopic(t.id, all)}>
            {learning ? (step === 'looking' ? 'Looking at the marked photos…' : 'Learning…') : t.learnedAt ? (changed ? 'Find again with the new marks' : 'Find again') : 'Find more like these'}
          </button>
          <span className="muted small">{yes} ✓ · {no} ✗{!yes ? ' · mark at least one photo ✓ (5 or more work better)' : yes < 5 ? ' · 5 or more ✓ work better' : ''}{yes && !no ? ' · mark a few ✗ too: without them, many wrong photos show up' : ''}</span>
        </div>
        {learning && step === 'looking' && pics.run.total > 0 && <div className="progress"><i style={{ width: `${(100 * pics.run.done) / pics.run.total}%` }} /></div>}
        {st.learn.error && !st.learn.id && <p className="error" style={{ margin: 0 }}>{st.learn.error}</p>}
        {st.learn.note && <p className="muted small" style={{ margin: 0 }}>{st.learn.note}</p>}
        {t.learnedAt && (
          <div className="row slider">
            <label htmlFor="sure">How sure: <b>{slider}%</b></label>
            <input id="sure" type="range" min={20} max={95} step={5} value={slider} onChange={(e) => setSlider(+e.target.value)} onPointerUp={() => tuneTopic(t.id, { sure: slider / 100 })} onKeyUp={() => tuneTopic(t.id, { sure: slider / 100 })} />
            <span className="muted small">Higher shows fewer photos, with fewer mistakes.</span>
          </div>
        )}
        {t.learnedAt && t.keys.length > 0 && (
          <label className="row small"><input type="checkbox" checked={!!t.onlyGoogle} onChange={(e) => tuneTopic(t.id, { onlyGoogle: e.target.checked })} /> Only photos Google Photos' search found too (fewer mistakes, may miss some)</label>
        )}
        {notLooked > 0 && (
          <p className="muted small" style={{ margin: 0 }}>
            The app has looked at {looked.toLocaleString()} of {canLook.length.toLocaleString()} photos; learning searches only those. {pics.run.running
              ? <>Looking now: {pics.run.done.toLocaleString()} of {pics.run.total.toLocaleString()}. <button className="link" onClick={stopComparing}>Pause</button></>
              : <><button className="link" onClick={() => comparePictures(all)}>Look at the other {notLooked.toLocaleString()}</button> (the same step as Compare pictures in Duplicates; it can be paused). Photos in a folder on this computer can only be looked at while their folder is open.</>}
          </p>
        )}
      </div>
      <div className="row tabs">
        {t.learnedAt && <button className={`chip ${tab === 'found' ? 'on' : ''}`} onClick={() => setTab('found')}>Found by your examples · {found.length.toLocaleString()}</button>}
        {t.keys.length > 0 && <button className={`chip ${tab === 'google' ? 'on' : ''}`} onClick={() => setTab('google')}>Google Photos search · {google.length.toLocaleString()}</button>}
        <button className={`chip ${tab === 'marks' ? 'on' : ''}`} onClick={() => setTab('marks')}>Your marks · {marked.length.toLocaleString()}</button>
      </div>
      {tab === 'found' && <p className="muted small" style={{ margin: 0 }}>Best matches first. Your ✓ photos are included; your ✗ photos are left out.{changed ? ' Your marks changed since this was found: press Find again to use them.' : ''}</p>}
      {unseen.out > 0 && (
        <p className="notice" style={{ margin: 0 }}>
          {list.length ? 'Some photos of this topic' : "This topic's photos"} aren't in the app's photo list right now, so they can't be shown.
          {' '}This happens when another folder was chosen, when Google Photos or Drive hasn't been read since, or when they were deleted.
          {' '}Your marks are kept: <button className="link" onClick={onSetup}>read Google Photos or your Drive again</button> to see them.
        </p>
      )}
      {unseen.hidden > 0 && <p className="muted small" style={{ margin: 0 }}>{unseen.hidden.toLocaleString()} more {unseen.hidden === 1 ? 'is' : 'are'} hidden by the filters at the top.</p>}
      {tab === 'marks' && !marked.length && <p className="muted" style={{ margin: 0 }}>{gp && t.keys.length ? 'Mark photos in the Google Photos search tab, or open any photo and mark it in the side panel.' : 'Open any photo (in Photos, Folders…) and mark it ✓ for this topic in the side panel.'}</p>}
      <MarkGrid items={list} t={t} sureOf={tab === 'found' ? sureOf : undefined} onOpen={onOpen} />
    </>
  );
}

export function Search({ items, all, onOpen, onSetup }: { items: Item[]; all: Item[]; onOpen: (list: Item[], i: number) => void; onSetup: () => void }) {
  const st = useTopics();
  const [open, setOpen] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [free, setFree] = useState<{ query: string; keys: string[] } | null>(null);
  const [freeBusy, setFreeBusy] = useState<number | null>(null);
  const [freeErr, setFreeErr] = useState('');
  const version = helperVersion();
  const needsUpdate = !!version && older(version, SEARCH_VERSION);
  const byKey = useMemo(() => new Map(all.filter((x) => x.gp).map((x) => [x.gp!.key, x])), [all]);
  const gp = byKey.size > 0;
  const shownIds = useMemo(() => new Set(items.map((x) => x.id)), [items]);
  const inApp = useMemo(() => new Set(all.map((x) => x.id)), [all]);
  const pick = (keys: string[]) => keys.map((k) => byKey.get(k)).filter((x): x is Item => !!x && shownIds.has(x.id));
  const missingOf = (keys: string[]) => keys.filter((k) => !byKey.has(k)).length;
  const running = !!st.run.id || freeBusy != null;

  // When a topic's search finishes, show what it found.
  const was = useRef<string | undefined>();
  useEffect(() => { if (was.current && !st.run.id && !st.run.error) setOpen(was.current); was.current = st.run.id; }, [st.run.id, st.run.error]);

  const topic = st.topics.find((t) => t.id === open);
  const freeResults = useMemo(() => (open === 'free' && free ? pick(free.keys) : []), [open, free, byKey, shownIds]); // eslint-disable-line react-hooks/exhaustive-deps

  const searchFree = async () => {
    const query = q.trim();
    if (!query) return;
    setFreeErr(''); setFreeBusy(0);
    try { const keys = await searchOnce(query, setFreeBusy); setFree({ query, keys }); setOpen('free'); } catch (e) { setFreeErr((e as Error).message); } finally { setFreeBusy(null); }
  };

  const editTopicObj = st.topics.find((t) => t.id === editing);
  return (
    <div className="stack" style={{ maxWidth: 'none' }}>
      <div className="panel">
        {gp ? (
          <p className="muted" style={{ margin: 0 }}>Each topic starts from Google Photos' own search, which is quick but loose. Mark photos ✓ (belongs) or ✗ (doesn't), then <b>Find more like these</b>: the app learns from your marks on this computer and looks through all your photos, including folders and Drive. Nothing in Google Photos is changed. Topics and marks are saved in your backup.</p>
        ) : (
          <p className="muted" style={{ margin: 0 }}>Open a photo and mark it ✓ for a topic (in the side panel), mark a few that don't belong ✗, then <b>Find more like these</b>: the app learns from your marks on this computer and looks through all your photos. Google Photos' search can also start a topic once your Google Photos library is read (<button className="link" onClick={onSetup}>Choose photos</button>).</p>
        )}
        {gp && (needsUpdate || st.run.error === OLD_HELPER || freeErr === OLD_HELPER) && <UpdateHelper have={version} need={SEARCH_VERSION} what="search" />}
        {gp && !version && <p className="notice" style={{ margin: 0 }}>The helper add-on isn't installed in this browser, so Google Photos' search can't run. See Choose photos › Google Photos.</p>}
        {gp && (
          <div className="row">
            <input className="search" type="search" placeholder="Search Google Photos, like “dashboard” or “battery”" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && !running && searchFree()} style={{ flex: '1 1 260px' }} />
            <button className="btn primary" disabled={running || !q.trim()} onClick={searchFree}>{freeBusy != null ? `Searching… ${freeBusy.toLocaleString()} found` : 'Search'}</button>
          </div>
        )}
        {freeErr && freeErr !== OLD_HELPER && <p className="error" style={{ margin: 0 }}>{freeErr}</p>}
        {st.run.error && st.run.error !== OLD_HELPER && <p className="error" style={{ margin: 0 }}>{st.run.error}</p>}
      </div>
      {!all.length ? (
        <div className="panel">
          <h2 style={{ margin: 0 }}>No photos in the app yet</h2>
          <p className="muted" style={{ margin: 0 }}>Read your photos first (Google Photos, Drive or a folder), then come back here. Your topics and marks are kept.</p>
          <div className="row"><button className="btn primary" onClick={onSetup}>Choose photos</button></div>
        </div>
      ) : editTopicObj ? <EditTopic key={editTopicObj.id} t={editTopicObj} onDone={() => setEditing(null)} /> : (
        <>
          <div className="topics">
            {st.topics.map((t) => {
              // Only photos in the app's list (and not hidden by the filters at the top) can be shown.
              const mem = t.learnedAt ? members(t) : [];
              const n = mem.filter((id) => shownIds.has(id)).length;
              const away = mem.filter((id) => !inApp.has(id)).length;
              return <TopicCard key={t.id} t={t} n={n} away={away} google={pick(t.keys).length} missing={missingOf(t.keys)} busy={running} gp={gp} open={open === t.id} onOpen={() => setOpen(open === t.id ? null : t.id)} onEdit={() => setEditing(t.id)} />;
            })}
          </div>
          <NewTopic onMade={(t) => setOpen(t.id)} />
        </>
      )}
      {topic && !editTopicObj && all.length > 0 && <TopicView key={topic.id} t={topic} all={all} shownIds={shownIds} byKey={byKey} gp={gp} onOpen={onOpen} onClose={() => setOpen(null)} onSetup={onSetup} />}
      {open === 'free' && free && (
        <>
          <div className="row">
            <h2 style={{ margin: 0 }}>“{free.query}” · {freeResults.length.toLocaleString()} {freeResults.length === 1 ? 'photo' : 'photos'}</h2>
            {!st.topics.some((t) => t.queries.length === 1 && t.queries[0].toLowerCase() === free.query.toLowerCase()) && (
              <button className="btn small" onClick={async () => { const t = await saveTopic(free.query, [free.query], free.keys, { [free.query]: free.keys.length }); setOpen(t.id); }}>Keep as a topic (to mark ✓ / ✗)</button>
            )}
            <button className="btn small" onClick={() => setOpen(null)}>Close</button>
          </div>
          {missingOf(free.keys) > 0 && <p className="muted" style={{ margin: 0 }}>Google Photos found more that aren't in the app yet (added since it last read your library). <button className="link" onClick={onSetup}>Read Google Photos again</button> to see them.</p>}
          <MonthGrid items={freeResults} onOpen={onOpen} />
        </>
      )}
    </div>
  );
}

/** Topic marks for the photo viewer's side panel. */
export function TopicMarks({ it }: { it: Item }) {
  const st = useTopics();
  if (!st.topics.length) return null;
  return (
    <div className="vtopics">
      <dt>Topics</dt>
      {st.topics.map((t) => {
        const m = markOf(t, it.id);
        return (
          <div key={t.id} className="vtopic">
            <span>{t.name}</span>
            <button className={m === 'yes' ? 'on yes' : ''} aria-pressed={m === 'yes'} title={`Belongs to ${t.name}`} onClick={() => markTopic(t.id, it.id, m === 'yes' ? null : 'yes')}>✓</button>
            <button className={m === 'no' ? 'on no' : ''} aria-pressed={m === 'no'} title={`Doesn't belong to ${t.name}`} onClick={() => markTopic(t.id, it.id, m === 'no' ? null : 'no')}>✗</button>
          </div>
        );
      })}
    </div>
  );
}
