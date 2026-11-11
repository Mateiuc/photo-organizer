// Scores every sorted photo against the groups away from the page, so the app stays responsive.
import { scoreAll, type Bank, type Examples } from './groups';

self.onmessage = (e: MessageEvent<{ id: number; k: Int8Array; n: number; bank: Bank; ex?: Examples }>) => {
  const { id, k, n, bank, ex } = e.data;
  const r = scoreAll(k, n, bank, ex);
  (self as unknown as Worker).postMessage({ id, ...r }, [r.g.buffer, r.p.buffer, r.g2.buffer]);
};
