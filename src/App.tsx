import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getFile, scanFolders, trashFile, type ScanProgress } from './drive/api';
import { demoLibrary } from './lib/demo';
import { applyFilters, emptyFilters, exactDuplicates, toItem, type Filters, type Folder, type Item, type Kind } from './lib/model';
import { folderIndex, Library, type Meta } from './lib/store';
import { askAccess, canWrite, fingerprint, isOpen, moveToTrash, pickFolder, rememberedFolder, scanFileList, scanFolder } from './local/fs';
import { clearThumbs } from './local/thumbs';
import { Duplicates } from './views/Duplicates';
import { Folders } from './views/Folders';
import { MonthGrid } from './views/Grid';
import { Places } from './views/Places';
import { Setup } from './views/Setup';
import { Viewer } from './views/Viewer';

type View = 'photos' | 'places' | 'folders' | 'duplicates' | 'setup';
const DEMO = new URLSearchParams(location.search).has('demo');
const lib = new Library(DEMO ? 'photo-organizer-demo' : 'photo-organizer');
const KINDS: { k: Kind; label: string }[] = [
  { k: 'photo', label: 'Photos' }, { k: 'video', label: 'Videos' }, { k: 'raw', label: 'RAW' }, { k: 'screenshot', label: 'Screenshots' },
];

export default function App() {
  const [items, setItems] = useState<Item[]>([]);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [meta, setMeta] = useState<Meta>({ roots: [] });
  const [loaded, setLoaded] = useState(false);
  const [view, setView] = useState<View>('photos');
  const [filters, setFilters] = useState<Filters>(emptyFilters);
  const [showFilters, setShowFilters] = useState(false);
  const [viewer, setViewer] = useState<{ list: Item[]; i: number } | null>(null);
  const [signedIn, setSignedIn] = useState(() => { try { return localStorage.getItem('po.signedIn') === '1'; } catch { return false; } });
  const [scanning, setScanning] = useState(false);
  const [progress, setProgress] = useState<ScanProgress | null>(null);
  const [error, setError] = useState('');
  const stopRef = useRef({ stop: false });

  useEffect(() => {
    (async () => {
      if (DEMO) {
        const d = demoLibrary();
        setItems(d.items); setFolders(d.folders); setMeta({ roots: [d.folders[0]] });
      } else {
        const d = await lib.load();
        setItems(d.items); setFolders(d.folders); setMeta(d.meta);
        if (!d.items.length) setView('setup');
      }
      setLoaded(true);
    })().catch((e) => { setError(String(e?.message ?? e)); setLoaded(true); });
  }, []);

  const fx = useMemo(() => folderIndex(folders), [folders]);
  const shown = useMemo(() => applyFilters(items, filters, fx.pathOf, fx.inFolder), [items, filters, fx]);
  const dupCount = useMemo(() => exactDuplicates(items).reduce((s, g) => s + g.length - 1, 0), [items]);
  const placeCount = useMemo(() => items.filter((i) => i.lat != null).length, [items]);

  type Walk = (onFolder: (folder: Folder, media: Item[], subs: Folder[]) => Promise<void>) => Promise<Folder[] | void>;
  /** Shared by both sources: fills the library while walking, then forgets files that are gone. */
  const runScan = useCallback(async (base: Meta, walk: Walk, local: boolean) => {
    setError(''); setScanning(true); stopRef.current = { stop: false };
    if (local) clearThumbs();
    const seen = new Set<string>();
    const found: Item[] = [];
    const pendingItems: Item[] = [], pendingFolders: Folder[] = [];
    let flushAt = Date.now();
    const flush = () => {
      if (pendingFolders.length) { const f = pendingFolders.splice(0); setFolders((prev) => { const by = new Map(prev.map((x) => [x.id, x])); f.forEach((x) => by.set(x.id, x)); return [...by.values()]; }); }
      if (pendingItems.length) { const it = pendingItems.splice(0); setItems((prev) => { const by = new Map(prev.map((x) => [x.id, x])); it.forEach((x) => by.set(x.id, x)); return [...by.values()]; }); }
    };
    try {
      const roots = await walk(async (_folder, its, subs) => {
        for (const s of subs) await lib.putFolder(s);
        pendingFolders.push(...subs);
        its.forEach((x) => { seen.add(x.id); found.push(x); });
        await lib.putItems(its);
        pendingItems.push(...its);
        if (Date.now() - flushAt > 1500) { flushAt = Date.now(); flush(); }
      });
      if (local && !stopRef.current.stop) {
        // Duplicate check: only files that share their exact size with another file need a fingerprint.
        const bySize = new Map<number, Item[]>();
        found.forEach((x) => { const g = bySize.get(x.size); g ? g.push(x) : bySize.set(x.size, [x]); });
        const todo = [...bySize.values()].filter((g) => g.length > 1).flat().filter((x) => !x.md5);
        for (let i = 0; i < todo.length && !stopRef.current.stop; i++) {
          if (i % 10 === 0) setProgress({ folders: 0, files: found.length, current: `checking for duplicates, ${i.toLocaleString()} of ${todo.length.toLocaleString()}` });
          const md5 = await fingerprint(todo[i].id).catch(() => undefined);
          if (md5) { const n = { ...todo[i], md5 }; await lib.putItems([n]); pendingItems.push(n); }
        }
      }
      flush();
      if (!stopRef.current.stop) {
        // forget files that are gone (deleted, moved away, or from a folder no longer chosen)
        const gone = (await lib.load()).items.filter((it) => !seen.has(it.id)).map((it) => it.id);
        if (gone.length) { await lib.removeItems(gone); setItems((prev) => prev.filter((x) => seen.has(x.id))); }
        const m2: Meta = { ...base, roots: roots || base.roots, lastScan: new Date().toISOString() };
        setMeta(m2); await lib.setMeta(m2);
        setView('photos');
      }
    } catch (e) {
      flush();
      if ((e as Error).name !== 'AbortError') setError((e as Error).message);
    } finally {
      setScanning(false); setProgress(null);
    }
  }, []);

  const scan = useCallback(async (roots: Folder[]) => {
    const m: Meta = { ...meta, roots, source: 'drive' };
    setMeta(m); await lib.setMeta(m);
    await runScan(m, async (onFolder) => {
      for (const r of roots) { await lib.putFolder(r); }
      setFolders((prev) => [...prev.filter((p) => !roots.some((r) => r.id === p.id)), ...roots]);
      await scanFolders(roots, async (folder, media, subs) => onFolder(folder, media.map(toItem).filter((x): x is Item => !!x), subs), setProgress, stopRef.current);
    }, false);
  }, [meta, runScan]);

  const scanDir = useCallback(async (dir: FileSystemDirectoryHandle) => {
    const m: Meta = { roots: [], source: 'local', localName: dir.name };
    const known = new Map(items.map((x) => [x.id, x]));
    await runScan(m, async (onFolder) => {
      const top = { id: 'local:' + dir.name, name: dir.name };
      await lib.putFolder(top); setFolders((prev) => [...prev.filter((p) => p.id !== top.id), top]);
      return [await scanFolder(dir, known, onFolder, setProgress, stopRef.current)];
    }, true);
  }, [items, runScan]);

  const chooseFolder = useCallback(async () => {
    try { await scanDir(await pickFolder()); } catch (e) { if ((e as Error).name !== 'AbortError') setError((e as Error).message); }
  }, [scanDir]);

  const chooseFiles = useCallback(async (list: File[]) => {
    const name = (list[0] as any)?.webkitRelativePath?.split('/')[0] ?? 'Folder';
    const known = new Map(items.map((x) => [x.id, x]));
    await runScan({ roots: [], source: 'local', localName: name }, async (onFolder) => {
      const top = await scanFileList(list, known, onFolder, setProgress, stopRef.current);
      return top ? [top] : [];
    }, true);
  }, [items, runScan]);

  /** After the browser restarts, files on this computer need one click to open again. */
  const reopen = useCallback(async () => {
    const h = await rememberedFolder();
    if (h && (await askAccess(h).catch(() => false))) await scanDir(h);
    else await chooseFolder();
  }, [scanDir, chooseFolder]);

  const itemsRef = useRef(items); itemsRef.current = items;
  const trash = useCallback(async (ids: string[]) => {
    const done: string[] = [];
    const by = new Map(itemsRef.current.map((x) => [x.id, x]));
    try {
      for (let i = 0; i < ids.length; i += 5) {
        const batch = ids.slice(i, i + 5);
        if (!DEMO) {
          const local = batch.filter((id) => by.get(id)?.local);
          for (const id of local) { await moveToTrash(by.get(id)!); done.push(id); }
          await Promise.all(batch.filter((id) => !by.get(id)?.local).map((id) => trashFile(id)));
          done.push(...batch.filter((id) => !by.get(id)?.local));
        } else done.push(...batch);
      }
    } finally {
      await lib.removeItems(done);
      setItems((prev) => prev.filter((x) => !done.includes(x.id)));
    }
  }, []);

  // Drive preview links expire after some hours: refresh one when it fails to load.
  const refreshing = useRef(new Set<string>());
  const onBroken = useCallback((it: Item) => {
    if (DEMO || !signedIn || refreshing.current.has(it.id)) return;
    refreshing.current.add(it.id);
    getFile(it.id).then((f) => { const n = toItem(f); if (n?.thumb && n.thumb !== it.thumb) { lib.putItems([n]); setItems((prev) => prev.map((x) => (x.id === n.id ? n : x))); } }).catch(() => {});
  }, [signedIn]);

  const isLocal = meta.source === 'local';
  const needsReopen = !DEMO && isLocal && items.length > 0 && !isOpen() && !scanning;
  const open = useCallback((list: Item[], i: number) => setViewer({ list, i }), []);
  const nav = (v: View, label: string, n?: number) => (
    <button className={`nav ${view === v ? 'on' : ''}`} onClick={() => setView(v)}>{label}{n != null && <span>{n.toLocaleString()}</span>}</button>
  );
  const kindsOn = (k: Kind) => filters.kinds.includes(k);
  const active = filters.kinds.length || filters.q || filters.from || filters.to || filters.minSize != null || filters.withPlace !== 'any' || filters.folderId;

  if (!loaded) return <div className="more">Opening your library…</div>;
  return (
    <div className="shell">
      <nav className="rail" aria-label="Views">
        <div className="brand"><img src={`${import.meta.env.BASE_URL}icon.svg`} alt="" />Photo Organizer</div>
        {nav('photos', 'Photos', items.length)}
        {nav('places', 'Places', placeCount)}
        {nav('folders', 'Folders')}
        {nav('duplicates', 'Duplicates', dupCount)}
        <div className="grow" />
        {nav('setup', 'Choose photos')}
        <div className="who">{DEMO ? 'Sample photos' : isLocal ? `Folder: ${meta.localName ?? ''}` : signedIn ? 'Connected to Drive' : 'Not connected'}</div>
      </nav>
      <div className="main">
        <header className="top">
          <h1>{{ photos: 'Photos', places: 'Places', folders: 'Folders', duplicates: 'Duplicates', setup: 'Choose photos' }[view]}</h1>
          {view !== 'setup' && view !== 'folders' && (
            <>
              <input className="search" type="search" id="q" placeholder="Search names, folders, camera…" value={filters.q} onChange={(e) => setFilters({ ...filters, q: e.target.value })} />
              {KINDS.map(({ k, label }) => (
                <button key={k} className={`chip ${kindsOn(k) ? 'on' : ''}`} onClick={() => setFilters({ ...filters, kinds: kindsOn(k) ? filters.kinds.filter((x) => x !== k) : [...filters.kinds, k] })}>{label}</button>
              ))}
              <button className={`chip ${showFilters ? 'on' : ''}`} onClick={() => setShowFilters(!showFilters)}>More filters</button>
              {active ? <button className="chip" onClick={() => setFilters(emptyFilters)}>Clear</button> : null}
              <span className="count">{shown.length.toLocaleString()} of {items.length.toLocaleString()}</span>
            </>
          )}
        </header>
        <div style={{ display: 'grid', gridTemplateRows: 'auto 1fr', minHeight: 0 }}>
          {showFilters && view !== 'setup' && view !== 'folders' ? (
            <div className="filters">
              <label>From<input type="date" id="from" value={filters.from ?? ''} onChange={(e) => setFilters({ ...filters, from: e.target.value || undefined })} /></label>
              <label>To<input type="date" id="to" value={filters.to ?? ''} onChange={(e) => setFilters({ ...filters, to: e.target.value || undefined })} /></label>
              <label>Bigger than (MB)<input type="number" id="minmb" min="0" step="0.5" value={filters.minSize != null ? filters.minSize / 1e6 : ''} onChange={(e) => setFilters({ ...filters, minSize: e.target.value ? Number(e.target.value) * 1e6 : undefined })} style={{ width: 110 }} /></label>
              <label>Smaller than (MB)<input type="number" id="maxmb" min="0" step="0.5" value={filters.maxSize != null ? filters.maxSize / 1e6 : ''} onChange={(e) => setFilters({ ...filters, maxSize: e.target.value ? Number(e.target.value) * 1e6 : undefined })} style={{ width: 110 }} /></label>
              <label>Location<select id="place" value={filters.withPlace} onChange={(e) => setFilters({ ...filters, withPlace: e.target.value as Filters['withPlace'] })}><option value="any">Any</option><option value="yes">Has a place</option><option value="no">No place</option></select></label>
              {filters.folderId && <span className="chip on" onClick={() => setFilters({ ...filters, folderId: undefined })}>Folder: {fx.by.get(filters.folderId)?.name} ✕</span>}
            </div>
          ) : <div />}
          <main className="content">
            {error && <p className="notice">{error}</p>}
            {needsReopen && view !== 'setup' && <div className="notice row" style={{ marginBottom: 12 }}><span>To show the pictures, the browser needs your OK to open “{meta.localName}” again.</span><button className="btn primary" onClick={reopen}>Open folder</button></div>}
            {view === 'photos' && (items.length ? <MonthGrid items={shown} onOpen={open} onBroken={onBroken} /> : <div className="panel"><h2>No photos yet</h2><p className="muted">Choose a folder with photos to get started.</p><div className="row"><button className="btn primary" onClick={() => setView('setup')}>Choose folder</button></div></div>)}
            {view === 'places' && <Places items={shown} onOpen={open} />}
            {view === 'folders' && <Folders folders={folders} items={items} roots={meta.roots.length ? meta.roots : fx.children(undefined)} children={fx.children} onPick={(f) => { setFilters({ ...emptyFilters, folderId: f.id }); setShowFilters(true); setView('photos'); }} />}
            {view === 'duplicates' && <Duplicates items={shown} pathOf={fx.pathOf} onTrash={trash} onOpen={open} readOnly={!DEMO && (isLocal ? !canWrite || needsReopen : !signedIn)} local={isLocal} />}
            {view === 'setup' && <Setup demo={DEMO} source={meta.source} localName={meta.localName} onChooseFolder={chooseFolder} onChooseFiles={chooseFiles} roots={meta.source === 'drive' ? meta.roots : []} signedIn={signedIn} setSignedIn={setSignedIn} onScan={scan} scanning={scanning} progress={progress} onStop={() => { stopRef.current.stop = true; }} lastScan={meta.lastScan} onClear={async () => { await lib.clear(); setItems([]); setFolders([]); setMeta({ roots: [] }); }} />}
          </main>
        </div>
      </div>
      {viewer && <Viewer list={viewer.list} index={viewer.i} setIndex={(i) => setViewer({ ...viewer, i })} pathOf={fx.pathOf} onClose={() => setViewer(null)} />}
    </div>
  );
}
