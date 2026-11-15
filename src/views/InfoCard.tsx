// The info card: everything the app worked out about one photo, in one place. Nothing here looks at the photo again:
// the group and the tags come from the AI fingerprint the one read kept, the copies from the comparison data, and the
// names from the People page (only shown here, never changed).
import { useEffect, useMemo, useState } from 'react';
import { viaWhatsApp, type Item } from '../lib/model';
import { namesByItem, ready as peopleReady } from '../faces/people';
import type { Similar } from '../pictures/groups';
import { sharpKind, usePictures } from '../pictures/store';
import { sharpestOf } from '../read/plan';
import { GROUPS, SIDES, type Placed } from '../sort/groups';
import { fresh, knownAbout, sortable, useSort } from '../sort/store';
import { keepSigns, tagsIn } from '../sort/tags';

const WHY: Record<Placed['why'], string> = { ai: '', name: 'from the file name', face: 'a face was found', you: 'you put it here', unsure: 'the AI was not sure enough to call it junk', mixed: '' };
const alikeMin = () => { try { return (Number(localStorage.getItem('po.alike')) || 90) / 100; } catch { return 0.9; } };

export function InfoCard({ it, pathOf, exact, similar }: { it: Item; pathOf: (id?: string) => string; exact: Item[][]; similar: Similar }) {
  const sort = useSort();
  const pics = usePictures();
  const [known, setKnown] = useState<{ id: string; placed?: Placed; tags: number } | null>(null);
  const [names, setNames] = useState<{ id: string; names: string[] } | null>(null);
  const read = fresh(sort.recs.get(it.id));
  useEffect(() => {
    let live = true;
    knownAbout(it, pathOf).then((k) => live && setKnown({ id: it.id, ...k }), () => {});
    return () => { live = false; };
  }, [it, pathOf, read, sort.placed, sort.fixes.size]);
  useEffect(() => {
    let live = true;
    peopleReady().then(() => live && setNames({ id: it.id, names: namesByItem().get(it.id) ?? [] }), () => {});
    return () => { live = false; };
  }, [it]);
  const k = known?.id === it.id ? known : null;
  const who = names?.id === it.id ? names.names : [];

  const copies = useMemo(() => exact.find((g) => g.some((x) => x.id === it.id)), [exact, it.id]);
  const sameSet = useMemo(() => similar.same.find((g) => g.some((x) => x.id === it.id)), [similar.same, it.id]);
  const alike = useMemo(() => {
    const i = similar.byIndex.findIndex((x) => x.id === it.id);
    if (i < 0) return 0;
    const min = alikeMin(), mates = new Set(sameSet?.map((x) => x.id));
    let n = 0;
    for (let q = 0; q < similar.pairs.length; q += 3) {
      const a = similar.pairs[q], b = similar.pairs[q + 1];
      if ((a === i || b === i) && similar.pairs[q + 2] >= min && !mates.has(similar.byIndex[a === i ? b : a].id)) n++;
    }
    return n;
  }, [similar.pairs, similar.byIndex, sameSet, it.id]);
  const sharpest = useMemo(() => {
    if (!sameSet) return undefined;
    const rec = (x: Item) => pics.recs.get(x.id);
    return sameSet[sharpestOf(sameSet.map((x) => rec(x)?.sh ?? 0), sameSet.map((x) => sharpKind(x, rec(x))))];
  }, [sameSet, pics.v]); // eslint-disable-line react-hooks/exhaustive-deps

  const pl = k?.placed;
  const tags = tagsIn(k?.tags);
  const side = pl ? SIDES.find((s) => s.side === GROUPS[pl.g].side) : undefined;
  const compared = !!pics.recs.get(it.id)?.h;
  const from = viaWhatsApp(it, pathOf) ? 'WhatsApp' : it.kind === 'screenshot' ? 'A screenshot (from the file name)' : '';
  const rows: [string, JSX.Element | string][] = [];
  if (pl) {
    const sure = `${Math.round(pl.p * 100)}% sure`;
    const lean = pl.guess != null ? GROUPS[pl.guess].name : '';
    const note = pl.why === 'ai' ? sure
      : pl.why === 'unsure' ? `The AI leaned to ${lean}, but only ${sure}: not enough to call it junk`
      : pl.why === 'mixed' ? `The AI leaned to ${lean} (${sure}), but the photo also shows ${keepSigns(k?.tags).map((t) => t.name).join(', ')}`
      : WHY[pl.why];
    rows.push(['Group', <>{GROUPS[pl.g].name}{side && side.name !== GROUPS[pl.g].name && <span className="dim"> · {side.name}</span>}<br /><span className="dim">{note}</span></>]);
  }
  if (tags.length) rows.push(['In the photo', <span className="tagrow">{tags.map((t) => <span className="tag" key={t.id}>{t.name}</span>)}</span>]);
  if (who.length) rows.push(['People', who.join(', ')]);
  if (from) rows.push(['From', from]);
  const dup: string[] = [];
  if (copies) dup.push(`${copies.length - 1} identical ${copies.length === 2 ? 'file' : 'files'}`);
  if (sameSet) dup.push(`${sameSet.length - 1} more ${sameSet.length === 2 ? 'copy' : 'copies'} of the same photo${sharpest ? (sharpest.id === it.id ? ' (this one is the sharpest)' : ' (another one is sharper)') : ''}`);
  if (alike) dup.push(`${alike} look-${alike === 1 ? 'alike' : 'alikes'}`);
  if (dup.length) rows.push(['Copies', <>{dup.map((d, i) => <span key={i}>{i > 0 && <br />}{d}</span>)}</>]);
  else if (compared) rows.push(['Copies', 'None found']);

  if (!sortable(it) && !rows.length) return null;
  return (
    <section className="infocard" aria-label="What the app knows about this photo">
      <h3>What the app knows</h3>
      {rows.length > 0 && <dl>{rows.map(([name, value]) => <div key={name}><dt>{name}</dt><dd>{value}</dd></div>)}</dl>}
      {sortable(it) && it.kind !== 'screenshot' && !read && <p className="dim">The AI hasn’t looked at this photo yet. Clean up or Duplicates reads it.</p>}
      {read && !compared && <p className="dim">Not compared with the others yet.</p>}
    </section>
  );
}
