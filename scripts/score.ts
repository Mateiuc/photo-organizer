// Test tool, usage: vite-node scripts/score.ts <fingerprints.json from embed.mjs> <scale: 100 for CLIP, 112.67 for SigLIP 2> <truth.json>
// Scores the test pictures with the app's own grouping code and compares with what each picture really is.
import fs from 'node:fs';
import { GROUPS, GROUP_BY_ID, LEARN, makeBank, place, scoreAll } from '../src/sort/groups';
import { quantize } from '../src/pictures/compare';
const [file, scaleArg, truthFile] = process.argv.slice(2);
const d = JSON.parse(fs.readFileSync(file, 'utf8'));
const truth: Record<string, string> = JSON.parse(fs.readFileSync(truthFile, 'utf8'));
LEARN.scale = Number(scaleArg);
const dim = d.image[0].length;
const bank = makeBank(Float32Array.from(d.text.flat()), dim);
const n = d.image.length;
const k = new Int8Array(n * dim);
d.image.forEach((v: number[], i: number) => k.set(quantize(v), i * dim));
const r = scoreAll(k, n, bank, undefined, dim);
const G = GROUPS.length;
let sideOk = 0, grpOk = 0, tot = 0, junkAsKeep = 0, keepAsJunk = 0; const rows: string[] = []; const outRows: unknown[] = [];
const isJunk = (s: string) => s === 'junk' || s === 'call';
d.files.forEach((f: string, i: number) => {
  const name = f.split('/').pop()!;
  const t = truth[name]; if (!t) return;
  const [tg, cam] = t.split(':');
  const want = tg.split('|');
  const p = place({ g: r.g[i], p: r.p[i], probs: r.probs.subarray(i * G, i * G + G) }, { camera: cam !== 'nocam' })!;
  const got = GROUPS[p.g];
  const wantJunk = isJunk(GROUPS[GROUP_BY_ID.get(want[0])!].side);
  const okSide = wantJunk === isJunk(got.side), okG = want.includes(got.id);
  tot++; sideOk += +okSide; grpOk += +okG;
  if (wantJunk && !okSide) junkAsKeep++; if (!wantJunk && !okSide) keepAsJunk++;
  outRows.push({ name, want: want[0], got: got.id, gotName: got.name, side: got.side, p: p.p, okSide, okG });
  rows.push(`${okSide ? (okG ? '  ' : '~ ') : 'X '}${name.padEnd(20)} want ${want[0].padEnd(8)} got ${got.id.padEnd(8)} ${(p.p * 100).toFixed(0).padStart(3)}% ${p.why}${p.guess != null ? ' (leaned ' + GROUPS[p.guess].id + ')' : ''}`);
});
if (process.env.OUT) fs.writeFileSync(process.env.OUT, JSON.stringify(outRows));
if (process.env.ROWS) console.log(rows.filter((x) => process.env.ROWS === 'all' || !x.startsWith('  ')).join('\n'));
console.log(`${file.split('/').pop()} scale ${scaleArg}: junk/keep right ${sideOk}/${tot}, exact group ${grpOk}/${tot}; keep shown as junk ${keepAsJunk}, junk not caught ${junkAsKeep}`);
