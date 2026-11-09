import { useMemo, useState } from 'react';
import type { Folder, Item } from '../lib/model';

/** The Drive folder tree with photo counts (each count includes subfolders). */
export function Folders({ folders, items, roots, children, onPick }: { folders: Folder[]; items: Item[]; roots: Folder[]; children: (id?: string) => Folder[]; onPick: (f: Folder) => void }) {
  const counts = useMemo(() => {
    const by = new Map(folders.map((f) => [f.id, f]));
    const c = new Map<string, number>();
    for (const it of items) {
      let cur = it.folderId, g = 0;
      while (cur && g++ < 40) { c.set(cur, (c.get(cur) ?? 0) + 1); cur = by.get(cur)?.parentId; }
    }
    return c;
  }, [folders, items]);
  // A chosen folder that sits inside another chosen folder is shown under it, not again at the top.
  const tops = useMemo(() => {
    const by = new Map(folders.map((f) => [f.id, f]));
    const ids = new Set(roots.map((r) => r.id));
    return roots.filter((r) => { let cur = by.get(r.id)?.parentId, g = 0; while (cur && g++ < 40) { if (ids.has(cur)) return false; cur = by.get(cur)?.parentId; } return true; });
  }, [roots, folders]);
  const [open, setOpen] = useState<Set<string>>(() => new Set(tops.map((r) => r.id)));
  const expandAll = () => setOpen(new Set(folders.filter((f) => counts.get(f.id)).map((f) => f.id)));
  const collapseAll = () => setOpen(new Set());
  const node = (f: Folder, depth: number): JSX.Element | null => {
    const n = counts.get(f.id) ?? 0;
    if (!n) return null;
    const kids = children(f.id).filter((k) => counts.get(k.id));
    const isOpen = open.has(f.id);
    return (
      <div key={f.id}>
        <div className="tnode" style={{ paddingLeft: 6 + depth * 18 }}>
          <button className="tog" aria-label={isOpen ? 'Collapse' : 'Expand'} onClick={() => setOpen((s) => { const x = new Set(s); x.has(f.id) ? x.delete(f.id) : x.add(f.id); return x; })} style={{ visibility: kids.length ? 'visible' : 'hidden' }}>{isOpen ? '▾' : '▸'}</button>
          <span className="name" onClick={() => onPick(f)}>{f.name}</span>
          <span className="n">{n.toLocaleString()}</span>
        </div>
        {isOpen && kids.map((k) => node(k, depth + 1))}
      </div>
    );
  };
  return (
    <div className="stack">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <p className="muted" style={{ margin: 0 }}>Your folders as they are. Click a folder to see its photos and videos.</p>
        <div className="row"><button className="btn" onClick={expandAll}>Expand all</button><button className="btn" onClick={collapseAll}>Collapse all</button></div>
      </div>
      <div className="panel tree">{tops.map((r) => node(r, 0))}</div>
    </div>
  );
}
