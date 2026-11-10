// Compares all pictures away from the page, so the app stays responsive.
import { nearPairs, samePhotos, type Packed } from './compare';

self.onmessage = (e: MessageEvent<{ id: number; p: Packed }>) => {
  const { id, p } = e.data;
  const same = samePhotos(p);
  // Only the best copy of each "same photo" set takes part in look-alikes.
  const skip = new Uint8Array(p.n);
  for (const g of same) {
    const best = g.reduce((a, b) => (p.pixels[b] > p.pixels[a] ? b : a));
    g.forEach((i) => { if (i !== best) skip[i] = 1; });
  }
  const pairs = nearPairs(p, skip);
  (self as unknown as Worker).postMessage({ id, same, pairs }, [pairs.buffer]);
};
