import { useEffect, useState } from 'react';
import { clientId, listChildren, listComputers, signIn, signOut, type ScanProgress } from '../drive/api';
import { canWrite, TRASH } from '../local/fs';
import type { Folder } from '../lib/model';
import { connect } from '../gphotos/api';
import { helperVersion } from '../gphotos/bridge';

const EDGE = typeof navigator !== 'undefined' && /\bEdg\//.test(navigator.userAgent);
const CHROMIUM = typeof navigator !== 'undefined' && /(Chrome|Chromium|Edg)\//.test(navigator.userAgent) && !/Mobile|Android/.test(navigator.userAgent);

/** Google Photos through the helper add-on: install steps, then reading the library. */
function GooglePhotos({ demo, scanning, progressBox, count, lastScan, onScan }: { demo: boolean; scanning: string | false; progressBox: React.ReactNode; count: number; lastScan?: string; onScan: () => Promise<void> }) {
  const [helper, setHelper] = useState(helperVersion());
  const [account, setAccount] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  useEffect(() => { if (helper) return; const t = setInterval(() => setHelper(helperVersion()), 1500); return () => clearInterval(t); }, [helper]);
  const page = EDGE ? 'edge://extensions' : 'chrome://extensions';
  const go = async () => {
    setErr(''); setBusy(true);
    try { setAccount(await connect()); setBusy(false); await onScan(); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <section className="panel">
      <h2>Google Photos</h2>
      <p className="muted">See and organize your Google Photos library without downloading it and without Google Takeout. A small helper add-on for Chrome or Edge lets the app use your own signed-in Google Photos tab, the same way the Google Photos website works. Your photos stay in Google Photos and nothing is sent anywhere else.</p>
      {!helper && !CHROMIUM ? <p className="notice" style={{ margin: 0 }}>The helper add-on works in Chrome or Edge on a computer. Open this page there to use Google Photos.</p>
        : !helper ? (
          <>
            <ol className="steps">
              <li><a href={`${import.meta.env.BASE_URL}photo-organizer-helper.zip`} download>Download the helper add-on</a>, then unzip it into a folder you'll keep, for example Documents › Photo Organizer helper.</li>
              <li>Open <code>{page}</code> in a new tab <button className="btn small" onClick={() => { navigator.clipboard?.writeText(page).then(() => setCopied(true), () => {}); }}>{copied ? 'Copied' : 'Copy'}</button> and switch on <b>Developer mode</b>.</li>
              <li>Click <b>Load unpacked</b> and choose the folder you unzipped.</li>
              <li>Come back to this page and reload it.</li>
            </ol>
            <div className="row"><button className="btn" onClick={() => location.reload()}>I've added it: reload this page</button></div>
          </>
        ) : (
          <>
            <p style={{ margin: 0 }}>Helper add-on is installed.{account && <> Google Photos account: <b>{account}</b>.</>}</p>
            {count > 0 && scanning !== 'gp' && <p style={{ margin: 0 }}><b>{count.toLocaleString()}</b> photos and videos from Google Photos{lastScan && <span className="muted"> · read {new Date(lastScan).toLocaleString()}</span>}</p>}
            {scanning === 'gp' && progressBox}
            {!scanning && <div className="row"><button className="btn primary" disabled={demo || busy} onClick={go}>{busy ? 'Connecting…' : count ? 'Read Google Photos again' : 'Read my Google Photos'}</button></div>}
            {err && <p className="error">{err}</p>}
            <p className="muted">The app uses a Google Photos tab in this browser. If none is open, it opens one in the background: leave it open while the app works. Reading takes about a minute for every 10,000 photos and videos; after that the app opens instantly. Removing or changing photos in Google Photos isn't switched on yet.</p>
          </>
        )}
    </section>
  );
}

function PickerNode({ f, depth, selected, toggle, under = [] }: { f: Folder; depth: number; selected: Map<string, Folder>; toggle: (f: Folder, under: string[]) => void; under?: string[] }) {
  const inherited = under.some((id) => selected.has(id)); // a parent folder is ticked, so this one is included
  const [kids, setKids] = useState<Folder[] | null>(null);
  const [open, setOpen] = useState(false);
  const [err, setErr] = useState('');
  const expand = async () => {
    if (!open && !kids) {
      try { setKids((await listChildren(f.id, true)).map((k) => ({ id: k.id, name: k.name, parentId: f.id }))); }
      catch (e) { setErr((e as Error).message); }
    }
    setOpen(!open);
  };
  return (
    <div>
      <div className="tnode" style={{ paddingLeft: 6 + depth * 18 }}>
        <button className="tog" onClick={expand} aria-label={open ? 'Collapse' : 'Show subfolders'}>{open ? '▾' : '▸'}</button>
        <input type="checkbox" id={'pick-' + f.id} checked={inherited || selected.has(f.id)} disabled={inherited} title={inherited ? 'Included with its parent folder' : undefined} onChange={() => toggle(f, under)} />
        <label className="name" htmlFor={'pick-' + f.id}>{f.name}</label>
      </div>
      {err && <div className="error" style={{ paddingLeft: 40 }}>{err}</div>}
      {open && kids?.map((k) => <PickerNode key={k.id} f={k} depth={depth + 1} selected={selected} toggle={toggle} under={[...under, f.id]} />)}
      {open && kids && !kids.length && <div className="muted" style={{ paddingLeft: 52 + depth * 18, fontSize: 12 }}>No subfolders</div>}
    </div>
  );
}

export function Setup({ source, localName, onChooseFolder, onChooseFiles, roots, signedIn, setSignedIn, onScan, scanning, progress, onStop, lastScan, onClear, demo, gpCount, gpLastScan, onScanGp }: {
  source?: 'local' | 'drive'; localName?: string; onChooseFolder: () => void; onChooseFiles: (f: File[]) => void;
  roots: Folder[]; signedIn: boolean; setSignedIn: (b: boolean) => void; onScan: (roots: Folder[]) => void; scanning: false | 'local' | 'drive' | 'gp';
  progress: ScanProgress | null; onStop: () => void; lastScan?: string; onClear: () => void; demo: boolean;
  gpCount: number; gpLastScan?: string; onScanGp: () => Promise<void>;
}) {
  const [cid, setCid] = useState(clientId());
  const [err, setErr] = useState('');
  const [selected, setSelected] = useState<Map<string, Folder>>(() => new Map(roots.map((r) => [r.id, r])));
  // Remember each ticked folder's parents, so ticking a parent replaces any of its subfolders ticked before.
  const [parentsOf] = useState(() => new Map<string, string[]>());
  const toggle = (f: Folder, under: string[]) => setSelected((s) => {
    const x = new Map(s);
    if (x.has(f.id)) x.delete(f.id);
    else {
      x.set(f.id, f); parentsOf.set(f.id, under);
      for (const id of [...x.keys()]) if (parentsOf.get(id)?.includes(f.id)) x.delete(id);
    }
    return x;
  });
  const saveCid = () => { try { localStorage.setItem('po.clientId', cid.trim()); } catch {} setErr(''); };
  const doSignIn = async () => { setErr(''); try { saveCid(); await signIn('consent'); setSignedIn(true); } catch (e) { setErr((e as Error).message); } };
  const progressBox = scanning && progress && (
    <>
      <div className="stats"><div><b>{progress.files.toLocaleString()}</b><span>photos and videos found</span></div>{progress.folders > 0 && <div><b>{progress.folders.toLocaleString()}</b><span>{scanning === 'gp' ? 'albums read' : 'folders read'}</span></div>}</div>
      <div className="muted">Reading “{progress.current}”…</div>
      <div className="row"><button className="btn" onClick={onStop}>Stop</button></div>
    </>
  );
  const [showDrive, setShowDrive] = useState(source === 'drive');
  // Backed-up computers ("Computers" in Drive) sit outside My Drive, so they're listed separately.
  const [computers, setComputers] = useState<Folder[] | null>(null);
  useEffect(() => {
    if (!signedIn || !showDrive || computers) return;
    listComputers().then((c) => setComputers(c.map((f) => ({ id: f.id, name: f.name }))), () => setComputers([]));
  }, [signedIn, showDrive, computers]);
  return (
    <div className="stack">
      {demo && <div className="notice">You're looking at sample photos. Remove <code>?demo</code> from the address to use your own.</div>}
      <section className="panel">
        <h2>Choose a folder with photos</h2>
        <p className="muted">Pick any folder: on this computer, on a USB disk or memory card, or a Google Drive, OneDrive or Dropbox folder synced to this PC. Subfolders are included. Nothing is uploaded and nothing is moved: the app only reads the files where they are.</p>
        <p className="notice" style={{ margin: 0 }}>Photos in Google Drive? Use <b>“Or read Google Drive directly”</b> below instead. It reads dates, places and duplicates straight from Google without downloading your photos, so it's much faster and uses no disk space.</p>
        {source === 'local' && localName && !scanning && <p>Current folder: <b>{localName}</b>{lastScan && <span className="muted"> · read {new Date(lastScan).toLocaleString()}</span>}</p>}
        {!scanning && (
          <div className="row">
            {canWrite ? (
              <button className="btn primary" disabled={demo} onClick={onChooseFolder}>{source === 'local' && localName ? 'Choose folder again' : 'Choose folder'}</button>
            ) : (
              <label className={`btn primary ${demo ? 'disabled' : ''}`}>
                Choose folder
                <input type="file" multiple hidden disabled={demo} {...{ webkitdirectory: '', directory: '' }} onChange={(e) => { const f = [...(e.target.files ?? [])]; e.target.value = ''; if (f.length) onChooseFiles(f); }} />
              </label>
            )}
          </div>
        )}
        {scanning === 'local' && progressBox}
        {!canWrite && <p className="muted">In this browser the app can look at photos but not move duplicates. Use Chrome or Edge on a computer for that.</p>}
        <p className="muted">Removing duplicates moves the extra copies into a folder called <code>{TRASH}</code> inside the folder you chose, so you can check them before deleting them yourself.</p>
      </section>

      <GooglePhotos demo={demo} scanning={scanning} progressBox={progressBox} count={gpCount} lastScan={gpLastScan} onScan={onScanGp} />

      <section className="panel">
        <button className="btn" style={{ justifyContent: "flex-start", textAlign: "left" }} onClick={() => setShowDrive(!showDrive)} aria-expanded={showDrive}>{showDrive ? '▾' : '▸'} Or read Google Drive directly, without syncing it to this PC</button>
        {showDrive && (
          <div className="stack" style={{ marginTop: 16 }}>
      <div>
        <h2>1 · Connect Google Drive</h2>
        <p className="muted">The app reads your Drive directly from this browser. Your photos are never sent anywhere else. It can only change files when you confirm an action, such as moving duplicates to the trash.</p>
        {false && (
          <label style={{ display: 'grid', gap: 4 }}>
            <span className="muted">Google Client ID (from Google Cloud, ends in .apps.googleusercontent.com)</span>
            <input type="text" id="cid" value={cid} onChange={(e) => setCid(e.target.value)} placeholder="1234-abc.apps.googleusercontent.com" />
          </label>
        )}
        <div className="row">
          {!signedIn ? <button className="btn primary" onClick={doSignIn} disabled={demo || !cid.trim()}>Sign in with Google</button>
            : <><span>Connected to Google Drive.</span><button className="btn" onClick={() => { signOut(); setSignedIn(false); }}>Sign out</button></>}
        </div>
        {err && <p className="error">{err}</p>}
      </div>

      <div>
        <h2>2 · Choose folders to include</h2>
        <p className="muted">Tick the folders the app should look at. Ticking a folder includes all its subfolders. Nothing is moved.</p>
        {signedIn ? (
          <div className="tree">
            <PickerNode f={{ id: 'root', name: 'My Drive' }} depth={0} selected={selected} toggle={toggle} />
            {computers?.map((c) => <PickerNode key={c.id} f={c} depth={0} selected={selected} toggle={toggle} />)}
            <PickerNode f={{ id: 'shared', name: 'Shared with me' }} depth={0} selected={selected} toggle={toggle} />
          </div>
        ) : <p className="muted">Sign in first.</p>}
        <div className="row"><span className="muted">{selected.size ? [...selected.values()].map((f) => f.name).join(', ') : 'No folders chosen yet'}</span></div>
      </div>

      <div>
        <h2>3 · Scan</h2>
        <p className="muted">Reads the date, place, camera, size and type of every photo and video. 13,000 files take about 5 to 10 minutes. Run it again later to pick up new files.</p>
        {scanning === 'drive' && progressBox}
        <div className="row">
          {!scanning ? <button className="btn primary" disabled={!signedIn || !selected.size} onClick={() => onScan([...selected.values()])}>Scan {selected.size ? `${selected.size} folder${selected.size > 1 ? 's' : ''}` : ''}</button>
            : null}
          {source === 'drive' && lastScan && !scanning && <span className="muted">Last scan: {new Date(lastScan).toLocaleString()}</span>}
        </div>
      </div>

          </div>
        )}
      </section>

      <section className="panel">
        <h2>Library on this device</h2>
        <p className="muted">The app keeps what it learned in this browser so it opens fast. Clearing it changes none of your photos; just choose the folder again.</p>
        <div className="row"><button className="btn" onClick={onClear}>Clear library on this device</button></div>
      </section>
    </div>
  );
}
