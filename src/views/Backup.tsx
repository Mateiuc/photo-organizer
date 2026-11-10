import { useState } from 'react';
import { allowAgain, BACKUP_FOLDER, chooseFolder, findBackup, save, useBackup, type Manifest } from '../lib/backup';

export function when(iso?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toDateString() === new Date().toDateString() ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : d.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
}
const what = (m: Manifest) => `${m.photos.toLocaleString()} photos, ${m.faces.toLocaleString()} faces, ${m.people.toLocaleString()} people (${m.named.toLocaleString()} named)`;

/** Where the safe copy goes, and restoring it. */
export function BackupPanel({ demo }: { demo: boolean }) {
  const b = useBackup();
  const [found, setFound] = useState<{ m: Manifest; canContinue?: boolean; use?: () => Promise<void>; restore: () => Promise<void> } | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState('');
  const fail = (e: unknown) => { if ((e as Error).name !== 'AbortError') setErr((e as Error).message); setBusy(''); };
  const choose = async () => {
    setErr(''); setFound(null);
    try {
      const r = await chooseFolder();
      if (r.existing) { setFound({ m: r.existing, canContinue: r.canContinue, use: r.use, restore: r.restore }); return; }
      setBusy('Saving the first backup…'); await r.use(); setBusy('');
    } catch (e) { fail(e); }
  };
  const look = async () => {
    setErr(''); setFound(null);
    try { const r = await findBackup(); setFound({ m: r.manifest, restore: r.restore }); } catch (e) { fail(e); }
  };
  const restore = async () => {
    if (!found) return;
    setBusy('Restoring… this can take a minute.');
    try { await found.restore(); location.reload(); } catch (e) { fail(e); }
  };
  if (!b.supported || demo) {
    return <section className="panel"><h2>Backup</h2><p className="muted">{demo ? 'Backups are off for the sample photos.' : 'Backups to a folder work in Chrome or Edge on a computer.'}</p></section>;
  }
  return (
    <section className="panel" id="backup">
      <h2>Backup</h2>
      <p className="muted">The app keeps your library, faces and names in this browser. A backup folder keeps a copy outside the browser, so nothing is lost if Chrome's data is cleared, and you can restore it on another computer. It saves by itself a few seconds after you name or join people, and every few minutes otherwise. Tip: choose a folder on your Google Drive (G:) and the backup goes to Google Drive too.</p>
      {b.folder ? (
        <p style={{ margin: 0 }}>
          Saving to <b>{BACKUP_FOLDER}</b> in <b>{b.folder}</b>. {b.saving ? 'Saving now…' : b.savedAt ? <>Last saved {when(b.savedAt)}{b.unsaved ? ', newer changes are saved soon' : ''}.</> : 'Not saved yet.'}
          {b.saved && <span className="muted"> In the backup: {what(b.saved)}.</span>}
        </p>
      ) : <p className="notice" style={{ margin: 0 }}>No backup folder yet. Choose one so your work is never lost.</p>}
      {b.needsPermission && <div className="notice row"><span>Chrome needs your OK to keep saving the backup.</span><button className="btn primary" onClick={() => allowAgain().catch(fail)}>Allow saving</button></div>}
      {(b.error || err) && <p className="error">{err || b.error}</p>}
      {found && (
        <div className="confirm">
          <span>{found.use ? 'This folder already has a backup' : 'Found a backup'} from {when(found.m.savedAt)}: {what(found.m)}.</span>
          <span className="muted">Restoring replaces what the app has in this browser right now with the backup.{found.use && !found.canContinue ? ' Saving over it isn’t offered, because the backup has more than this browser: restore it, or choose another folder.' : ''}</span>
          <div className="row">
            <button className="btn primary" disabled={!!busy} onClick={restore}>Restore this backup</button>
            {found.use && found.canContinue && <button className="btn" disabled={!!busy} onClick={async () => { const use = found.use!; setFound(null); setBusy('Saving…'); try { await use(); setBusy(''); } catch (e) { fail(e); } }}>Keep saving here</button>}
            <button className="btn" disabled={!!busy} onClick={() => setFound(null)}>Cancel</button>
          </div>
        </div>
      )}
      {busy && <p className="muted">{busy}</p>}
      <div className="row">
        <button className={`btn ${b.folder ? '' : 'primary'}`} disabled={!!busy} onClick={choose}>{b.folder ? 'Change backup folder' : 'Choose backup folder'}</button>
        {b.folder && !b.needsPermission && <button className="btn" disabled={b.saving || !!busy} onClick={() => save(true)}>Save now</button>}
        <button className="btn" disabled={!!busy} onClick={look}>Restore from a backup</button>
      </div>
    </section>
  );
}
