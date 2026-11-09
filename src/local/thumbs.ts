// Previews for files on this computer, made in the browser and kept in memory while the app is open.
import { useEffect, useState } from 'react';
import exifr from 'exifr';
import type { Item } from '../lib/model';
import { getLocalFile, hasFile } from './fs';

const cache = new Map<string, Promise<string | undefined>>();
let running = 0;
const waiting: (() => void)[] = [];
async function slot<T>(fn: () => Promise<T>): Promise<T> {
  if (running >= 6) await new Promise<void>((r) => waiting.push(r));
  running++;
  try { return await fn(); } finally { running--; waiting.shift()?.(); }
}

const BROWSER_IMAGES = /^image\/(jpeg|png|gif|webp|bmp|avif)$/;

async function small(it: Item): Promise<string | undefined> {
  const file = await getLocalFile(it.id);
  if (!file) return undefined;
  if (it.kind === 'video') return videoFrame(file);
  // Cameras and phones store a small preview inside the file: fastest, and the only option for RAW files.
  try {
    const t = await exifr.thumbnail(file);
    if (t && t.byteLength > 1000) return URL.createObjectURL(new Blob([t], { type: 'image/jpeg' }));
  } catch { /* no embedded preview */ }
  if (!BROWSER_IMAGES.test(it.mime)) return undefined;
  try {
    const bmp = await createImageBitmap(file, { resizeWidth: 360, resizeQuality: 'medium' });
    const c = new OffscreenCanvas(bmp.width, bmp.height);
    c.getContext('2d')!.drawImage(bmp, 0, 0);
    bmp.close();
    return URL.createObjectURL(await c.convertToBlob({ type: 'image/jpeg', quality: 0.8 }));
  } catch { return undefined; }
}

function videoFrame(file: File): Promise<string | undefined> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const v = document.createElement('video');
    const done = (r?: string) => { URL.revokeObjectURL(url); v.removeAttribute('src'); v.load(); resolve(r); };
    v.muted = true; v.preload = 'metadata';
    v.onloadeddata = () => { v.currentTime = Math.min(1, (v.duration || 2) / 2); };
    v.onseeked = () => {
      try {
        const w = 360, h = Math.round((v.videoHeight / v.videoWidth) * w) || 202;
        const c = document.createElement('canvas'); c.width = w; c.height = h;
        c.getContext('2d')!.drawImage(v, 0, 0, w, h);
        c.toBlob((b) => done(b ? URL.createObjectURL(b) : undefined), 'image/jpeg', 0.8);
      } catch { done(); }
    };
    v.onerror = () => done();
    setTimeout(() => done(), 8000);
    v.src = url;
  });
}

export function localThumb(it: Item): Promise<string | undefined> {
  if (!hasFile(it.id)) return Promise.resolve(undefined); // folder not opened in this session yet
  let p = cache.get(it.id);
  if (!p) { p = slot(() => small(it)); cache.set(it.id, p); }
  return p;
}

/** Forget previews, e.g. after a new scan. */
export function clearThumbs() { cache.forEach((p) => p.then((u) => u && URL.revokeObjectURL(u))); cache.clear(); }

/** Full-size view: the file itself when the browser can show it, else the embedded preview. */
export async function localFull(it: Item): Promise<{ url?: string; video?: boolean; own?: boolean }> {
  const file = await getLocalFile(it.id);
  if (!file) return {};
  if (it.kind === 'video' || BROWSER_IMAGES.test(it.mime)) return { url: URL.createObjectURL(file), video: it.kind === 'video', own: true };
  return { url: await localThumb(it) };
}

/** Preview URL for a tile, made when the tile first appears. */
export function useLocalThumb(it: Item, visible: boolean): string | undefined | null {
  const [url, setUrl] = useState<string | undefined | null>(null); // null = not made yet
  useEffect(() => {
    if (!it.local || !visible) return;
    let live = true;
    localThumb(it).then((u) => live && setUrl(u));
    return () => { live = false; };
  }, [it, visible]);
  return url;
}
