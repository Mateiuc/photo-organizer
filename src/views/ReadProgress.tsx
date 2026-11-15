// The progress of the one read (see read/reader.ts), shown the same on Duplicates and on Clean up.
import { stopReading } from '../read/reader';
import type { ReadRun } from '../read/run';

const mins = (s: number) => (s < 90 ? 'about a minute' : s < 3600 ? `about ${Math.round(s / 60)} minutes` : `about ${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min`);

export function ReadProgress({ run: r, more }: { run: ReadRun; more?: string }) {
  const rate = r.step === 'reading' && r.startedAt && r.done > 5 ? r.done / ((Date.now() - r.startedAt) / 1000) : 0;
  return (
    <>
      {r.step !== 'reading' && <div className="muted">{r.model?.total ? `Downloading the AI (only the first time): ${Math.round(r.model.loaded / 1e6)} of ${Math.round(r.model.total / 1e6)} MB` : 'Starting the AI…'}</div>}
      {r.step === 'reading' && (
        <>
          <div className="stats"><div><b>{r.done.toLocaleString()}</b><span>of {r.total.toLocaleString()} photos read</span></div></div>
          <div className="progress"><i style={{ width: `${r.total ? (100 * r.done) / r.total : 0}%` }} /></div>
          <div className="muted">Looking at “{r.current ?? '…'}”{rate ? ` · ${mins((r.total - r.done) / rate)} left` : ''}. Each photo is read once: compared for Duplicates and sorted for Clean up from the same look. You can keep using the app, or pause and carry on later.{more ? ` ${more}` : ''}</div>
        </>
      )}
      {r.note && <div className="muted">{r.note}</div>}
      <div className="row"><button className="btn" onClick={stopReading}>Pause</button></div>
    </>
  );
}
