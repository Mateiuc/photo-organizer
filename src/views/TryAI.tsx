// Try the AI: a test of the free AI on this PC (Ollama, see ai/ollama.ts). It works by itself: finds the program, downloads
// the AI when it is missing, then shows what the AI says about 20 photos and how many seconds each one took.
// Only a test: nothing is saved and nothing else in the app changes.
import { useCallback, useEffect, useRef, useState } from 'react';
import { NEEDS_SIGN_IN } from '../drive/api';
import { NO_HELPER, NOT_SIGNED_IN, RELOAD } from '../gphotos/bridge';
import type { Item } from '../lib/model';
import { loadShapes } from '../lib/picture';
import { hasFile } from '../local/fs';
import {
  askPhoto, findOllama, GROUP_INFO, hasModel, installedModels, localAccess, MODEL_GB, MODEL_NAME, pickSample,
  pullModel, roughTime, SEND_SIZE, SETUP_FILE, type Answer, type Found,
} from '../ai/ollama';

const TEST_COUNT = 20;
const testable = (it: Item) => (it.kind === 'photo' || it.kind === 'screenshot') && (!it.local || hasFile(it.id));
/** Reasons a photo can't be opened that hold for every photo of its kind: shown, not just counted. */
const WHY_UNREAD = [NEEDS_SIGN_IN, NO_HELPER, NOT_SIGNED_IN, RELOAD];

interface Row { it: Item; url: string; answer: Answer; seconds: number; loadSeconds: number }
interface Pull { status: string; done: number; total: number; error?: string; running: boolean }
interface Test { running: boolean; rows: Row[]; skipped: number; why?: string; error?: string; noPhotos?: boolean }

/** The photo as the AI gets it: a JPEG with its longer side at most SEND_SIZE. */
async function toJpeg(it: Item): Promise<{ url: string; b64: string } | undefined> {
  const r = await loadShapes(it, SEND_SIZE, [{ long: SEND_SIZE }]);
  if (!r) return undefined;
  const bmp = r.bmps[0];
  try {
    const c = new OffscreenCanvas(bmp.width, bmp.height);
    c.getContext('2d')!.drawImage(bmp, 0, 0);
    const blob = await c.convertToBlob({ type: 'image/jpeg', quality: 0.85 });
    const url = await new Promise<string>((res, rej) => { const fr = new FileReader(); fr.onload = () => res(fr.result as string); fr.onerror = () => rej(fr.error); fr.readAsDataURL(blob); });
    return { url, b64: url.slice(url.indexOf(',') + 1) };
  } finally { bmp.close(); }
}

const gb = (b: number) => (b / 1e9).toFixed(1);
const secs = (s: number) => `${s < 10 ? s.toFixed(1) : Math.round(s)} s`;

export function TryAI({ items, all, onOpen }: { items: Item[]; all: Item[]; onOpen: (list: Item[], i: number) => void }) {
  const [found, setFound] = useState<Found | null>(null);
  const [access, setAccess] = useState<PermissionState | undefined>();
  const [ready, setReady] = useState<boolean | null>(null); // the AI model is on this PC
  const [pull, setPull] = useState<Pull | null>(null);
  const [test, setTest] = useState<Test | null>(null);
  const [seed, setSeed] = useState(() => Date.now());
  const stop = useRef<AbortController | null>(null);
  const itemsRef = useRef(items); itemsRef.current = items;
  const live = useRef(true);
  useEffect(() => () => { live.current = false; stop.current?.abort(); }, []);

  // 1. Look for the program, again every few seconds until it answers (the setup file may be running right now).
  useEffect(() => {
    if (found?.state === 'ok') return;
    let gone = false, timer = 0;
    const look = async () => {
      const a = await localAccess();
      // While Chrome is asking, the request waits for the click: give it time.
      const f = await findOllama(a === 'prompt' ? 60000 : 4000);
      if (gone) return;
      setAccess(a === 'prompt' ? await localAccess() : a);
      setFound(f);
      if (f.state !== 'ok') timer = window.setTimeout(look, 5000);
    };
    look();
    return () => { gone = true; clearTimeout(timer); };
  }, [found?.state]);

  // 2. Is the AI there? Download it when it isn't.
  const download = useCallback(async () => {
    const ac = new AbortController(); stop.current = ac;
    setPull({ status: 'starting', done: 0, total: 0, running: true });
    try {
      await pullModel((p) => live.current && setPull({ ...p, running: true }), ac.signal);
      if (live.current) { setPull(null); setReady(true); }
    } catch (e) {
      if (live.current) setPull((p) => ({ status: '', done: p?.done ?? 0, total: p?.total ?? 0, running: false, error: ac.signal.aborted ? 'Stopped.' : (e as Error).message }));
    }
  }, []);
  useEffect(() => {
    if (found?.state !== 'ok') return;
    installedModels().then((names) => {
      if (!live.current) return;
      const has = hasModel(names);
      setReady(has);
      if (!has) download();
    }, (e) => live.current && setPull({ status: '', done: 0, total: 0, running: false, error: (e as Error).message }));
  }, [found?.state, download]);

  // 3. The test: 20 photos, one after the other. The next photo is fetched while the AI looks at the current one.
  const runTest = useCallback(async (seedNow: number) => {
    const ac = new AbortController(); stop.current = ac;
    const pool = itemsRef.current.filter(testable);
    if (!pool.length) { setTest({ running: false, rows: [], skipped: 0, noPhotos: true }); return; }
    const order = pickSample(pool, Math.min(pool.length, TEST_COUNT * 10), seedNow);
    const t: Test = { running: true, rows: [], skipped: 0 };
    const show = () => live.current && setTest({ ...t, rows: [...t.rows] });
    show();
    let next = 0;
    const prepare = () => { const it = order[next++]; return it ? toJpeg(it).then((j) => ({ it, j }), (e: Error) => ({ it, j: undefined, e })) : undefined; };
    let coming = prepare();
    try {
      while (coming && t.rows.length < TEST_COUNT && !ac.signal.aborted) {
        const got: { it: Item; j?: { url: string; b64: string }; e?: Error } = await coming;
        coming = t.rows.length + 1 < TEST_COUNT || !got.j ? prepare() : undefined;
        if (!got.j) {
          t.skipped++;
          if (got.e && WHY_UNREAD.includes(got.e.message)) t.why = got.e.message;
          show();
          continue;
        }
        const a = await askPhoto(got.j.b64, ac.signal);
        t.rows.push({ it: got.it, url: got.j.url, ...a });
        show();
      }
    } catch (e) {
      if (!ac.signal.aborted) t.error = (e as Error).message;
    }
    t.running = false;
    show();
  }, []);
  // Starts by itself once the AI is ready (once per visit; "Try other photos" runs it again).
  const started = useRef(false);
  useEffect(() => {
    if (ready && !started.current) { started.current = true; runTest(seed); }
  }, [ready, runTest, seed]);

  const again = () => { const s = seed + 1; setSeed(s); runTest(s); };
  const busy = !!pull?.running || !!test?.running;
  const setupHref = `${import.meta.env.BASE_URL}${SETUP_FILE}`;
  const photoCount = all.filter((it) => it.kind === 'photo' || it.kind === 'screenshot').length;

  const rows = test?.rows ?? [];
  const timed = rows.filter((r, i) => i > 0 || rows.length === 1); // the first photo also wakes the AI up
  const avg = timed.length ? timed.reduce((s, r) => s + r.seconds, 0) / timed.length : 0;
  const junk = rows.filter((r) => GROUP_INFO[r.answer.group].junk).length;

  return (
    <div className="stack tryai">
      <section className="panel">
        <h2>Free AI on this PC</h2>
        <p className="muted">The AI runs in a free program on your computer (Ollama). Your photos are not sent anywhere. This page is only a test: it shows what the AI says about {TEST_COUNT} photos and how long each takes. Nothing is saved and nothing else in the app changes.</p>
        <ol className="aisteps">
          <li className={found?.state === 'ok' ? 'done' : 'now'}>
            <b>The free AI program</b>{' '}
            {!found ? <span className="muted">looking for it…</span>
              : found.state === 'ok' ? <span className="muted">✓ found (Ollama {found.version})</span>
              : found.state === 'blocked' ? <span>is running, but it doesn’t let this page in yet.</span>
              : <span>is not on this PC yet.</span>}
          </li>
          <li className={ready ? 'done' : found?.state === 'ok' ? 'now' : ''}>
            <b>The AI</b> <span className="muted">({MODEL_NAME}, {MODEL_GB} GB, free)</span>{' '}
            {ready ? <span className="muted">✓ ready</span>
              : pull?.running ? <span>downloading{pull.total ? `: ${Math.round((100 * pull.done) / pull.total)}% (${gb(pull.done)} of ${gb(pull.total)} GB)` : '…'}</span>
              : found?.state === 'ok' && ready === false && !pull?.error ? <span className="muted">checking…</span> : null}
          </li>
          <li className={test && !test.running && rows.length ? 'done' : ready ? 'now' : ''}>
            <b>Test on {TEST_COUNT} of your photos</b>{' '}
            {test?.running ? <span>{rows.length} of {TEST_COUNT}…{!rows.length && <span className="muted"> starting the AI, so the first photo takes longer (up to a few minutes)</span>}</span> : test && rows.length ? <span className="muted">✓ done</span> : null}
          </li>
        </ol>

        {found && found.state !== 'ok' && (
          <div className="aibox">
            <p>{found.state === 'blocked'
              ? 'Run the setup file once: it lets this page use the AI and restarts the program.'
              : 'Download the setup file and double-click it. It installs Ollama (free), lets this page use it, and downloads the AI. Nothing to type. It takes about 10 to 30 minutes, mostly the download.'}</p>
            <div className="row"><a className="btn primary" href={setupHref} download="Photo Organizer free AI setup.cmd">Download the setup file</a><span className="muted">For Windows.</span></div>
            <p className="muted">If Windows warns that the file is new, click “More info”, then “Run anyway”. This page checks by itself every few seconds and goes on when the AI is ready.</p>
          </div>
        )}
        {access === 'prompt' && found?.state !== 'ok' && <p className="muted">Chrome will ask whether this site may connect to apps on this PC: click <b>Allow</b>.</p>}
        {access === 'denied' && found?.state !== 'ok' && <p className="notice">Chrome is blocking this page from apps on this PC. Click the icon left of the web address, open <b>Site settings</b>, set <b>Local network access</b> to <b>Allow</b>, then reload the page.</p>}
        {pull?.error && <div className="notice row"><span>{pull.error}</span><button className="btn" onClick={download}>Try again</button></div>}
        {test?.noPhotos && <p className="notice">No photos to test here. Choose photos first, or open your folder again if the app asks.</p>}
        {test?.error && <p className="notice">{test.error}</p>}
        {test?.why && <p className="muted">Some photos couldn’t be opened and were skipped: {test.why}</p>}

        <div className="row">
          {busy && <button className="btn" onClick={() => stop.current?.abort()}>Stop</button>}
          {ready && !busy && <button className="btn primary" onClick={again}>{rows.length ? `Try ${TEST_COUNT} other photos` : 'Start the test'}</button>}
        </div>
      </section>

      {rows.length > 0 && (
        <section className="panel">
          <h2>{test?.running ? `So far: ${rows.length} of ${TEST_COUNT} photos` : `Result: ${rows.length} photos`}</h2>
          <dl className="aisum">
            <div><dt>Speed</dt><dd>{avg ? `${secs(avg)} per photo` : `${secs(rows[0].seconds)} for the first photo`}{rows[0].loadSeconds >= 1 && <span className="muted"> (plus {secs(rows[0].loadSeconds)} to start the AI)</span>}</dd></div>
            {avg > 0 && photoCount > 0 && <div><dt>All your photos</dt><dd>{photoCount.toLocaleString()} photos would take {roughTime(avg * photoCount)} at this speed</dd></div>}
            <div><dt>Groups</dt><dd>{junk} could go (documents, screenshots, labels, screens, thermal) · {rows.length - junk} keep</dd></div>
            {test && test.skipped > 0 && <div><dt>Skipped</dt><dd>{test.skipped} that the browser couldn’t open (HEIC, RAW, or not reachable)</dd></div>}
          </dl>
          <div className="aigrid">
            {rows.map((r, i) => {
              const g = GROUP_INFO[r.answer.group];
              return (
                <article className="aicard" key={r.it.id}>
                  <button className="aipic" onClick={() => onOpen(rows.map((x) => x.it), i)} title="Open the photo"><img src={r.url} alt={r.answer.description || r.it.name} /></button>
                  <div className="aitext">
                    <div className="row"><span className={`aigroup ${g.junk ? 'junk' : 'keep'}`}>{g.name}</span><span className="muted mono">{secs(r.seconds)}</span></div>
                    {r.answer.description && <p>{r.answer.description}</p>}
                    {r.answer.sees.length > 0 && <div className="aisees">{r.answer.sees.map((s, k) => <span key={k}>{s}</span>)}</div>}
                    {r.answer.text && <p><span className="muted">Text read:</span> <span className="mono">{r.answer.text}</span></p>}
                    {r.answer.people > 0 && <p className="muted">{r.answer.people} {r.answer.people === 1 ? 'person' : 'people'}</p>}
                  </div>
                </article>
              );
            })}
          </div>
        </section>
      )}
    </div>
  );
}
