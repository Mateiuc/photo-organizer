import { useEffect } from 'react';
import { fmtDuration, fmtSize, sizedThumb, type Item } from '../lib/model';

export function Viewer({ list, index, setIndex, pathOf, onClose }: { list: Item[]; index: number; setIndex: (i: number) => void; pathOf: (id?: string) => string; onClose: () => void }) {
  const it = list[index];
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'ArrowRight' && index < list.length - 1) setIndex(index + 1);
      if (e.key === 'ArrowLeft' && index > 0) setIndex(index - 1);
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [index, list.length, onClose, setIndex]);
  useEffect(() => {
    // warm the next two images
    for (const j of [index + 1, index + 2]) { const n = list[j]; const s = sizedThumb(n?.thumb, 1600); if (s) { const im = new Image(); im.referrerPolicy = 'no-referrer'; im.src = s; } }
  }, [index, list]);
  if (!it) return null;
  const big = sizedThumb(it.thumb, 1600);
  return (
    <div className="viewer" role="dialog" aria-label={it.name}>
      <div className="stage">
        <button className="vbtn" style={{ left: 16 }} onClick={onClose}>Close (Esc)</button>
        <button className="vbtn" style={{ left: 130 }} disabled={index === 0} onClick={() => setIndex(index - 1)}>←</button>
        <button className="vbtn" style={{ left: 180 }} disabled={index >= list.length - 1} onClick={() => setIndex(index + 1)}>→</button>
        {big ? <img src={big} alt={it.name} referrerPolicy="no-referrer" /> : <p>No preview for this file.</p>}
      </div>
      <aside className="side">
        <div style={{ fontFamily: 'var(--f-mono)', overflowWrap: 'anywhere' }}>{it.name}</div>
        <div style={{ color: '#8d97a8' }}>{index + 1} of {list.length.toLocaleString()}</div>
        <dl>
          <dt>Taken</dt><dd>{it.takenAt ? it.takenAt.replace('T', ' ') : 'Unknown'}{it.takenFrom !== 'camera' && <span style={{ color: '#8d97a8' }}> · from {it.takenFrom === 'filename' ? 'file name' : 'upload date'}</span>}</dd>
          <dt>Folder</dt><dd>{pathOf(it.folderId) || '—'}</dd>
          {it.lat != null && <><dt>Place</dt><dd>{it.lat.toFixed(4)}, {it.lon!.toFixed(4)} · <a href={`https://www.openstreetmap.org/?mlat=${it.lat}&mlon=${it.lon}#map=14/${it.lat}/${it.lon}`} target="_blank" rel="noopener">map ↗</a></dd></>}
          <dt>Size</dt><dd>{fmtSize(it.size)}{it.width ? ` · ${it.width} × ${it.height}` : ''}{it.durationMs ? ` · ${fmtDuration(it.durationMs)}` : ''}</dd>
          {it.camera && <><dt>Camera</dt><dd>{it.camera}</dd></>}
          <dt>Type</dt><dd>{it.kind}</dd>
        </dl>
        {it.link && <a href={it.link} target="_blank" rel="noopener">Open in Google Drive ↗</a>}
      </aside>
    </div>
  );
}
