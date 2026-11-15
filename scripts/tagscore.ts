// Test tool: measures every tag on labelled pictures, with the app's own scoring (src/sort/tags.ts) and the tag
// sentence fingerprints that come with the app (public/ai/tags-N.bin).
// usage: vite-node scripts/tagscore.ts <truth.json> <fingerprints.json> [more fingerprints.json ...]
//   truth.json: { truth: { <file>: { pos: [tag ids it surely has], neg: [tag ids it surely doesn't have] } } }
//   fingerprints.json: made by scripts/embed.mjs ({ files, image })
//
// Prints, for each tag at its `min` in src/sort/tags.ts: of the photos it marks, how many are right; of the photos
// that have it, how many it finds; and how many it marks wrongly out of all that surely don't have it.
//
// FIT=1 also works out `min` and checks it honestly: the pictures are split in two halves by file name, `min` is
// chosen on one half and counted on the other, both ways round ("checked" columns). The `min` to put in tags.ts
// ("min from all") is chosen the same way on all pictures.
// How `min` is chosen: the lowest value that marks at most WRONG (default 0.005 = 1 in 200) of the photos that
// surely don't have the tag; then as much higher as costs no more than 3 in 100 of the photos found.
// SHOW=<tag ids> lists a tag's wrong marks and misses. OUT=<file> writes the table as JSON.
import fs from 'node:fs';
import { quantize } from '../src/pictures/compare';
import { AI_DIM } from '../src/sort/groups';
import { makeTagBank, TAGS, TAGS_VERSION, tagScores, tagSentences } from '../src/sort/tags';

const [truthFile, ...fpFiles] = process.argv.slice(2);
const truth: Record<string, { pos: string[]; neg: string[]; src?: string }> = JSON.parse(fs.readFileSync(truthFile, 'utf8')).truth;
const buf = fs.readFileSync(`public/ai/tags-${TAGS_VERSION}.bin`);
const emb = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
if (emb.length !== tagSentences().length * AI_DIM) throw new Error('public/ai/tags file does not match the tags: run `npm run sentences`');
const bank = makeTagBank(emb);

const files: string[] = [], rows: Int8Array[] = [];
for (const f of fpFiles) {
  const j = JSON.parse(fs.readFileSync(f, 'utf8')) as { files: string[]; image: number[][] };
  j.files.forEach((name, i) => { files.push(name); rows.push(quantize(Float32Array.from(j.image[i]))); }); // kept as whole numbers, as the app keeps them
}
const k = new Int8Array(rows.length * AI_DIM);
rows.forEach((r, i) => k.set(r, i * AI_DIM));
const sc = tagScores(k, rows.length, bank);
const T = TAGS.length;
const key = (f: string) => (truth[f] ? f : f.split('/').pop()!);
const half = (f: string) => { let h = 2166136261; for (const c of f.split('/').pop()!) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return (h >>> 0) % 2; };
const wrongMax = Number(process.env.WRONG || 0.005);
const show = (process.env.SHOW || '').split(',');
const fit = !!process.env.FIT;

interface Scores { pos: number[]; neg: number[] }
const count = (s: Scores, min: number) => ({ tp: s.pos.filter((x) => x >= min).length, fp: s.neg.filter((x) => x >= min).length });
function choose(s: Scores): number | undefined {
  const cuts = [...new Set([...s.pos, ...s.neg])].sort((a, b) => a - b);
  const low = cuts.find((c) => count(s, c).fp <= wrongMax * s.neg.length);
  if (low == null || !s.pos.length) return undefined;
  const keep = count(s, low).tp / s.pos.length - 0.03;
  const best = [...cuts].reverse().find((c) => c >= low && count(s, c).tp / s.pos.length >= keep) ?? low;
  return Math.floor(best * 1000) / 1000;
}
const pct = (a: number, b: number) => (b ? `${Math.round((100 * a) / b)}%` : '–').padStart(4);

const out: Record<string, unknown>[] = [];
console.log(`tag        has   not |  min    right  found  wrong marks${fit ? '       | checked on the other half: right  found  wrong marks | min from all' : ''}`);
TAGS.forEach((tag, t) => {
  const all: Scores = { pos: [], neg: [] }, halves: Scores[] = [{ pos: [], neg: [] }, { pos: [], neg: [] }];
  const posF: string[] = [], negF: string[] = [];
  files.forEach((f, i) => {
    const tr = truth[key(f)];
    if (!tr) return;
    const s = sc[i * T + t];
    if (tr.pos.includes(tag.id)) { all.pos.push(s); halves[half(f)].pos.push(s); posF.push(f); } else if (tr.neg.includes(tag.id)) { all.neg.push(s); halves[half(f)].neg.push(s); negF.push(f); }
  });
  if (!all.pos.length || !all.neg.length) { console.log(tag.id.padEnd(9), 'no labelled pictures'); return; }
  const now = count(all, tag.min);
  let line = `${tag.id.padEnd(9)} ${String(all.pos.length).padStart(4)} ${String(all.neg.length).padStart(5)} | ${tag.min.toFixed(3)}  ${pct(now.tp, now.tp + now.fp)}   ${pct(now.tp, all.pos.length)}   ${now.fp} of ${all.neg.length}`;
  const row: Record<string, unknown> = { id: tag.id, name: tag.name, has: all.pos.length, not: all.neg.length, min: tag.min, ...now };
  if (fit) {
    // chosen on one half, counted on the other, both ways round
    let tp = 0, fp = 0;
    for (const h of [0, 1]) { const m = choose(halves[h]); const c = m == null ? { tp: 0, fp: 0 } : count(halves[1 - h], m); tp += c.tp; fp += c.fp; }
    const minAll = choose(all);
    line = `${line.padEnd(60)} | ${`${pct(tp, tp + fp)}   ${pct(tp, all.pos.length)}   ${fp} of ${all.neg.length} (${((100 * fp) / all.neg.length).toFixed(1)}%)`.padEnd(46)} | ${minAll?.toFixed(3) ?? 'none'}`;
    Object.assign(row, { checked: { tp, fp }, minAll });
  }
  console.log(line);
  out.push(row);
  if (show.includes(tag.id)) {
    negF.map((f, i) => [all.neg[i], f] as const).filter(([s]) => s >= tag.min).sort((a, b) => b[0] - a[0]).slice(0, 40).forEach(([s, f]) => console.log('   wrong mark', s.toFixed(3), f, truth[key(f)].src ?? ''));
    posF.map((f, i) => [all.pos[i], f] as const).filter(([s]) => s < tag.min).sort((a, b) => a[0] - b[0]).slice(0, 40).forEach(([s, f]) => console.log('   missed    ', s.toFixed(3), f, truth[key(f)].src ?? ''));
  }
});
if (process.env.OUT) fs.writeFileSync(process.env.OUT, JSON.stringify(out, null, 2));
