// Which pictures to make from one read of a photo. Pure, so it can be tested.
import type { Shape } from '../lib/picture';

/**
 * A photo is fetched once with its longer side about this many pixels. Measured with the real AI on a wide (16:9)
 * photo of a purple-lit room: from a 256 px preview the AI called it a thermal image (73%), from 336 px it couldn't
 * tell (47% / 47%), from 448 px and from 1,000 px it said Lights (73%, 75%). 448 is the smallest size where a photo up
 * to twice as wide as it is high still has 224 rows, which is what the AI looks at.
 */
export const READ_SIZE = 448;
/** The Clean-up AI looks at exactly this picture (SigLIP 2 stretches every photo to 224 × 224). */
export const AI_SHAPE: Shape = { width: 224, height: 224 };
/** The picture the comparison describes (hashes, sketch, small AI fingerprint, sharpness). */
export const PIC_SHAPE: Shape = { long: 256 };

/**
 * What one photo still needs, and so which pictures to make from the one read. `pic` and `sort` say which of the
 * pictures each part gets (−1: that part isn't made).
 */
export function plan(wantPic: boolean, wantSort: boolean): { shapes: Shape[]; pic: number; sort: number } {
  const shapes: Shape[] = [];
  const sort = wantSort ? shapes.push(AI_SHAPE) - 1 : -1;
  const pic = wantPic ? shapes.push(PIC_SHAPE) - 1 : -1;
  return { shapes, pic, sort };
}

/**
 * Sharpness only compares between pictures made the same way: a small picture made on this computer from a bigger
 * one reads about a fifth less sharp than a ready-made small preview from Google (measured: 0.79 times, on 88
 * photos). `kinds[i]` tells how photo i's picture was made. From a set that mixes both, only the photos made the
 * way most of the set was are compared (the first way wins a tie). Returns the index of the sharpest, or -1 for none.
 */
export function sharpestOf(sharp: readonly number[], kinds: readonly number[]): number {
  const count = new Map<number, number>();
  kinds.forEach((k) => count.set(k, (count.get(k) ?? 0) + 1));
  let kind = kinds[0], most = 0;
  for (const [k, n] of count) if (n > most) { most = n; kind = k; }
  let best = -1;
  for (let i = 0; i < sharp.length; i++) if (kinds[i] === kind && (best < 0 || sharp[i] > sharp[best])) best = i;
  return best;
}
