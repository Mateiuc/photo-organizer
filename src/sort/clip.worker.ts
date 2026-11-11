// Runs the CLIP AI away from the page: turns pictures and sentences into fingerprints. The model files come from
// Hugging Face the first time and are kept by the browser afterwards; the AI runtime comes from this app's own site.
import { AutoProcessor, AutoTokenizer, CLIPTextModelWithProjection, CLIPVisionModelWithProjection, env, RawImage } from '@huggingface/transformers';

type Dtype = 'fp32' | 'q8';
type In =
  | { op: 'init'; base: string; model: string; dtype: Dtype }
  | { op: 'text'; id: number; prompts: string[] }
  | { op: 'image'; id: number; bmp: ImageBitmap };

const post = (m: unknown, t?: Transferable[]) => (self as unknown as Worker).postMessage(m, t ?? []);
let vision: Awaited<ReturnType<typeof CLIPVisionModelWithProjection.from_pretrained>> | null = null;
let processor: Awaited<ReturnType<typeof AutoProcessor.from_pretrained>> | null = null;
let modelId = '';
let dtype: Dtype = 'fp32';
const progress_callback = (p: { status: string; file?: string; loaded?: number; total?: number }) => {
  if (p.status === 'progress' && p.file) post({ op: 'progress', file: p.file, loaded: p.loaded ?? 0, total: p.total ?? 0 });
};

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
      modelId = m.model; dtype = m.dtype;
      processor = await AutoProcessor.from_pretrained(m.model, { progress_callback });
      vision = await CLIPVisionModelWithProjection.from_pretrained(m.model, { dtype, device: 'wasm', progress_callback });
      post({ op: 'ready' });
    } else if (m.op === 'text') {
      // The words part is needed only once, to make the sentence fingerprints (the app keeps them), so it is loaded
      // here and let go straight after.
      const tokenizer = await AutoTokenizer.from_pretrained(modelId, { progress_callback });
      const textModel = await CLIPTextModelWithProjection.from_pretrained(modelId, { dtype, device: 'wasm', progress_callback });
      try {
        const inputs = tokenizer(m.prompts, { padding: true, truncation: true });
        const { text_embeds } = await textModel(inputs);
        const [rows, dim] = text_embeds.dims as number[];
        const emb = unit(text_embeds.data as Float32Array, rows, dim);
        post({ id: m.id, emb, dim }, [emb.buffer]);
      } finally {
        await textModel.dispose().catch(() => {});
      }
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
