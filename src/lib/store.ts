// The local library: everything the app has learned about the photos, kept in the browser (IndexedDB).
// It can always be rebuilt from Drive, so losing it never loses anything.
import { openDB, type IDBPDatabase } from 'idb';
import type { Folder, Item } from './model';

export interface Meta {
  roots: Folder[];
  lastScan?: string;
  /** Where the photos come from: a folder on this computer, or Google Drive. */
  source?: 'local' | 'drive';
  localName?: string;
}

let dbp: Promise<IDBPDatabase> | null = null;
function db(name: string) {
  return (dbp ??= openDB(name, 1, {
    upgrade(d) {
      d.createObjectStore('items', { keyPath: 'id' });
      d.createObjectStore('folders', { keyPath: 'id' });
      d.createObjectStore('meta');
    },
  }));
}

export class Library {
  constructor(private name = 'photo-organizer') {}

  async load(): Promise<{ items: Item[]; folders: Folder[]; meta: Meta }> {
    const d = await db(this.name);
    const [items, folders, meta] = await Promise.all([d.getAll('items'), d.getAll('folders'), d.get('meta', 'meta')]);
    return { items, folders, meta: meta ?? { roots: [] } };
  }
  async putFolder(f: Folder) { await (await db(this.name)).put('folders', f); }
  async putItems(items: Item[]) {
    const d = await db(this.name);
    const tx = d.transaction('items', 'readwrite');
    await Promise.all([...items.map((i) => tx.store.put(i)), tx.done]);
  }
  async removeItems(ids: string[]) {
    const d = await db(this.name);
    const tx = d.transaction('items', 'readwrite');
    await Promise.all([...ids.map((i) => tx.store.delete(i)), tx.done]);
  }
  async setMeta(m: Meta) { await (await db(this.name)).put('meta', m, 'meta'); }
  async clear() {
    const d = await db(this.name);
    await Promise.all([d.clear('items'), d.clear('folders'), d.delete('meta', 'meta')]);
  }
}

/** Folder helpers built once per render from the folder list. */
export function folderIndex(folders: Folder[]) {
  const by = new Map(folders.map((f) => [f.id, f]));
  const pathCache = new Map<string, string>();
  const pathOf = (id?: string): string => {
    if (!id) return '';
    const hit = pathCache.get(id);
    if (hit != null) return hit;
    const f = by.get(id);
    const p = f ? (f.parentId && by.has(f.parentId) ? pathOf(f.parentId) + '/' : '') + f.name : '';
    pathCache.set(id, p);
    return p;
  };
  const inFolder = (itemFolder: string | undefined, root: string): boolean => {
    let cur = itemFolder, guard = 0;
    while (cur && guard++ < 40) {
      if (cur === root) return true;
      cur = by.get(cur)?.parentId;
    }
    return false;
  };
  const children = (id?: string) => folders.filter((f) => f.parentId === id).sort((a, b) => a.name.localeCompare(b.name));
  return { by, pathOf, inFolder, children };
}
