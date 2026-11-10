// Select and Move to trash: the bar at the bottom while photos are ticked, the window that asks before anything
// moves, and the Undo bar afterwards. Nothing is deleted for good: Google Photos keeps trashed items 60 days, Drive
// 30 days, and files in a folder go into a _Trash folder inside it.
import { useEffect } from 'react';
import { fmtSize, type Item } from '../lib/model';
import { clearTicks, selectAllShown, shownIds, stopSelecting, useSelection, useShownCount } from '../lib/selection';
import { older, TRASH_VERSION } from '../gphotos/bridge';
import { Preview } from './Grid';
import { UpdateHelper } from './Helper';

const plural = (n: number, one: string, many: string) => `${n.toLocaleString()} ${n === 1 ? one : many}`;
const things = (list: Item[]) => (list.every((x) => x.kind === 'video') ? plural(list.length, 'video', 'videos') : list.some((x) => x.kind === 'video') ? plural(list.length, 'item', 'items') : plural(list.length, 'photo', 'photos'));

const go = (l: Item[]) => (l.length === 1 ? 'goes' : 'go');
const them = (l: Item[]) => (l.length === 1 ? 'it' : 'them');

/** Where each item goes: Google Photos, Drive or a folder on this computer. */
export function byPlace(list: Item[]) {
  return { gp: list.filter((x) => x.gp), drive: list.filter((x) => !x.gp && !x.local), local: list.filter((x) => x.local) };
}

/** The bar along the bottom while selecting. */
export function SelectBar({ exists, onTrash }: { exists: (id: string) => boolean; onTrash: (ids: string[]) => void }) {
  const sel = useSelection();
  const shown = useShownCount();
  if (!sel.on) return null;
  const ids = [...sel.ids].filter(exists);
  const n = ids.length;
  const onScreen = n ? new Set(shownIds()) : undefined;
  const hidden = onScreen ? ids.filter((x) => !onScreen.has(x)).length : 0;
  return (
    <div className="selbar" role="toolbar" aria-label="Selected photos">
      <b>{n ? `${n.toLocaleString()} selected` : 'Tap photos to tick them'}</b>
      {!n && <span className="muted">Shift-click ticks every photo in between. The tick on a month takes the whole month.</span>}
      {hidden > 0 && <span className="muted">{hidden.toLocaleString()} of them {hidden === 1 ? "isn't" : "aren't"} shown right now (other filters or search)</span>}
      <span className="grow" />
      {shown > 0 && <button className="btn small" onClick={selectAllShown}>Select all {shown.toLocaleString()}</button>}
      {n > 0 && <button className="btn small" onClick={clearTicks}>Clear</button>}
      <button className="btn small danger" disabled={!n} onClick={() => onTrash(ids)}>Move to trash</button>
      <button className="btn small" onClick={stopSelecting}>Done</button>
    </div>
  );
}

export interface TrashJob {
  items: Item[];
  busy?: { done: number; total: number };
  error?: string;
}

/** Asks before anything moves: what, how many from each place, and where they go. */
export function TrashConfirm({ job, demo, helper, localName, localReady, localWritable, onConfirm, onCancel }: {
  job: TrashJob; demo: boolean; helper?: string; localName?: string; localReady: boolean; localWritable: boolean; onConfirm: () => void; onCancel: () => void;
}) {
  const { items, busy, error } = job;
  const { gp, drive, local } = byPlace(items);
  const size = items.reduce((s, x) => s + (x.size || 0), 0);
  const noHelper = !demo && gp.length > 0 && !helper;
  const oldHelper = !demo && gp.length > 0 && !!helper && older(helper, TRASH_VERSION);
  const noFolder = !demo && local.length > 0 && (!localWritable || !localReady);
  const blocked = noHelper || oldHelper || noFolder;
  useEffect(() => {
    const f = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) onCancel(); };
    window.addEventListener('keydown', f);
    return () => window.removeEventListener('keydown', f);
  }, [busy, onCancel]);
  return (
    <div className="overlay" onClick={(e) => { if (e.target === e.currentTarget && !busy) onCancel(); }}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="trash-title">
        <h2 id="trash-title">Move {things(items)} to the trash?</h2>
        <div className="tgrid">
          {items.slice(0, 24).map((x) => <span className="tthumb" key={x.id} title={x.name}><Preview item={x} px={160} /></span>)}
        </div>
        {items.length > 24 && <p className="muted" style={{ margin: 0 }}>and {(items.length - 24).toLocaleString()} more{size ? ` · ${fmtSize(size)} in all` : ''}</p>}
        <ul className="where">
          {gp.length > 0 && <li><b>{things(gp)} from Google Photos</b> {go(gp)} to Google Photos' Trash. You can restore {them(gp)} from there for 60 days; after that Google deletes {them(gp)}. While in the Trash, {gp.length === 1 ? 'it disappears' : 'they disappear'} from Google Photos on your phone too, and from albums.</li>}
          {drive.length > 0 && <li><b>{things(drive)} from Google Drive</b> {go(drive)} to Drive's trash. You can restore {them(drive)} from there for 30 days.</li>}
          {local.length > 0 && <li><b>{things(local)} from the folder “{localName ?? 'on this computer'}”</b> {go(local)} into the <code>_Trash</code> folder inside it, in the same sub-folders. Nothing is deleted from your computer: delete that folder yourself when you're sure.</li>}
        </ul>
        <p className="muted" style={{ margin: 0 }}>Nothing is deleted for good, and right after moving you can Undo.</p>
        {oldHelper && <UpdateHelper have={helper} need={TRASH_VERSION} what="Move to trash in Google Photos" />}
        {noHelper && <p className="notice" style={{ margin: 0 }}>The helper add-on isn't installed in this browser, so Google Photos can't be changed from here. See Choose photos › Google Photos.</p>}
        {noFolder && <p className="notice" style={{ margin: 0 }}>{localWritable ? `To move files in “${localName ?? 'your folder'}”, the browser first needs your OK to open it again: close this, then click Open folder at the top of the page.` : 'This browser can only read folders. To move files into _Trash, open the app in Chrome or Edge.'}</p>}
        {busy && (
          <>
            <div className="progress"><i style={{ width: `${busy.total ? (100 * busy.done) / busy.total : 0}%` }} /></div>
            <p className="muted" style={{ margin: 0 }}>Moving… {busy.done.toLocaleString()} of {busy.total.toLocaleString()}</p>
          </>
        )}
        {error && <p className="error" style={{ margin: 0 }}>{error}</p>}
        <div className="row">
          <button className="btn danger" disabled={blocked || !!busy} onClick={onConfirm} autoFocus>Move {things(items)} to the trash</button>
          <button className="btn" disabled={!!busy} onClick={onCancel}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

export interface UndoState {
  items: Item[];
  busy?: boolean;
  error?: string;
  restored?: boolean;
}

/** After moving: what happened, with Undo. */
export function UndoBar({ undo, onUndo, onClose }: { undo: UndoState; onUndo: () => void; onClose: () => void }) {
  const { gp, drive, local } = byPlace(undo.items);
  const where = [gp.length && "Google Photos' Trash", drive.length && "Drive's trash", local.length && 'the _Trash folder'].filter(Boolean).join(', ');
  return (
    <div className="undobar" role="status">
      <span>
        {undo.restored ? `Put back ${things(undo.items)}.` : `Moved ${things(undo.items)} to ${where}.`}
        {undo.error && <span className="error"> {undo.error}</span>}
      </span>
      <span className="grow" />
      {!undo.restored && <button className="btn small" disabled={undo.busy} onClick={onUndo}>{undo.busy ? 'Putting back…' : 'Undo'}</button>}
      <button className="btn small" aria-label="Close" onClick={onClose}>✕</button>
    </div>
  );
}
