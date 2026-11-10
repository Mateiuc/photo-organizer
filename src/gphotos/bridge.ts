// Talks to the Photo Organizer helper add-on, which reads Google Photos through your signed-in photos.google.com tab.
// The add-on's small script on this page passes messages both ways (see extension/bridge.js).

export const NOT_SIGNED_IN = 'Google Photos isn’t signed in in this browser. Open photos.google.com, sign in, then try again.';
export const NO_HELPER = 'The Photo Organizer helper add-on isn’t installed in this browser yet.';
export const RELOAD = 'The helper add-on was just updated. Reload this page (F5) and try again.';
export const OLD_HELPER = 'The helper add-on needs updating for this. Download the new version and follow the update steps below.';
/** The add-on version that can search. */
export const SEARCH_VERSION = '0.2.0';
/** True when version a is older than b ("0.1.0" < "0.2.0"). */
export const older = (a: string, b: string) => { const x = a.split('.').map(Number), y = b.split('.').map(Number); for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) < (y[i] || 0); return false; };

let seq = 0;
const waiting = new Map<number, (res: any) => void>();
let hello: string | undefined;

if (typeof window !== 'undefined') {
  window.addEventListener('message', (e) => {
    const m = e.data;
    if (e.source !== window || !m || m.from !== 'po-helper') return;
    if (m.hello) hello = m.hello;
    if (typeof m.id === 'number') { waiting.get(m.id)?.(m.res); waiting.delete(m.id); }
  });
}

/** The add-on's version, or undefined when it isn't installed (or this page was opened before it was). */
export function helperVersion(): string | undefined {
  return hello ?? (typeof document !== 'undefined' ? document.documentElement.dataset.poHelper : undefined);
}

export async function ask<T = any>(msg: Record<string, unknown>, timeoutMs = 120000): Promise<T> {
  if (!helperVersion()) throw new Error(NO_HELPER);
  const id = ++seq;
  const res = await new Promise<any>((done) => {
    const t = setTimeout(() => { waiting.delete(id); done({ error: 'TIMEOUT' }); }, timeoutMs);
    waiting.set(id, (r) => { clearTimeout(t); done(r); });
    window.postMessage({ to: 'po-helper', id, msg }, location.origin);
  });
  if (!res) throw new Error('No answer from the helper add-on.');
  if (res.error === 'NOT_SIGNED_IN') throw new Error(NOT_SIGNED_IN);
  if (res.error === 'RELOAD_PAGE') throw new Error(RELOAD);
  if (res.error === 'NOT_ALLOWED') throw new Error(OLD_HELPER);
  if (res.error === 'TIMEOUT') throw new Error('Google Photos took too long to answer. Try again in a moment.');
  if (res.error) throw new Error('Google Photos: ' + res.error);
  return res as T;
}
