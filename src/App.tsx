import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getFile, NEEDS_SIGN_IN, prepareSignIn, scanFolders, signIn, trashFile, type ScanProgress } from './drive/api';
import { demoLibrary } from './lib/demo';
import { applyFilters, emptyFilters, exactDuplicates, monthLabel, toItem, type Filters, type Folder, type Item, type Kind } from './lib/model';
import { folderIndex, Library, type Meta } from './lib/store';
import { askAccess, canWrite, fingerprint, isOpen, moveToTrash, pickFolder, rememberedFolder, scanFileList, scanFolder } from './local/fs';
import { clearThumbs } from './local/thumbs';
import { Duplicates } from './views/Duplicates';
import { Folders } from './views/Folders';
import { MonthGrid } from './views/Grid';
import { Places } from './views/Places';
import { People } from './views/People';
import { namesByItem } from './faces/people';
import { albumFolderId, GP_ROOT, scanAlbums, scanLibrary } from './gphotos/api';
import { Setup } from './views/Setup';
import { Viewer } from './views/Viewer';
import { allowAgain, startBackup, useBackup } from './lib/backup';
import { when } from './views/Backup';

type View = 'photos' | 'places' | 'people' | 'folders' | 'duplicates' | 'setup';
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
  const [scanning, setScanning] = useState<false | 'local' | 'drive' | 'gp'>(false);
  const [progress, setProgress] = useState<ScanProgress | null>(null);
  const [error, setError] = useState('');
  const stopRef = useRef({ stop: false });
  const metaRef = useRef(meta); metaRef.current = meta;

  useEffect(() => { if (signedIn && !DEMO) prepareSignIn(); }, [signedIn]);
  useEffect(() => {
    (async () => {
      if (DEMO) {
        const d = demoLibrary();
        setItems(d.items); setFolders(d.folders); setMeta({ roots: [d.folders[0]] });
      } else {
        const d = await lib.load();
        // Older scans saved files sitting directly in "My Drive" under Drive's hidden id instead of 'root'.
        if (d.meta.roots.some((r) => r.id === 'root')) {
          const known = new Set(d.folders.map((f) => f.id));
          const stray = new Set(d.items.filter((i) => i.folderId && !known.has(i.folderId)).map((i) => i.folderId));
          if (stray.size === 1) {
            d.items = d.items.map((i) => (i.folderId && stray.has(i.folderId) ? { ...i, folderId: 'root' } : i));
            await lib.putItems(d.items.filter((i) => i.folderId === 'root'));
          }
        }
        setItems(d.items); setFolders(d.folders); setMeta(d.meta);
        if (!d.items.length) setView('setup');
      }
      setLoaded(true);
      startBackup(lib, DEMO).catch(() => {});
    })().catch((e) => { setError(String(e?.message ?? e)); setLoaded(true); });
  }, []);

  const fx = useMemo(() => folderIndex(folders), [folders]);
  const shown = useMemo(() => {
    const names = filters.q ? namesByItem() : undefined; // people's names are searchable too
    return applyFilters(items, filters, fx.pathOf, fx.inFolder, names && ((it) => names.get(it.id)?.join(' ')));
  }, [items, filters, fx]);
  const dupCount = useMemo(() => exactDuplicates(items).reduce((s, g) => s + g.length - 1, 0), [items]);
  const placeCount = useMemo(() => items.filter((i) => i.lat != null).length, [items]);

  type Walk = (onFolder: (folder: Folder, media: Item[], subs: Folder[]) => Promise<void>) => Promise<Folder[] | void>;
  /**
   * Shared by every source: fills the library while walking, then forgets files that are gone.
   * Google Photos sits next to a folder or Drive: each scan only forgets items of its own kind.
   */
  const runScan = useCallback(async (base: Meta, walk: Walk, kind: 'local' | 'drive' | 'gp') => {
    const local = kind === 'local';
    const mine = (id: string) => (kind === 'gp') === id.startsWith('gp:');
    setError(''); setScanning(kind); stopRef.current = { stop: false };
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
        const gone = (await lib.load()).items.filter((it) => mine(it.id) && !seen.has(it.id)).map((it) => it.id);
        if (gone.length) { await lib.removeItems(gone); setItems((prev) => prev.filter((x) => !mine(x.id) || seen.has(x.id))); }
        const now = new Date().toISOString();
        const m2: Meta = kind === 'gp' ? { ...metaRef.current, gpLastScan: now } : { ...base, gpLastScan: metaRef.current.gpLastScan, roots: roots || base.roots, lastScan: now };
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
    try { await signIn(); } catch (e) { setError((e as Error).message); return; } // first, while the click still allows a popup
    const m: Meta = { ...meta, roots, source: 'drive' };
    setMeta(m); await lib.setMeta(m);
    await runScan(m, async (onFolder) => {
      for (const r of roots) { await lib.putFolder(r); }
      setFolders((prev) => [...prev.filter((p) => !roots.some((r) => r.id === p.id)), ...roots]);
      await scanFolders(roots, async (folder, media, subs) => onFolder(folder, media.map(toItem).filter((x): x is Item => !!x).map((x) => ({ ...x, folderId: folder.id })), subs), setProgress, stopRef.current);
    }, 'drive');
  }, [meta, runScan]);

  const scanDir = useCallback(async (dir: FileSystemDirectoryHandle) => {
    const m: Meta = { roots: [], source: 'local', localName: dir.name, gpLastScan: metaRef.current.gpLastScan };
    const known = new Map(items.map((x) => [x.id, x]));
    await runScan(m, async (onFolder) => {
      const top = { id: 'local:' + dir.name, name: dir.name };
      await lib.putFolder(top); setFolders((prev) => [...prev.filter((p) => p.id !== top.id), top]);
      return [await scanFolder(dir, known, onFolder, setProgress, stopRef.current)];
    }, 'local');
  }, [items, runScan]);

  const chooseFolder = useCallback(async () => {
    try { await scanDir(await pickFolder()); } catch (e) { if ((e as Error).name !== 'AbortError') setError((e as Error).message); }
  }, [scanDir]);

  const chooseFiles = useCallback(async (list: File[]) => {
    const name = (list[0] as any)?.webkitRelativePath?.split('/')[0] ?? 'Folder';
    const known = new Map(items.map((x) => [x.id, x]));
    await runScan({ roots: [], source: 'local', localName: name, gpLastScan: metaRef.current.gpLastScan }, async (onFolder) => {
      const top = await scanFileList(list, known, onFolder, setProgress, stopRef.current);
      return top ? [top] : [];
    }, 'local');
  }, [items, runScan]);

  /** Google Photos, through the helper add-on: the whole library, then which albums each item is in. */
  const scanGp = useCallback(async () => {
    const known = new Map(itemsRef.current.filter((x) => x.gp).map((x) => [x.id, x]));
    await runScan(metaRef.current, async (onFolder) => {
      await lib.putFolder(GP_ROOT);
      setFolders((prev) => [...prev.filter((p) => p.id !== GP_ROOT.id), GP_ROOT]);
      const all = await scanLibrary(known, (its) => onFolder(GP_ROOT, its, []), (p) => setProgress({ folders: 0, files: p.files, current: p.current ? `photos from ${monthLabel(p.current)}` : 'your library' }), stopRef.current);
      if (stopRef.current.stop) return;
      const albums = await scanAlbums((p) => setProgress({ folders: p.files, files: all.length, current: p.current }), stopRef.current);
      if (stopRef.current.stop) return;
      const byDedup = new Map<string, string[]>();
      for (const { album, dedupKeys } of albums) {
        const id = albumFolderId(album.key);
        for (const k of dedupKeys) { const a = byDedup.get(k); if (!a) byDedup.set(k, [id]); else if (!a.includes(id)) a.push(id); }
      }
      const albumFolders: Folder[] = albums.map(({ album }) => ({ id: albumFolderId(album.key), name: album.title, parentId: GP_ROOT.id }));
      const changed = all.filter((it) => (byDedup.get(it.gp!.dedup) ?? []).join() !== (it.gp!.albums ?? []).join())
        .map((it) => ({ ...it, gp: { ...it.gp!, albums: byDedup.get(it.gp!.dedup) } }));
      await onFolder(GP_ROOT, changed, albumFolders);
    }, 'gp');
  }, [runScan]);

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
    if (!DEMO && ids.some((id) => by.get(id)?.gp)) throw new Error('Removing from Google Photos isn’t switched on yet. It comes in the next step, once reading your library works well. Untick the Google Photos copies to remove the others.');
    if (!DEMO && ids.some((id) => !by.get(id)?.local)) await signIn(); // first, while the click still allows a popup
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
    if (DEMO || !signedIn || it.local || it.gp || refreshing.current.has(it.id)) return;
    refreshing.current.add(it.id);
    getFile(it.id).then((f) => { const t = toItem(f)?.thumb; if (t && t !== it.thumb) { const n = { ...it, thumb: t }; lib.putItems([n]); setItems((prev) => prev.map((x) => (x.id === n.id ? n : x))); } }).catch((e) => { refreshing.current.delete(it.id); if ((e as Error).message === NEEDS_SIGN_IN) setError(NEEDS_SIGN_IN); });
  }, [signedIn]);

  const isLocal = meta.source === 'local';
  const gpCount = useMemo(() => items.reduce((n, x) => n + (x.gp ? 1 : 0), 0), [items]);
  const folderRoots = useMemo(() => {
    const r = meta.roots.length ? [...meta.roots] : fx.children(undefined);
    if (gpCount && !r.some((x) => x.id === GP_ROOT.id)) r.push(GP_ROOT);
    return r;
  }, [meta.roots, fx, gpCount]);
  const needsReopen = !DEMO && isLocal && items.length > 0 && !isOpen() && !scanning;
  const open = useCallback((list: Item[], i: number) => setViewer({ list, i }), []);
  const nav = (v: View, label: string, n?: number) => (
    <button className={`nav ${view === v ? 'on' : ''}`} onClick={() => setView(v)}>{label}{n != null && <span>{n.toLocaleString()}</span>}</button>
  );
  const kindsOn = (k: Kind) => filters.kinds.includes(k);
  const active = filters.kinds.length || filters.q || filters.from || filters.to || filters.minSize != null || filters.withPlace !== 'any' || filters.folderId;

  const bk = useBackup();
  if (!loaded) return <div className="more">Opening your library…</div>;
  return (
    <div className="shell">
      <nav className="rail" aria-label="Views">
        <div className="brand"><img src={`${import.meta.env.BASE_URL}icon.svg`} alt="" />Photo Organizer</div>
        {nav('photos', 'Photos', items.length)}
        {nav('places', 'Places', placeCount)}
        {nav('people', 'People')}
        {nav('folders', 'Folders')}
        {nav('duplicates', 'Duplicates', dupCount)}
        <div className="grow" />
        {nav('setup', 'Choose photos')}
        {!DEMO && bk.supported && (
          <button className={`who bk ${!bk.folder || bk.needsPermission || bk.error ? 'warn' : ''}`} onClick={() => setView('setup')} title="Backup of your library, faces and names">
            {!bk.folder ? '⚠ Backup is off' : bk.needsPermission ? '⚠ Backup paused' : bk.error ? '⚠ Backup failed' : bk.saving ? 'Backup: saving…' : bk.savedAt ? `Backup ✓ ${when(bk.savedAt)}` : 'Backup: not saved yet'}
          </button>
        )}
        <div className="who">{DEMO ? 'Sample photos' : [isLocal ? `Folder: ${meta.localName ?? ''}` : meta.source === 'drive' ? (signedIn ? 'Connected to Drive' : 'Drive (not connected)') : '', gpCount ? 'Google Photos' : ''].filter(Boolean).join(' · ') || 'Not connected'}</div>
      </nav>
      <div className="main">
        <header className="top">
          <h1>{{ photos: 'Photos', places: 'Places', people: 'People', folders: 'Folders', duplicates: 'Duplicates', setup: 'Choose photos' }[view]}</h1>
          {view !== 'setup' && view !== 'folders' && (
            <>
              <input className="search" type="search" id="q" placeholder="Search names, people, folders, camera…" value={filters.q} onChange={(e) => setFilters({ ...filters, q: e.target.value })} />
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
            {error && (error === NEEDS_SIGN_IN
              ? <div className="notice row" style={{ marginBottom: 12 }}><span>{error}</span><button className="btn primary" onClick={() => signIn().then(() => { setSignedIn(true); setError(''); }, (e) => setError((e as Error).message))}>Sign in again</button></div>
              : <p className="notice">{error}</p>)}
            {bk.needsPermission && <div className="notice row" style={{ marginBottom: 12 }}><span>Backup paused: Chrome needs your OK to keep saving to “Photo Organizer backup”.</span><button className="btn primary" onClick={() => allowAgain()}>Allow saving</button></div>}
            {needsReopen && view !== 'setup' && <div className="notice row" style={{ marginBottom: 12 }}><span>To show the pictures, the browser needs your OK to open “{meta.localName}” again.</span><button className="btn primary" onClick={reopen}>Open folder</button></div>}
            {view === 'photos' && (items.length ? <MonthGrid items={shown} onOpen={open} onBroken={onBroken} /> : <div className="panel"><h2>No photos yet</h2><p className="muted">Choose a folder with photos to get started.</p><div className="row"><button className="btn primary" onClick={() => setView('setup')}>Choose folder</button></div></div>)}
            {view === 'places' && <Places items={shown} onOpen={open} />}
            {view === 'people' && <People items={shown} onOpen={open} readOnly={!DEMO && !gpCount && (isLocal ? needsReopen : !signedIn)} />}
            {view === 'folders' && <Folders folders={folders} items={items} roots={folderRoots} children={fx.children} onPick={(f) => { setFilters({ ...emptyFilters, folderId: f.id }); setShowFilters(true); setView('photos'); }} />}
            {view === 'duplicates' && <Duplicates items={shown} pathOf={fx.pathOf} onTrash={trash} onOpen={open} readOnly={!DEMO && (isLocal ? !canWrite || needsReopen : !signedIn)} local={isLocal} />}
            {view === 'setup' && <Setup demo={DEMO} source={meta.source} localName={meta.localName} onChooseFolder={chooseFolder} onChooseFiles={chooseFiles} roots={meta.source === 'drive' ? meta.roots : []} signedIn={signedIn} setSignedIn={setSignedIn} onScan={scan} scanning={scanning} progress={progress} onStop={() => { stopRef.current.stop = true; }} lastScan={meta.lastScan} onClear={async () => { await lib.clear(); setItems([]); setFolders([]); setMeta({ roots: [] }); }} gpCount={gpCount} gpLastScan={meta.gpLastScan} onScanGp={scanGp} />}
          </main>
        </div>
      </div>
      {viewer && <Viewer list={viewer.list} index={viewer.i} setIndex={(i) => setViewer({ ...viewer, i })} pathOf={fx.pathOf} onClose={() => setViewer(null)} />}
    </div>
  );
}
