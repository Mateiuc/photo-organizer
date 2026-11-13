// Runs the stronger face AI away from the page. The two model files come from Hugging Face the first time, are
// checked against their SHA-256, and are kept by the browser afterwards. The AI runtime comes from this app's own site.
import * as ort from 'onnxruntime-web/webgpu';
import { alignedInput, decodeFaces, detectorInput, MODELS, turn, unit, type Rgba } from './ada';
import { SELF_CHECK } from './ada.check';

type In =
  | { op: 'init'; base: string }
  | { op: 'find'; id: number; data: ArrayBuffer; width: number; height: number; minPx: number };
export interface WorkerFace { box: [number, number, number, number]; score: number; points: number[]; d: Float32Array; turn: number }

const post = (m: unknown, t?: Transferable[]) => (self as unknown as Worker).postMessage(m, t ?? []);
const CACHE = 'photo-organizer-face-models';
let det: ort.InferenceSession | null = null;
let rec: ort.InferenceSession | null = null;

async function sha256(buf: ArrayBuffer): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', buf))].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** A model file, from the browser's cache or else downloaded (with progress) and checked. */
async function modelFile(m: (typeof MODELS)[keyof typeof MODELS]): Promise<ArrayBuffer> {
  const cache = await caches.open(CACHE).catch(() => undefined);
  const hit = await cache?.match(m.url);
  if (hit) {
    const buf = await hit.arrayBuffer();
    if ((await sha256(buf)) === m.sha256) return buf;
    await cache?.delete(m.url);
  }
  let r: Response;
  try { r = await fetch(m.url); } catch { throw new Error('The face AI couldn’t be downloaded from Hugging Face (huggingface.co). Check the internet connection and try again.'); }
  if (!r.ok || !r.body) throw new Error(`The face AI couldn’t be downloaded (error ${r.status}). Try again later.`);
  const reader = r.body.getReader();
  const parts: Uint8Array[] = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value); loaded += value.length;
    post({ op: 'progress', file: m.file, loaded, total: m.bytes });
  }
  const buf = new Uint8Array(loaded);
  let o = 0;
  for (const p of parts) { buf.set(p, o); o += p.length; }
  if ((await sha256(buf.buffer)) !== m.sha256) throw new Error('The face AI file that arrived isn’t the expected one, so it wasn’t used. Try again later.');
  await cache?.put(m.url, new Response(buf.slice().buffer)).catch(() => {}); // no room to keep it: downloaded again next time
  return buf.buffer;
}

/** The fixed test input and its known answer (worked out on a PC's processor). A graphics card must give the same. */
function selfCheckOk(out: Float32Array): boolean {
  const u = unit(out).d, want = unit(SELF_CHECK.out).d;
  let c = 0;
  for (let i = 0; i < u.length; i++) c += u[i] * want[i];
  return c > 0.995;
}
const testInput = () => Float32Array.from({ length: 3 * 112 * 112 }, (_, i) => Math.sin(i * 0.001) * 0.9);

async function init(base: string) {
  ort.env.wasm.wasmPaths = base + 'ort/';
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.proxy = false;
  const [d, r] = await Promise.all([modelFile(MODELS.detector), modelFile(MODELS.recognizer)]);
  det = await ort.InferenceSession.create(d, { executionProviders: ['wasm'] });
  // AdaFace does most of the work: on the graphics card (WebGPU) when it gives the right answers, else on the processor.
  let device = 'processor';
  if ((navigator as Navigator & { gpu?: unknown }).gpu) {
    try {
      const s = await ort.InferenceSession.create(r, { executionProviders: ['webgpu'] });
      const o = await s.run({ input: new ort.Tensor('float32', testInput(), [1, 3, 112, 112]) });
      if (selfCheckOk(o.output.data as Float32Array)) { rec = s; device = 'graphics card'; } else await s.release();
    } catch { /* no usable graphics card: the processor it is */ }
  }
  if (!rec) {
    rec = await ort.InferenceSession.create(r, { executionProviders: ['wasm'] });
    const o = await rec.run({ input: new ort.Tensor('float32', testInput(), [1, 3, 112, 112]) });
    if (!selfCheckOk(o.output.data as Float32Array)) throw new Error('The face AI gave wrong answers on this computer, so it was stopped.');
  }
  post({ op: 'ready', device });
}

async function find(img: Rgba, minPx: number): Promise<WorkerFace[]> {
  if (!det || !rec) throw new Error('The face AI isn’t loaded');
  const inp = detectorInput(img);
  const r = await det.run({ input: new ort.Tensor('float32', inp.data, [1, 3, inp.h, inp.w]) });
  const found = decodeFaces(r.loc.data as Float32Array, r.conf.data as Float32Array, r.landmarks.data as Float32Array, inp).filter((f) => f.box[2] >= minPx);
  if (!found.length) return [];
  const SZ = 3 * 112 * 112;
  const batch = new Float32Array(found.length * SZ);
  found.forEach((f, i) => alignedInput(img, f.points, batch, i * SZ));
  const o = await rec.run({ input: new ort.Tensor('float32', batch, [found.length, 3, 112, 112]) });
  const all = o.output.data as Float32Array;
  return found.map((f, i) => {
    // the model's answer already has length 1; scaled again only to be safe
    return { box: f.box, score: f.score, points: f.points, d: unit(all.subarray(i * 512, (i + 1) * 512)).d, turn: turn(f.points) };
  });
}

self.onmessage = async (e: MessageEvent<In>) => {
  const m = e.data;
  try {
    if (m.op === 'init') await init(m.base);
    else {
      const faces = await find({ data: new Uint8ClampedArray(m.data), width: m.width, height: m.height }, m.minPx);
      post({ id: m.id, faces }, faces.map((f) => f.d.buffer as ArrayBuffer));
    }
  } catch (err) {
    const message = (err as Error)?.message || String(err);
    if (m.op === 'init') post({ op: 'error', message });
    else post({ id: m.id, error: message });
  }
};
