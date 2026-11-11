// Runs the CLIP AI away from the page: turns pictures and sentences into fingerprints. The model files come from
// Hugging Face the first time and are kept by the browser afterwards; the AI runtime comes from this app's own site.
import { AutoProcessor, AutoTokenizer, CLIPTextModelWithProjection, CLIPVisionModelWithProjection, env, RawImage } from '@huggingface/transformers';

type In =
  | { op: 'init'; base: string; model: string; text: boolean }
  | { op: 'text'; id: number; prompts: string[] }
  | { op: 'image'; id: number; bmp: ImageBitmap };

const post = (m: unknown, t?: Transferable[]) => (self as unknown as Worker).postMessage(m, t ?? []);
let vision: Awaited<ReturnType<typeof CLIPVisionModelWithProjection.from_pretrained>> | null = null;
let processor: Awaited<ReturnType<typeof AutoProcessor.from_pretrained>> | null = null;
let textModel: Awaited<ReturnType<typeof CLIPTextModelWithProjection.from_pretrained>> | null = null;
let tokenizer: Awaited<ReturnType<typeof AutoTokenizer.from_pretrained>> | null = null;

function unit(data: ArrayLike<number>, rows: number, dim: number): Float32Array {
  const out = new Float32Array(rows * dim);
  for (let r = 0; r < rows; r++) {
    let s = 0;
    for (let d = 0; d < dim; d++) s += data[r * dim + d] ** 2;
    const k = s ? 1 / Math.sqrt(s) : 0;
    for (let d = 0; d < dim; d++) out[r * dim + d] = data[r * dim + d] * k;
  }
  return out;
}

let canvas: OffscreenCanvas | null = null;
function toRaw(bmp: ImageBitmap): RawImage {
  canvas ??= new OffscreenCanvas(1, 1);
  canvas.width = bmp.width; canvas.height = bmp.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(bmp, 0, 0);
  const px = ctx.getImageData(0, 0, bmp.width, bmp.height).data;
  return new RawImage(px, bmp.width, bmp.height, 4);
}

self.onmessage = async (e: MessageEvent<In>) => {
  const m = e.data;
  try {
    if (m.op === 'init') {
      env.allowLocalModels = false;
      env.useBrowserCache = true;
      const onnx = env.backends.onnx as { wasm?: { wasmPaths?: string; numThreads?: number; proxy?: boolean } };
      if (onnx.wasm) { onnx.wasm.wasmPaths = m.base + 'ort/'; onnx.wasm.numThreads = 1; onnx.wasm.proxy = false; }
      const progress_callback = (p: { status: string; file?: string; loaded?: number; total?: number }) => {
        if (p.status === 'progress' && p.file) post({ op: 'progress', file: p.file, loaded: p.loaded ?? 0, total: p.total ?? 0 });
      };
      const opts = { dtype: 'q8' as const, device: 'wasm' as const, progress_callback };
      processor = await AutoProcessor.from_pretrained(m.model, { progress_callback });
      vision = await CLIPVisionModelWithProjection.from_pretrained(m.model, opts);
      if (m.text) {
        tokenizer = await AutoTokenizer.from_pretrained(m.model, { progress_callback });
        textModel = await CLIPTextModelWithProjection.from_pretrained(m.model, opts);
      }
      post({ op: 'ready' });
    } else if (m.op === 'text') {
      if (!tokenizer || !textModel) throw new Error('The text part of the AI isn’t loaded');
      const inputs = tokenizer(m.prompts, { padding: true, truncation: true });
      const { text_embeds } = await textModel(inputs);
      const [rows, dim] = text_embeds.dims as number[];
      const emb = unit(text_embeds.data as Float32Array, rows, dim);
      post({ id: m.id, emb, dim }, [emb.buffer]);
    } else if (m.op === 'image') {
      if (!vision || !processor) throw new Error('The AI isn’t loaded');
      const raw = toRaw(m.bmp);
      m.bmp.close();
      const inputs = await processor(raw);
      const { image_embeds } = await vision(inputs);
      const dim = (image_embeds.dims as number[])[1];
      const emb = unit(image_embeds.data as Float32Array, 1, dim);
      post({ id: m.id, emb }, [emb.buffer]);
    }
  } catch (err) {
    const message = (err as Error)?.message || String(err);
    if (m.op === 'init') post({ op: 'error', message });
    else post({ id: (m as { id: number }).id, error: message });
  }
};
