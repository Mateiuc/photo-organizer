import { useEffect, useState } from 'react';
import { localFull } from '../local/thumbs';
import { fmtDuration, fmtSize, thumbUrl, type Item } from '../lib/model';
import { details, type GpDetails } from '../gphotos/api';
import { GpPicture } from './Grid';
import { TopicMarks } from './Search';

/** A Google Photos video plays from Google's own link; if the browser can't play it, the picture is shown. */
function GpVideo({ it }: { it: Item }) {
  const [bad, setBad] = useState(false);
  useEffect(() => setBad(false), [it]);
  if (bad || !it.thumb) return <GpPicture item={it} px={1600} />;
  return <video key={it.id} src={it.thumb.replace(/=[a-z0-9-]+$/i, '') + '=dv'} poster={thumbUrl(it, 1600)} controls autoPlay style={{ maxWidth: '100%', maxHeight: '100%' }} onError={() => setBad(true)} />;
}

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
    for (const j of [index + 1, index + 2]) { const n = list[j]; const s = n && !n.local ? thumbUrl(n, 1600) : undefined; if (s) { const im = new Image(); im.referrerPolicy = 'no-referrer'; im.src = s; } }
  }, [index, list]);
  const [local, setLocal] = useState<{ url?: string; video?: boolean } | null>(null);
  useEffect(() => {
    if (!it?.local) { setLocal(null); return; }
    let live = true, made: string | undefined;
    setLocal(null);
    localFull(it).then((r) => { if (r.own) made = r.url; if (live) setLocal(r); else if (made) URL.revokeObjectURL(made); });
    return () => { live = false; if (made) URL.revokeObjectURL(made); };
  }, [it]);
  // Google Photos: camera, place name and albums are read when the photo is opened.
  const [more, setMore] = useState<GpDetails | null>(null);
  useEffect(() => {
    setMore(null);
    if (!it?.gp) return;
    let live = true;
    details(it).then((d) => live && setMore(d), () => live && setMore({ albums: [] }));
    return () => { live = false; };
  }, [it]);
  if (!it) return null;
  const big = it.local ? local?.url : thumbUrl(it, 1600);
  const camera = it.camera ?? more?.camera;
  const lat = it.lat ?? more?.lat, lon = it.lon ?? more?.lon;
  const place = it.gp?.place ?? more?.place;
  return (
    <div className="viewer" role="dialog" aria-label={it.name}>
      <div className="stage">
        <button className="vbtn" style={{ left: 16 }} onClick={onClose}>Close (Esc)</button>
        <button className="vbtn" style={{ left: 130 }} disabled={index === 0} onClick={() => setIndex(index - 1)}>←</button>
        <button className="vbtn" style={{ left: 180 }} disabled={index >= list.length - 1} onClick={() => setIndex(index + 1)}>→</button>
        {it.gp ? (it.kind === 'video' ? <GpVideo it={it} /> : <GpPicture key={it.id} item={it} px={1600} />)
          : big ? (local?.video ? <video src={big} controls autoPlay style={{ maxWidth: '100%', maxHeight: '100%' }} /> : <img src={big} alt={it.name} referrerPolicy="no-referrer" />)
          : <p>{it.local && !local ? 'Loading…' : it.local ? 'No preview for this file. Open the folder again from Drive & scan if photos are missing.' : 'No preview for this file.'}</p>}
      </div>
      <aside className="side">
        <div style={{ fontFamily: 'var(--f-mono)', overflowWrap: 'anywhere' }}>{it.name}</div>
        <div style={{ color: '#8d97a8' }}>{index + 1} of {list.length.toLocaleString()}</div>
        <dl>
          <dt>Taken</dt><dd>{it.takenAt ? it.takenAt.replace('T', ' ') : 'Unknown'}{it.takenFrom !== 'camera' && <span style={{ color: '#8d97a8' }}> · from {it.takenFrom === 'filename' ? 'file name' : it.takenFrom === 'file' ? 'file date' : 'upload date'}</span>}</dd>
          <dt>{it.gp ? 'Where' : 'Folder'}</dt><dd>{pathOf(it.folderId) || '—'}{it.gp?.archived ? ' · Archive' : ''}{it.gp?.fav ? ' · ★ Favourite' : ''}</dd>
          {it.gp && (more?.albums.length ? <><dt>Albums</dt><dd>{more.albums.join(', ')}</dd></> : null)}
          {(lat != null || place) && <><dt>Place</dt><dd>{place && <>{place}<br /></>}{lat != null && lon != null && <>{lat.toFixed(4)}, {lon.toFixed(4)} · <a href={`https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=14/${lat}/${lon}`} target="_blank" rel="noopener">map ↗</a></>}</dd></>}
          <dt>Size</dt><dd>{fmtSize(it.size || more?.size || 0)}{it.width ? ` · ${it.width} × ${it.height}` : ''}{it.durationMs ? ` · ${fmtDuration(it.durationMs)}` : ''}</dd>
          {camera && <><dt>Camera</dt><dd>{camera}</dd></>}
          {it.gp?.uploaded && <><dt>Added</dt><dd>{it.gp.uploaded.replace('T', ' ')}</dd></>}
          {more?.description && <><dt>Description</dt><dd>{more.description}</dd></>}
          <dt>Type</dt><dd>{it.kind}</dd>
        </dl>
        <TopicMarks it={it} />
        {it.gp && !more && <div style={{ color: '#8d97a8' }}>Reading more details from Google Photos…</div>}
        {it.link && <a href={it.link} target="_blank" rel="noopener">{it.gp ? 'Open in Google Photos ↗' : 'Open in Google Drive ↗'}</a>}
      </aside>
    </div>
  );
}
