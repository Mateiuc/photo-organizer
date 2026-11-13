// WhatsApp copies of your own videos. WhatsApp makes a new, smaller file (so it's never an identical file), and
// video pictures aren't compared, so the copy is found from what stays the same: the length, the shape, and the
// date. Pure functions, so they can be tested and run anywhere.
import { viaWhatsApp, type Item } from './model';

/**
 * durMs: how far apart the two lengths may be. minDurMs: shorter videos are left out (too many have the same
 * length). daysBefore/daysAfter: when the original may have been taken, around the day of the WhatsApp copy.
 * shape: how far apart width/height may be (turned sideways counts as the same).
 */
export const WA_VIDEO = { durMs: 300, minDurMs: 2000, daysBefore: 14, daysAfter: 2, shape: 0.03 };
const DAY = 864e5;

/** The day of a WhatsApp file, from its name ("VID-20200313-WA0001.mp4", "WhatsApp Video 2020-03-13 at …"), else its date. Ms, start of the day. */
export function waDay(x: Item): number | undefined {
  const m = /(?:^|\D)(20\d\d)-?(\d\d)-?(\d\d)(?!\d)/.exec(x.name);
  if (m) {
    const t = Date.UTC(+m[1], +m[2] - 1, +m[3]);
    if (!Number.isNaN(t) && +m[2] >= 1 && +m[2] <= 12 && +m[3] >= 1 && +m[3] <= 31) return t;
  }
  if (!x.takenAt) return undefined;
  const t = Date.parse(x.takenAt.slice(0, 10) + 'T00:00:00Z');
  return Number.isNaN(t) ? undefined : t;
}

const sameShape = (a: Item, b: Item) => {
  if (!a.width || !a.height || !b.width || !b.height) return true; // not known: the length and date decide
  const ra = a.width / a.height, rb = b.width / b.height;
  return Math.abs(ra / rb - 1) <= WA_VIDEO.shape || Math.abs(ra * rb - 1) <= WA_VIDEO.shape;
};

/**
 * Sets of [original, its WhatsApp copies…]. A copy is matched only when exactly one of your other videos fits: about
 * the same length, the same shape, and taken from 14 days before to 2 days after the copy's WhatsApp date.
 */
export function whatsAppVideoCopies(items: Item[], pathOf: (folderId?: string) => string): Item[][] {
  const vids = items.filter((x) => x.kind === 'video' && (x.durationMs ?? 0) >= WA_VIDEO.minDurMs && x.size > 0);
  const originals = vids
    .filter((x) => !viaWhatsApp(x, pathOf) && x.takenAt)
    .map((x) => ({ x, t: Date.parse(x.takenAt! + 'Z'), d: x.durationMs! }))
    .filter((o) => !Number.isNaN(o.t))
    .sort((a, b) => a.d - b.d);
  const durs = originals.map((o) => o.d);
  const firstAtLeast = (v: number) => { let lo = 0, hi = durs.length; while (lo < hi) { const m = (lo + hi) >> 1; if (durs[m] < v) lo = m + 1; else hi = m; } return lo; };
  const sets = new Map<string, Item[]>();
  for (const c of vids) {
    if (!viaWhatsApp(c, pathOf)) continue;
    const day = waDay(c);
    if (day == null) continue;
    const from = day - WA_VIDEO.daysBefore * DAY, to = day + (WA_VIDEO.daysAfter + 1) * DAY;
    const fits: Item[] = [];
    for (let i = firstAtLeast(c.durationMs! - WA_VIDEO.durMs); i < originals.length && originals[i].d <= c.durationMs! + WA_VIDEO.durMs; i++) {
      const o = originals[i];
      if (o.x.id !== c.id && o.t >= from && o.t < to && sameShape(o.x, c)) fits.push(o.x);
    }
    if (fits.length !== 1) continue; // none, or more than one could be it: not sure enough
    const o = fits[0];
    const s = sets.get(o.id);
    if (s) s.push(c); else sets.set(o.id, [o, c]);
  }
  return [...sets.values()];
}
