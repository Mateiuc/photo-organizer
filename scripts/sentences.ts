// Makes the sentence fingerprints that come with the app, with the full-size words part of the AI:
//   public/ai/sentences-N.bin  the Clean-up groups (src/sort/groups.ts, PROMPTS_VERSION)
//   public/ai/tags-N.bin       the tags (src/sort/tags.ts, TAGS_VERSION)
// Run `npm run sentences` after changing either list of sentences (and its version).
// With MODELS=<folder> the AI's files are read from <folder>/<model id>/ instead of Hugging Face.
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { AutoTokenizer, SiglipTextModel, env } from '@huggingface/transformers';
import { AI_DIM, AI_MODEL, AI_REVISION, PROMPTS_VERSION, promptList } from '../src/sort/groups';
import { TAGS_VERSION, tagSentences } from '../src/sort/tags';

if (process.env.MODELS) { env.allowRemoteModels = false; env.localModelPath = process.env.MODELS; }
const tokenizer = await AutoTokenizer.from_pretrained(AI_MODEL, { revision: AI_REVISION });
const model = await SiglipTextModel.from_pretrained(AI_MODEL, { revision: AI_REVISION, dtype: 'fp32' });
fs.mkdirSync('public/ai', { recursive: true });

async function make(kind: 'sentences' | 'tags', version: number, prompts: string[]) {
  // SigLIP 2 was trained on lower-case text, padded to 64 tokens.
  const { pooler_output } = await model(tokenizer(prompts.map((p) => p.toLowerCase()), { padding: 'max_length', max_length: 64, truncation: true }));
  const [rows, dim] = pooler_output.dims as number[];
  if (rows !== prompts.length || dim !== AI_DIM) throw new Error(`Unexpected size ${rows} × ${dim}`);
  const out = new Float32Array(rows * dim);
  const data = pooler_output.data as Float32Array;
  for (let r = 0; r < rows; r++) {
    let s = 0;
    for (let d = 0; d < dim; d++) s += data[r * dim + d] ** 2;
    const k = 1 / Math.sqrt(s);
    for (let d = 0; d < dim; d++) out[r * dim + d] = data[r * dim + d] * k;
  }
  const name = new RegExp(`^${kind}-\\d+\\.bin$`);
  for (const f of fs.readdirSync('public/ai')) if (name.test(f)) fs.rmSync(`public/ai/${f}`);
  fs.writeFileSync(`public/ai/${kind}-${version}.bin`, Buffer.from(out.buffer));
  const hash = createHash('sha256').update(JSON.stringify(prompts)).digest('hex');
  fs.writeFileSync(`src/sort/${kind}.json`, JSON.stringify({ version, model: AI_MODEL, revision: AI_REVISION, count: rows, dim, hash }, null, 2) + '\n');
  console.log(`public/ai/${kind}-${version}.bin: ${rows} sentences × ${dim}`);
}

await make('sentences', PROMPTS_VERSION, promptList().map((p) => p.text));
await make('tags', TAGS_VERSION, tagSentences().map((p) => p.text));
