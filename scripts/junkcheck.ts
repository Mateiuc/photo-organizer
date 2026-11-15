// Test tool: does a second opinion from the tags catch photos the AI wrongly calls junk?
// usage: vite-node scripts/junkcheck.ts <truth.json> <fingerprints.json> [more ...]
// Uses the app's own grouping (place) and tags. A photo's `src` in truth.json says what it really is: sources listed
// in JUNK below are real junk (documents, labels), every other source is not junk.
import fs from 'node:fs';
import { quantize } from '../src/pictures/compare';
import { AI_DIM, GROUPS, makeBank, place, PROMPTS_VERSION, scoreAll } from '../src/sort/groups';
import { keepSigns, makeTagBank, tagAll, TAGS_VERSION } from '../src/sort/tags';

const [truthFile, ...fpFiles] = process.argv.slice(2);
const truth: Record<string, { src?: string }> = JSON.parse(fs.readFileSync(truthFile, 'utf8')).truth;
const f32 = (p: string) => { const b = fs.readFileSync(p); return new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4); };
const bank = makeBank(f32(`public/ai/sentences-${PROMPTS_VERSION}.bin`)), tagBank = makeTagBank(f32(`public/ai/tags-${TAGS_VERSION}.bin`));
const files: string[] = [], rows: Int8Array[] = [];
for (const f of fpFiles) { const j = JSON.parse(fs.readFileSync(f, 'utf8')); j.files.forEach((name: string, i: number) => { files.push(name); rows.push(quantize(Float32Array.from(j.image[i]))); }); }
const k = new Int8Array(rows.length * AI_DIM);
rows.forEach((r, i) => k.set(r, i * AI_DIM));
const ai = scoreAll(k, rows.length, bank), tags = tagAll(k, rows.length, tagBank);
const G = GROUPS.length;
const JUNK = /^(docs|plate|old:docs|old:shots|old:screens)/, SKIP = /^(meme|cards)/; // memes and cards: junk or not is the owner's call
const SURE = Number(process.env.SURE || 0.9);
for (const camera of [true, false]) {
  // before: the AI alone. after: with the tags' second opinion, as the app does it (place with keepSign).
  const n = { junk: 0, keep: 0, junkBefore: 0, junkAfter: 0, keepBefore: 0, keepAfter: 0, junkSureBefore: 0, junkSureAfter: 0, keepSureBefore: 0, keepSureAfter: 0 };
  const lines: string[] = [];
  files.forEach((f, i) => {
    const src = (truth[f] ?? truth[f.split('/').pop()!])?.src;
    if (!src || SKIP.test(src)) return;
    const isJunk = JUNK.test(src);
    const aiOne = { g: ai.g[i], p: ai.p[i], probs: ai.probs.subarray(i * G, i * G + G) };
    const o = { camera: isJunk ? camera && !/shots/.test(src) : camera };
    const signs = keepSigns(tags[i]);
    const before = place(aiOne, o)!, after = place(aiOne, { ...o, keepSign: signs.length > 0 })!;
    const jb = GROUPS[before.g].side === 'junk', ja = GROUPS[after.g].side === 'junk';
    if (isJunk) { n.junk++; n.junkBefore += +jb; n.junkAfter += +ja; n.junkSureBefore += +(jb && before.p >= SURE); n.junkSureAfter += +(ja && after.p >= SURE); }
    else { n.keep++; n.keepBefore += +jb; n.keepAfter += +ja; n.keepSureBefore += +(jb && before.p >= SURE); n.keepSureAfter += +(ja && after.p >= SURE); }
    if (process.env.ROWS && jb && (!isJunk || !ja)) lines.push(`  ${isJunk ? 'junk taken out ' : ja ? 'not junk, STAYS' : 'not junk, out   '} ${(before.p * 100).toFixed(0).padStart(3)}% ${GROUPS[before.g].id.padEnd(7)} ${src.padEnd(28)} ${signs.map((t) => t.id).join(',')}  ${f.split('/').pop()}`);
  });
  console.log(`\nphotos ${camera ? 'with' : 'without'} camera information:`);
  console.log(`  not junk (${n.keep}): shown as junk ${n.keepBefore} by the AI alone, ${n.keepAfter} with the tags' second opinion. "Sure" ones (${SURE * 100}%+): ${n.keepSureBefore}, then ${n.keepSureAfter}.`);
  console.log(`  real junk (${n.junk}): shown as junk ${n.junkBefore} by the AI alone, ${n.junkAfter} with the second opinion. "Sure" ones: ${n.junkSureBefore}, then ${n.junkSureAfter}.`);
  if (lines.length) console.log(lines.sort().join('\n'));
}
