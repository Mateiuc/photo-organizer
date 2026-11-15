// Test tool: makes fingerprints of test pictures and of sentences with the real AI files (the old CLIP or SigLIP 2),
// the same way the app does, so the two can be compared with scripts/score.ts.
// usage: node scripts/embed.mjs <clip|siglip> <models dir> <list.txt> <out.json> <sentences.json>
import { AutoProcessor, AutoTokenizer, CLIPTextModelWithProjection, CLIPVisionModelWithProjection, SiglipTextModel, SiglipVisionModel, env, RawImage } from '@huggingface/transformers';
import fs from 'node:fs';
const [kind, dir, list, out, promptsFile] = process.argv.slice(2);
env.allowRemoteModels = false; env.localModelPath = dir;
const id = kind === 'clip' ? 'Xenova/clip-vit-base-patch32' : 'onnx-community/siglip2-base-patch16-224-ONNX';
const unit = (a) => { let s = 0; for (const v of a) s += v * v; const k = 1 / Math.sqrt(s); return Array.from(a, (v) => v * k); };
const prompts = JSON.parse(fs.readFileSync(promptsFile, 'utf8')); // the sentences, as a JSON list
const tok = await AutoTokenizer.from_pretrained(id);
let text;
if (kind === 'clip') {
  const m = await CLIPTextModelWithProjection.from_pretrained(id, { dtype: 'fp32' });
  const { text_embeds } = await m(tok(prompts, { padding: true, truncation: true }));
  text = text_embeds.tolist().map(unit);
} else {
  const m = await SiglipTextModel.from_pretrained(id, { dtype: process.env.TEXT_DTYPE || 'fp32' });
  const { pooler_output } = await m(tok(prompts.map((p) => p.toLowerCase()), { padding: 'max_length', max_length: 64, truncation: true }));
  text = pooler_output.tolist().map(unit);
}
const proc = await AutoProcessor.from_pretrained(id);
const vis = kind === 'clip' ? await CLIPVisionModelWithProjection.from_pretrained(id, { dtype: 'fp32' }) : await SiglipVisionModel.from_pretrained(id, { dtype: 'fp32' });
const files = fs.readFileSync(list, 'utf8').trim().split('\n');
const old = process.env.REUSE && fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, 'utf8')) : null;
const image = old ? old.image : []; let ms = old ? old.msPerImage * files.length : 0;
for (const f of old ? [] : files) {
  let img = await RawImage.read(f);
  const k = 336 / Math.max(img.width, img.height);
  if (k < 1) img = await img.resize(Math.round(img.width * k), Math.round(img.height * k));
  const t = performance.now();
  const o = await vis(await proc(img));
  ms += performance.now() - t;
  image.push(unit((o.image_embeds ?? o.pooler_output).data));
}
fs.writeFileSync(out, JSON.stringify({ files, text, image, msPerImage: ms / files.length }));
console.log(kind, 'dim', image[0].length, 'ms/image', (ms / files.length).toFixed(0));
