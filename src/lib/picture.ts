// Reads one photo as a small picture, from wherever it lives: a folder on this computer, Google Drive, or Google
// Photos (through the helper add-on). Used by the face search and by the picture comparison.
import { downloadFile } from '../drive/api';
import { ask } from '../gphotos/bridge';
import { getLocalFile } from '../local/fs';
import { sizedThumb, thumbUrl, type Item } from './model';

const DEMO = new URLSearchParams(location.search).has('demo');
/** Drive previews couldn't be read by the page, so whole files are downloaded instead (slower). */
export const previews = { blocked: false };

export interface PictureOptions {
  size: number;
  /** 'width': at most `size` wide (faces). 'long': the longer side at most `size` (comparison). */
  fit: 'width' | 'long';
  quality?: ResizeQuality;
}

/** The picture's file or a preview of it; `full` when it is the whole file (so its size is the photo's size). */
async function blobOf(it: Item, size: number): Promise<{ blob?: Blob; full?: boolean }> {
  if (it.local) return { blob: await getLocalFile(it.id), full: true };
  if (DEMO) return { blob: it.thumb ? await (await fetch(it.thumb)).blob() : undefined };
  if (it.gp) {
    // Google Photos: the helper add-on fetches the picture inside the Google Photos tab.
    const url = thumbUrl(it, size);
    return { blob: url ? await (await fetch((await ask<{ dataUrl: string }>({ op: 'image', url }, 60000)).dataUrl)).blob() : undefined };
  }
  if (!previews.blocked && it.thumb) {
    try {
      const r = await fetch(sizedThumb(it.thumb, size)!, { referrerPolicy: 'no-referrer' });
      if (r.ok) return { blob: await r.blob() };
    } catch { previews.blocked = true; }
  }
  return it.kind !== 'raw' ? { blob: await downloadFile(it.id), full: true } : {};
}

/**
 * The photo as a picture no bigger than asked, or undefined when the browser can't open it (HEIC, most RAW).
 * When the whole file was read, `original` gets the photo's real width and height.
 */
export async function loadPicture(it: Item, o: PictureOptions, original?: { width?: number; height?: number }): Promise<ImageBitmap | undefined> {
  const { blob, full } = await blobOf(it, o.size);
  if (!blob) return undefined;
  let probe: ImageBitmap;
  try { probe = await createImageBitmap(blob); } catch { return undefined; }
  if (full && original) { original.width = probe.width; original.height = probe.height; }
  const s = o.size / (o.fit === 'width' ? probe.width : Math.max(probe.width, probe.height));
  if (s >= 1) return probe;
  try {
    return await createImageBitmap(probe, { resizeWidth: Math.max(1, Math.round(probe.width * s)), resizeHeight: Math.max(1, Math.round(probe.height * s)), resizeQuality: o.quality ?? 'medium' });
  } catch { return undefined; } finally { probe.close(); }
}
