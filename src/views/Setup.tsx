import { useState } from 'react';
import { clientId, listChildren, signIn, signOut, type ScanProgress } from '../drive/api';
import { canWrite, TRASH } from '../local/fs';
import type { Folder } from '../lib/model';

function PickerNode({ f, depth, selected, toggle }: { f: Folder; depth: number; selected: Map<string, Folder>; toggle: (f: Folder) => void }) {
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
        <input type="checkbox" id={'pick-' + f.id} checked={selected.has(f.id)} onChange={() => toggle(f)} />
        <label className="name" htmlFor={'pick-' + f.id}>{f.name}</label>
      </div>
      {err && <div className="error" style={{ paddingLeft: 40 }}>{err}</div>}
      {open && kids?.map((k) => <PickerNode key={k.id} f={k} depth={depth + 1} selected={selected} toggle={toggle} />)}
      {open && kids && !kids.length && <div className="muted" style={{ paddingLeft: 52 + depth * 18, fontSize: 12 }}>No subfolders</div>}
    </div>
  );
}

export function Setup({ source, localName, onChooseFolder, onChooseFiles, roots, signedIn, setSignedIn, onScan, scanning, progress, onStop, lastScan, onClear, demo }: {
  source?: 'local' | 'drive'; localName?: string; onChooseFolder: () => void; onChooseFiles: (f: File[]) => void;
  roots: Folder[]; signedIn: boolean; setSignedIn: (b: boolean) => void; onScan: (roots: Folder[]) => void; scanning: boolean;
  progress: ScanProgress | null; onStop: () => void; lastScan?: string; onClear: () => void; demo: boolean;
}) {
  const [cid, setCid] = useState(clientId());
  const [err, setErr] = useState('');
  const [selected, setSelected] = useState<Map<string, Folder>>(() => new Map(roots.map((r) => [r.id, r])));
  const toggle = (f: Folder) => setSelected((s) => { const x = new Map(s); x.has(f.id) ? x.delete(f.id) : x.set(f.id, f); return x; });
  const saveCid = () => { try { localStorage.setItem('po.clientId', cid.trim()); } catch {} setErr(''); };
  const doSignIn = async () => { setErr(''); try { saveCid(); await signIn('consent'); setSignedIn(true); } catch (e) { setErr((e as Error).message); } };
  const progressBox = scanning && progress && (
    <>
      <div className="stats"><div><b>{progress.files.toLocaleString()}</b><span>photos and videos found</span></div>{progress.folders > 0 && <div><b>{progress.folders.toLocaleString()}</b><span>folders read</span></div>}</div>
      <div className="muted">Reading “{progress.current}”…</div>
      <div className="row"><button className="btn" onClick={onStop}>Stop</button></div>
    </>
  );
  const [showDrive, setShowDrive] = useState(source === 'drive');
  return (
    <div className="stack">
      {demo && <div className="notice">You're looking at sample photos. Remove <code>?demo</code> from the address to use your own.</div>}
      <section className="panel">
        <h2>Choose a folder with photos</h2>
        <p className="muted">Pick any folder: on this computer, on a USB disk or memory card, or a Google Drive, OneDrive or Dropbox folder synced to this PC. Subfolders are included. Nothing is uploaded and nothing is moved: the app only reads the files where they are.</p>
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
        {source !== 'drive' && progressBox}
        {!canWrite && <p className="muted">In this browser the app can look at photos but not move duplicates. Use Chrome or Edge on a computer for that.</p>}
        <p className="muted">Removing duplicates moves the extra copies into a folder called <code>{TRASH}</code> inside the folder you chose, so you can check them before deleting them yourself.</p>
      </section>

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
        <p className="muted">Tick the folders the app should look at. Subfolders are included. Nothing is moved.</p>
        {signedIn ? (
          <div className="tree"><PickerNode f={{ id: 'root', name: 'My Drive' }} depth={0} selected={selected} toggle={toggle} /></div>
        ) : <p className="muted">Sign in first.</p>}
        <div className="row"><span className="muted">{selected.size ? [...selected.values()].map((f) => f.name).join(', ') : 'No folders chosen yet'}</span></div>
      </div>

      <div>
        <h2>3 · Scan</h2>
        <p className="muted">Reads the date, place, camera, size and type of every photo and video. 13,000 files take about 5 to 10 minutes. Run it again later to pick up new files.</p>
        {source === 'drive' && progressBox}
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
