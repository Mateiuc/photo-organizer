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
  /** When Google Photos was last read (it sits next to the folder or Drive above). */
  gpLastScan?: string;
}

/** Called after every change to the library, so the backup knows to save it. */
export const libraryEvents = { changed: () => {} };

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
  async putFolder(f: Folder) { await (await db(this.name)).put('folders', f); libraryEvents.changed(); }
  async putItems(items: Item[]) {
    const d = await db(this.name);
    const tx = d.transaction('items', 'readwrite');
    await Promise.all([...items.map((i) => tx.store.put(i)), tx.done]);
    libraryEvents.changed();
  }
  async removeItems(ids: string[]) {
    const d = await db(this.name);
    const tx = d.transaction('items', 'readwrite');
    await Promise.all([...ids.map((i) => tx.store.delete(i)), tx.done]);
    libraryEvents.changed();
  }
  async setMeta(m: Meta) { await (await db(this.name)).put('meta', m, 'meta'); libraryEvents.changed(); }
  async clear() {
    const d = await db(this.name);
    await Promise.all([d.clear('items'), d.clear('folders'), d.delete('meta', 'meta')]);
    libraryEvents.changed();
  }
  /** Replaces the whole library with a backup's contents. */
  async replaceAll(data: { items: Item[]; folders: Folder[]; meta: Meta }) {
    const d = await db(this.name);
    const tx = d.transaction(['items', 'folders', 'meta'], 'readwrite');
    await Promise.all([tx.objectStore('items').clear(), tx.objectStore('folders').clear()]);
    for (const i of data.items) tx.objectStore('items').put(i);
    for (const f of data.folders) tx.objectStore('folders').put(f);
    tx.objectStore('meta').put(data.meta ?? { roots: [] }, 'meta');
    await tx.done;
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
