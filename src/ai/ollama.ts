// The free AI on this PC: Ollama, a free program that runs AI models on the computer itself (graphics card when it
// can, else the processor). The page talks to it at http://127.0.0.1:11434. Nothing leaves the PC.
//
// Two things must allow it, and the setup file (public/free-ai/) does the first:
// 1. Ollama only answers pages it was told to trust: OLLAMA_ORIGINS must include this site (it answers 403 otherwise).
// 2. Chrome asks once whether this site may connect to apps on this PC (local network access): the person clicks Allow.
// Tested in the container (Ollama 0.40.16, Chromium 153): both are needed, and with both the page gets answers.

export const API = 'http://127.0.0.1:11434';
/**
 * Gemma 4 E4B (Google, Apache 2.0), 4-bit, 5.2 GB, sees pictures. Tested with Ollama on 29 labelled photos: 27 junk/keep
 * right, 20 exact group; about 16 s per photo on a 4-core processor without a graphics card.
 */
export const MODEL = 'huggingface.co/ggml-org/gemma-4-E4B-it-GGUF:Q4_0';
export const MODEL_NAME = 'Gemma 4 (E4B)';
export const MODEL_GB = 5.2;
/** The setup file, served with the app. */
export const SETUP_FILE = 'free-ai/photo-organizer-free-ai-setup.cmd';
/** The photo is sent as a small copy: longer side this many pixels (what was tested). */
export const SEND_SIZE = 768;

export const GROUPS = ['document', 'screenshot', 'label', 'screen_photo', 'scan_tool', 'thermal', 'people', 'animal', 'food', 'wiring', 'lights', 'house_work', 'car', 'nature', 'other'] as const;
export type Group = (typeof GROUPS)[number];
/** Names shown on the page, and which side each group is on (junk = could go, keep = people and work). */
export const GROUP_INFO: Record<Group, { name: string; junk: boolean }> = {
  document: { name: 'Document', junk: true }, screenshot: { name: 'Screenshot', junk: true }, label: { name: 'Label / VIN', junk: true },
  screen_photo: { name: 'Photo of a screen', junk: true }, scan_tool: { name: 'Scan tool', junk: true }, thermal: { name: 'Thermal', junk: true },
  people: { name: 'People', junk: false }, animal: { name: 'Animal', junk: false }, food: { name: 'Food', junk: false },
  wiring: { name: 'Wiring', junk: false }, lights: { name: 'Lights / LEDs', junk: false }, house_work: { name: 'House work', junk: false },
  car: { name: 'Car', junk: false }, nature: { name: 'Nature', junk: false }, other: { name: 'Other', junk: false },
};

export const PROMPT = `Look at this photo and answer with one JSON object only, no other text:
{"description": "...", "sees": ["..."], "text": "...", "people": 0, "group": "..."}

"description": one short sentence that says what the photo shows.
"sees": up to 8 short words for the things in the photo.
"text": the most important text you can read in the photo (a VIN, a plate number, a title), or "".
"people": how many people you can see.
"group": choose it last, from what you described. Exactly one of:
- "document": a paper, receipt, invoice, form, contract, ID card, a page of text
- "screenshot": a direct capture of a phone or computer display (an app, a chat, a web page), not a photo
- "label": a sticker, label, nameplate, VIN plate, barcode or serial number
- "screen_photo": a camera photo of a computer monitor, TV or phone that is switched on
- "scan_tool": a car diagnostic scan tool or tablet showing car data
- "thermal": a picture from a thermal camera, in false colours with temperatures
- "people": a normal photo where people are the subject
- "animal": a normal photo of an animal
- "food": food or drink
- "wiring": wires, cables, connectors, car wiring, an electrical panel
- "lights": lamps, LEDs, LED strips, a room lit with coloured light
- "house_work": construction, renovation, building materials
- "car": a car or a part of a car
- "nature": landscape, plants, sky, sea
- "other": any other normal photo`;

/** The answer is held to this shape by Ollama itself (structured outputs), so the group is always one of GROUPS. */
export const SCHEMA = {
  type: 'object',
  properties: {
    description: { type: 'string' }, sees: { type: 'array', items: { type: 'string' } }, text: { type: 'string' },
    people: { type: 'integer' }, group: { type: 'string', enum: GROUPS },
  },
  required: ['description', 'sees', 'text', 'people', 'group'],
};

export interface Answer { description: string; sees: string[]; text: string; people: number; group: Group }

/** Reads the AI's answer. Loose on purpose: a missing or odd field becomes empty instead of failing the photo. */
export function parseAnswer(content: string): Answer {
  let j: any = {};
  try { j = JSON.parse(content); } catch {
    const m = content.match(/\{[\s\S]*\}/);
    if (m) try { j = JSON.parse(m[0]); } catch { /* left empty */ }
  }
  const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
  const group = (GROUPS as readonly string[]).includes(j.group) ? j.group as Group : 'other';
  const sees = Array.isArray(j.sees) ? j.sees.map(str).filter(Boolean).slice(0, 8) : [];
  const people = Number.isFinite(Number(j.people)) ? Math.max(0, Math.round(Number(j.people))) : 0;
  return { description: str(j.description), sees, text: str(j.text), people, group };
}

/** 'ok': Ollama answers this page. 'blocked': Ollama runs but doesn't let this page in yet. 'none': nothing answers. */
export type Found = { state: 'ok'; version: string } | { state: 'blocked' } | { state: 'none' };

/**
 * Looks for Ollama. A refused page and a missing program look the same to a normal request (both fail), so a second,
 * "no-cors" request tells them apart: it gets through whenever something answers at all.
 */
export async function findOllama(timeoutMs = 4000): Promise<Found> {
  try {
    const r = await fetch(`${API}/api/version`, { signal: AbortSignal.timeout(timeoutMs) });
    if (r.ok) return { state: 'ok', version: String((await r.json()).version ?? '') };
    if (r.status === 403) return { state: 'blocked' };
  } catch { /* checked below */ }
  try {
    await fetch(`${API}/api/version`, { mode: 'no-cors', signal: AbortSignal.timeout(timeoutMs) });
    return { state: 'blocked' };
  } catch { return { state: 'none' }; }
}

/**
 * Chrome's own permission for this site to reach apps on this PC: 'granted', 'prompt' (Chrome will ask), 'denied',
 * or undefined when this browser doesn't have such a permission (then there is nothing to allow).
 */
export async function localAccess(): Promise<PermissionState | undefined> {
  for (const name of ['local-network-access', 'loopback-network', 'local-network']) {
    try { return (await navigator.permissions.query({ name } as unknown as PermissionDescriptor)).state; } catch { /* next name */ }
  }
  return undefined;
}

async function call(path: string, body?: unknown, signal?: AbortSignal): Promise<Response> {
  const r = await fetch(`${API}${path}`, body === undefined ? { signal } : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal });
  if (!r.ok) {
    let msg = `${r.status}`;
    try { msg = (await r.json()).error || msg; } catch { /* keep status */ }
    throw new Error(`The AI program answered: ${msg}`);
  }
  return r;
}

/** The model names Ollama has on this PC. */
export async function installedModels(): Promise<string[]> {
  const j = await (await call('/api/tags')).json();
  return (j.models ?? []).map((m: { name?: string; model?: string }) => m.name || m.model || '');
}

export const hasModel = (names: string[], model = MODEL) => names.some((n) => n.toLowerCase() === model.toLowerCase());

export interface PullProgress { status: string; done: number; total: number }

/** Adds up the parts of a download: every part Ollama reported so far, by its digest. */
export function pullTotals(parts: Map<string, { total: number; completed: number }>): { done: number; total: number } {
  let done = 0, total = 0;
  for (const p of parts.values()) { done += p.completed; total += p.total; }
  return { done, total };
}

/** Downloads the AI into Ollama (Ollama keeps it; a stopped download continues next time). */
export async function pullModel(onProgress: (p: PullProgress) => void, signal?: AbortSignal, model = MODEL): Promise<void> {
  const r = await call('/api/pull', { model, stream: true }, signal);
  const reader = r.body!.getReader();
  const dec = new TextDecoder();
  const parts = new Map<string, { total: number; completed: number }>();
  let buf = '', ok = false;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
      if (!line) continue;
      const j = JSON.parse(line);
      if (j.error) throw new Error(`The AI download stopped: ${j.error}`);
      if (j.digest && j.total) parts.set(j.digest, { total: j.total, completed: j.completed ?? 0 });
      if (j.status === 'success') ok = true;
      onProgress({ status: String(j.status ?? ''), ...pullTotals(parts) });
    }
  }
  if (!ok) throw new Error('The AI download stopped before the end. Try again: it continues where it stopped.');
}

export interface Asked {
  answer: Answer;
  /** Seconds the AI worked on this photo (without loading itself into memory). */
  seconds: number;
  /** Seconds spent loading the AI into memory (the first photo, or after a few idle minutes). */
  loadSeconds: number;
  raw: string;
}

/** Asks the AI about one photo (a JPEG, base64, no "data:" prefix). */
export async function askPhoto(jpegBase64: string, signal?: AbortSignal, model = MODEL): Promise<Asked> {
  const j = await (await call('/api/chat', {
    model, stream: false, think: false, format: SCHEMA, keep_alive: '10m',
    options: { temperature: 0, num_predict: 300 },
    messages: [{ role: 'user', content: PROMPT, images: [jpegBase64] }],
  }, signal)).json();
  const raw = String(j.message?.content ?? '');
  const load = (j.load_duration ?? 0) / 1e9;
  return { answer: parseAnswer(raw), seconds: Math.max(0, (j.total_duration ?? 0) / 1e9 - load), loadSeconds: load, raw };
}

/** n photos spread over the list, picked by a seed (the same seed gives the same photos). */
export function pickSample<T>(list: readonly T[], n: number, seed: number): T[] {
  const a = list.slice();
  let s = (seed >>> 0) || 1;
  const rnd = () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
  for (let i = a.length - 1; i > 0; i--) { const k = Math.floor(rnd() * (i + 1)); [a[i], a[k]] = [a[k], a[i]]; }
  return a.slice(0, n);
}

/** "about 3 hours", "about 2 days": how long the whole library would take at this speed. */
export function roughTime(seconds: number): string {
  const h = seconds / 3600;
  if (h < 1) return `about ${Math.max(1, Math.round(seconds / 60))} minutes`;
  if (h < 48) return `about ${Math.round(h)} ${Math.round(h) === 1 ? 'hour' : 'hours'}`;
  return `about ${Math.round(h / 24)} days`;
}
