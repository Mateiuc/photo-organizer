import { useEffect, useMemo, useRef, useState } from 'react';
import type { Item } from '../lib/model';
import { helperVersion, OLD_HELPER, older, SEARCH_VERSION } from '../gphotos/bridge';
import { deleteTopic, editTopic, parseQueries, PRESETS, runTopic, saveTopic, searchOnce, stopSearch, useTopics, type Topic } from '../search/topics';
import { MonthGrid } from './Grid';
import { when } from './Backup';

const EDGE = typeof navigator !== 'undefined' && /\bEdg\//.test(navigator.userAgent);

/** How to put the new helper add-on in place of the old one. */
export function UpdateHelper({ have }: { have?: string }) {
  return (
    <div className="notice">
      <p style={{ marginTop: 0 }}><b>The helper add-on needs an update for search</b>{have ? ` (this browser has version ${have}; search needs ${SEARCH_VERSION})` : ''}. It takes a minute:</p>
      <ol className="steps">
        <li><a href={`${import.meta.env.BASE_URL}photo-organizer-helper.zip`} download>Download the new helper</a> and unzip it over the old helper folder, replacing the files.</li>
        <li>Open <code>{EDGE ? 'edge://extensions' : 'chrome://extensions'}</code> and click the reload button (circular arrow) on “Photo Organizer helper”.</li>
        <li>Come back here and reload this page.</li>
      </ol>
    </div>
  );
}

function TopicCard({ t, n, missing, running, open, onOpen, onEdit }: { t: Topic; n: number; missing: number; running: boolean; open: boolean; onOpen: () => void; onEdit: () => void }) {
  const st = useTopics();
  const r = st.run;
  const mine = r.id === t.id;
  return (
    <div className={`panel topic ${open ? 'on' : ''}`}>
      <div className="row" style={{ justifyContent: 'space-between' }}><b>{t.name}</b><button className="link" onClick={onEdit}>Edit</button></div>
      <span className="muted small">Searches: {t.queries.map((q) => (t.counts?.[q] != null ? `${q} (${t.counts[q].toLocaleString()})` : q)).join(', ')}</span>
      {mine ? (
        <>
          <span>Searching “{r.query}” ({Math.min(r.done + 1, r.total)} of {r.total}): {r.found.toLocaleString()} found</span>
          <div className="progress"><i style={{ width: `${r.total ? (100 * r.done) / r.total : 0}%` }} /></div>
          <div className="row"><button className="btn small" onClick={stopSearch}>Stop</button></div>
        </>
      ) : (
        <>
          <span className="muted small">{t.at ? `${n.toLocaleString()} photos · searched ${when(t.at)}${missing ? ` · ${missing.toLocaleString()} more not in the app yet` : ''}` : 'Not searched yet'}</span>
          <div className="row">
            {t.at && <button className={`btn small ${open ? 'primary' : ''}`} onClick={onOpen}>Show {n.toLocaleString()}</button>}
            <button className={`btn small ${t.at ? '' : 'primary'}`} disabled={running} onClick={() => runTopic(t.id)}>{t.at ? 'Search again' : 'Search'}</button>
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
  return (
    <div className="panel">
      <b>Edit “{t.name}”</b>
      <label className="field">Name<input value={name} onChange={(e) => setName(e.target.value)} /></label>
      <label className="field">Searches, separated by commas. Each one is typed into Google Photos' search; the topic shows everything they find.
        <textarea rows={3} value={text} onChange={(e) => setText(e.target.value)} />
      </label>
      <p className="muted small" style={{ margin: 0 }}>Tip: Google Photos also finds text inside photos, so a word written on a label or plate works. If your Google Photos is in another language, words in that language may work better.</p>
      <div className="row">
        <button className="btn primary" disabled={!queries.length || !name.trim()} onClick={async () => { await editTopic(t.id, name, queries); onDone(); }}>Save</button>
        <button className="btn" onClick={onDone}>Cancel</button>
        {preset && <button className="btn" onClick={() => { setName(preset.name); setText(preset.queries.join(', ')); }}>Back to the suggested searches</button>}
        {!preset && <button className="btn danger" onClick={async () => { if (confirm(`Remove the topic “${t.name}”? Your photos are not touched.`)) { await deleteTopic(t.id); onDone(); } }}>Remove topic</button>}
      </div>
    </div>
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
  const shownIds = useMemo(() => new Set(items.map((x) => x.id)), [items]);
  const pick = (keys: string[]) => keys.map((k) => byKey.get(k)).filter((x): x is Item => !!x && shownIds.has(x.id));
  const missingOf = (keys: string[]) => keys.filter((k) => !byKey.has(k)).length;
  const running = !!st.run.id || freeBusy != null;

  // When a topic's search finishes, show what it found.
  const was = useRef<string | undefined>();
  useEffect(() => { if (was.current && !st.run.id && !st.run.error) setOpen(was.current); was.current = st.run.id; }, [st.run.id, st.run.error]);

  const shown = open === 'free' ? free : st.topics.find((t) => t.id === open);
  const results = useMemo(() => (shown ? pick(shown.keys) : []), [shown, byKey, shownIds]); // eslint-disable-line react-hooks/exhaustive-deps
  const title = open === 'free' ? `“${free?.query}”` : (shown as Topic | undefined)?.name;

  const searchFree = async () => {
    const query = q.trim();
    if (!query) return;
    setFreeErr(''); setFreeBusy(0);
    try { const keys = await searchOnce(query, setFreeBusy); setFree({ query, keys }); setOpen('free'); } catch (e) { setFreeErr((e as Error).message); } finally { setFreeBusy(null); }
  };

  if (!byKey.size) {
    return (
      <div className="panel">
        <h2>Search by what's in the photos</h2>
        <p className="muted">Search uses Google Photos' own search, which knows what is in each picture (cars, wires…) and reads text in them (like a VIN). Read your Google Photos first, then come back here. For photos in a folder or in Drive, the app's own search comes later.</p>
        <div className="row"><button className="btn primary" onClick={onSetup}>Choose photos</button></div>
      </div>
    );
  }
  const editTopicObj = st.topics.find((t) => t.id === editing);
  return (
    <div className="stack" style={{ maxWidth: 'none' }}>
      <div className="panel">
        <p className="muted" style={{ margin: 0 }}>Search with Google Photos' own search: it knows what is in each picture (cars, wires…) and reads text in them (like a VIN). The app asks it through the helper add-on and shows the results here. Nothing in Google Photos is changed. What each topic finds is kept, and saved in your backup.</p>
        {(needsUpdate || st.run.error === OLD_HELPER || freeErr === OLD_HELPER) && <UpdateHelper have={version} />}
        {!version && <p className="notice" style={{ margin: 0 }}>The helper add-on isn't installed in this browser. See Choose photos › Google Photos.</p>}
        <div className="row">
          <input className="search" type="search" placeholder="Search Google Photos, like “dashboard” or “battery”" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && !running && searchFree()} style={{ flex: '1 1 260px' }} />
          <button className="btn primary" disabled={running || !q.trim()} onClick={searchFree}>{freeBusy != null ? `Searching… ${freeBusy.toLocaleString()} found` : 'Search'}</button>
        </div>
        {freeErr && freeErr !== OLD_HELPER && <p className="error" style={{ margin: 0 }}>{freeErr}</p>}
        {st.run.error && st.run.error !== OLD_HELPER && <p className="error" style={{ margin: 0 }}>{st.run.error}</p>}
      </div>
      {editTopicObj ? <EditTopic key={editTopicObj.id} t={editTopicObj} onDone={() => setEditing(null)} /> : (
        <div className="topics">
          {st.topics.map((t) => <TopicCard key={t.id} t={t} n={pick(t.keys).length} missing={missingOf(t.keys)} running={running} open={open === t.id} onOpen={() => setOpen(open === t.id ? null : t.id)} onEdit={() => setEditing(t.id)} />)}
        </div>
      )}
      {shown && (
        <>
          <div className="row">
            <h2 style={{ margin: 0 }}>{title} · {results.length.toLocaleString()} {results.length === 1 ? 'photo' : 'photos'}</h2>
            {open === 'free' && free && !st.topics.some((t) => t.queries.length === 1 && t.queries[0].toLowerCase() === free.query.toLowerCase()) && (
              <button className="btn small" onClick={async () => { const t = await saveTopic(free.query, [free.query], free.keys, { [free.query]: free.keys.length }); setOpen(t.id); }}>Keep as a topic</button>
            )}
            <button className="btn small" onClick={() => setOpen(null)}>Close</button>
          </div>
          {missingOf(shown.keys) > 0 && <p className="muted" style={{ margin: 0 }}>{missingOf(shown.keys).toLocaleString()} more {missingOf(shown.keys) === 1 ? 'was' : 'were'} found in Google Photos but {missingOf(shown.keys) === 1 ? "isn't" : "aren't"} in the app yet (added since it last read your library). <button className="link" onClick={onSetup}>Read Google Photos again</button> to see them.</p>}
          {results.length < shown.keys.length - missingOf(shown.keys) && <p className="muted" style={{ margin: 0 }}>Some results are hidden by the filters at the top.</p>}
          <MonthGrid items={results} onOpen={onOpen} />
        </>
      )}
    </div>
  );
}
