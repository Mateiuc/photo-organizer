import { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import 'leaflet.markercluster';
import 'leaflet.markercluster/dist/MarkerCluster.css';
import 'leaflet.markercluster/dist/MarkerCluster.Default.css';
import type { Item } from '../lib/model';
import { MonthGrid } from './Grid';

export function Places({ items, onOpen }: { items: Item[]; onOpen: (list: Item[], i: number) => void }) {
  const el = useRef<HTMLDivElement>(null);
  const [picked, setPicked] = useState<Item[] | null>(null);
  const withPlace = items.filter((i) => i.lat != null);
  useEffect(() => {
    if (!el.current) return;
    const map = L.map(el.current, { worldCopyJump: true }).setView([45, 12], 4);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 18, attribution: '© OpenStreetMap' }).addTo(map);
    const cluster = (L as any).markerClusterGroup({ showCoverageOnHover: false, maxClusterRadius: 50 });
    const dot = L.divIcon({ className: '', html: '<div style="width:12px;height:12px;border-radius:50%;background:#2f5bd3;border:2px solid #fff;box-shadow:0 0 0 1px rgba(0,0,0,.3)"></div>', iconSize: [12, 12] });
    for (const it of withPlace) {
      const m = L.marker([it.lat!, it.lon!], { icon: dot }) as any;
      m.item = it;
      m.on('click', () => setPicked([it]));
      cluster.addLayer(m);
    }
    cluster.on('clusterclick', (e: any) => { setPicked(e.layer.getAllChildMarkers().map((m: any) => m.item)); });
    map.addLayer(cluster);
    if (withPlace.length) map.fitBounds(cluster.getBounds(), { padding: [30, 30], maxZoom: 12 });
    return () => { map.remove(); };
  }, [withPlace.length]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="stack" style={{ maxWidth: 'none' }}>
      <p className="muted">{withPlace.length.toLocaleString()} of {items.length.toLocaleString()} photos have a location saved by the camera or phone. Click a cluster to see its photos.</p>
      <div className="map" ref={el} />
      {picked && (
        <div className="panel">
          <div className="row"><h2>{picked.length.toLocaleString()} photos here</h2><button className="btn" onClick={() => setPicked(null)}>Clear</button></div>
          <MonthGrid items={picked} onOpen={onOpen} />
        </div>
      )}
    </div>
  );
}
