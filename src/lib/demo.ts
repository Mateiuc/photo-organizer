// Sample library for trying the app without signing in (open the app with ?demo).
import type { Folder, Item } from './model';

function rng(seed: number) {
  return () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
}

function swatch(hue: number, label: string) {
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='320' height='240'><defs><linearGradient id='g' x1='0' y1='0' x2='1' y2='1'><stop offset='0' stop-color='hsl(${hue},55%,62%)'/><stop offset='1' stop-color='hsl(${(hue + 40) % 360},50%,38%)'/></linearGradient></defs><rect width='320' height='240' fill='url(#g)'/><circle cx='240' cy='70' r='28' fill='rgba(255,255,255,.55)'/><path d='M0 200 L90 120 L160 180 L230 110 L320 190 L320 240 L0 240Z' fill='rgba(0,0,0,.25)'/><text x='14' y='228' font-family='sans-serif' font-size='16' fill='white'>${label}</text></svg>`;
  return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
}

export function demoLibrary(): { items: Item[]; folders: Folder[] } {
  const r = rng(7);
  const folders: Folder[] = [
    { id: 'root', name: 'My Drive' },
    { id: 'vac', name: '_Vacante', parentId: 'root' },
    { id: 'aus', name: 'Austria 2015', parentId: 'vac' },
    { id: 'aus8', name: '2015-08', parentId: 'aus' },
    { id: 'ro', name: 'Romania 2020 august', parentId: 'vac' },
    { id: 'ro8', name: '2020-08', parentId: 'ro' },
    { id: 'cam', name: 'Camera', parentId: 'root' },
    { id: 'cam21', name: '2021-06', parentId: 'cam' },
    { id: 'wa', name: 'Media', parentId: 'root' },
    { id: 'wai', name: 'WhatsApp Images', parentId: 'wa' },
  ];
  const places: Record<string, [number, number]> = { aus8: [47.27, 11.39], ro8: [45.65, 25.6], cam21: [41.9, 12.5] };
  const items: Item[] = [];
  const add = (folderId: string, y: number, m: number, n: number, kind: Item['kind'] = 'photo') => {
    for (let i = 0; i < n; i++) {
      const d = 1 + Math.floor(r() * 27), h = 8 + Math.floor(r() * 12), mi = Math.floor(r() * 60);
      const ts = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}T${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}:00`;
      const name = kind === 'video' ? `VID_${ts.replace(/\D/g, '').slice(0, 14)}.mp4` : folderId === 'wai' ? `IMG-${ts.slice(0, 10).replace(/-/g, '')}-WA${String(i).padStart(4, '0')}.jpg` : `${ts.slice(0, 10).replace(/-/g, '_')}-${ts.slice(11).replace(/:/g, '.')}.jpg`;
      const p = places[folderId];
      items.push({
        id: `${folderId}-${kind}-${i}`, name, kind, mime: kind === 'video' ? 'video/mp4' : 'image/jpeg',
        size: kind === 'video' ? 20e6 + r() * 80e6 : folderId === 'wai' ? 80e3 + r() * 200e3 : 2e6 + r() * 5e6,
        md5: `m${folderId}${i}`, folderId, takenAt: ts, takenFrom: folderId === 'wai' ? 'filename' : 'camera',
        width: 4000, height: 3000, camera: folderId === 'wai' ? undefined : 'Samsung SM-G973F',
        lat: p ? p[0] + (r() - 0.5) * 0.3 : undefined, lon: p ? p[1] + (r() - 0.5) * 0.3 : undefined,
        durationMs: kind === 'video' ? 5000 + r() * 90000 : undefined,
        thumb: swatch(Math.floor(r() * 360), kind === 'video' ? '▶ video' : name.slice(0, 10)), tags: [],
      });
    }
  };
  add('aus8', 2015, 8, 60); add('aus8', 2015, 8, 4, 'video');
  add('ro8', 2020, 8, 80); add('ro8', 2020, 8, 6, 'video');
  add('cam21', 2021, 6, 50);
  add('wai', 2019, 3, 40);
  // a few exact copies, as phone backups often have
  for (const src of items.slice(5, 11)) items.push({ ...src, id: src.id + '-copy', folderId: 'cam21' });
  // and a few re-saved copies that lost their camera data (smaller file, no date, place or camera)
  for (const src of items.slice(70, 74)) items.push({ ...src, id: src.id + '-resaved', folderId: 'wai', md5: src.md5 + 'r', size: Math.round(src.size / 12), takenFrom: 'filename', camera: undefined, lat: undefined, lon: undefined, width: 1600, height: 1200 });
  return { items, folders };
}
