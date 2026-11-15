// Scores every sorted photo against the groups and the tags away from the page, so the app stays responsive.
import { scoreAll, type Bank, type Examples } from './groups';
import { tagAll, type TagBank } from './tags';

self.onmessage = (e: MessageEvent<{ id: number; k: Int8Array; n: number; bank: Bank; ex?: Examples; tagBank?: TagBank }>) => {
  const { id, k, n, bank, ex, tagBank } = e.data;
  const r = scoreAll(k, n, bank, ex);
  const tags = tagBank ? tagAll(k, n, tagBank) : new Uint32Array(n);
  (self as unknown as Worker).postMessage({ id, ...r, tags }, [r.g.buffer, r.p.buffer, r.g2.buffer, r.probs.buffer, tags.buffer]);
};
