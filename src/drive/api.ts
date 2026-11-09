// Google sign-in (Google Identity Services, token flow) and the Drive REST calls the app uses.
import type { DriveFile, Folder } from '../lib/model';

const SCOPE = 'https://www.googleapis.com/auth/drive';
const API = 'https://www.googleapis.com/drive/v3';
export const FILE_FIELDS =
  'id,name,mimeType,size,md5Checksum,createdTime,modifiedTime,parents,thumbnailLink,webViewLink,appProperties,' +
  'imageMediaMetadata(time,width,height,cameraMake,cameraModel,location),videoMediaMetadata(width,height,durationMillis)';
export const FOLDER_MIME = 'application/vnd.google-apps.folder';

declare global {
  interface Window {
    google?: any;
  }
}

let token: { value: string; exp: number } | null = null;
let tokenClient: any = null;

// Cip's Google OAuth Client ID (public by design; the client secret is never used in a browser app).
const DEFAULT_CLIENT_ID = '748955765947-lodu85tvdbkvag04a1045lijna2rijqt.apps.googleusercontent.com';

export function clientId(): string {
  try {
    const saved = localStorage.getItem('po.clientId');
    if (saved) return saved;
  } catch {}
  return (import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined) || DEFAULT_CLIENT_ID;
}

function loadGis(): Promise<void> {
  if (window.google?.accounts?.oauth2) return Promise.resolve();
  return new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.async = true;
    s.onload = () => res();
    s.onerror = () => rej(new Error('Could not load Google sign-in. Check your internet connection.'));
    document.head.appendChild(s);
  });
}

/** Opens Google's sign-in popup when needed; resolves with a fresh access token. */
export async function signIn(prompt: '' | 'consent' = ''): Promise<string> {
  if (token && token.exp > Date.now() + 60_000) return token.value;
  const id = clientId();
  if (!id) throw new Error('No Google Client ID set. Open Settings and paste it.');
  await loadGis();
  return new Promise((res, rej) => {
    tokenClient = window.google.accounts.oauth2.initTokenClient({
      client_id: id,
      scope: SCOPE,
      callback: (r: any) => {
        if (r.error) return rej(new Error(r.error_description || r.error));
        token = { value: r.access_token, exp: Date.now() + Number(r.expires_in) * 1000 };
        try { localStorage.setItem('po.signedIn', '1'); } catch {}
        res(token.value);
      },
      error_callback: (e: any) => rej(new Error(e?.message || 'Sign-in was closed.')),
    });
    tokenClient.requestAccessToken({ prompt });
  });
}

export function signOut() {
  if (token && window.google?.accounts?.oauth2) window.google.accounts.oauth2.revoke(token.value, () => {});
  token = null;
  try { localStorage.removeItem('po.signedIn'); } catch {}
}

async function call<T>(path: string, init: RequestInit = {}, retry = 2): Promise<T> {
  const t = await signIn();
  const r = await fetch(API + path, { ...init, headers: { ...(init.headers ?? {}), Authorization: `Bearer ${t}` } });
  if (r.status === 401 && retry > 0) {
    token = null;
    return call(path, init, retry - 1);
  }
  if ((r.status === 429 || r.status >= 500 || r.status === 403) && retry > 0) {
    const body = r.status === 403 ? await r.clone().text() : '';
    if (r.status !== 403 || /rateLimit|userRateLimit/i.test(body)) {
      await new Promise((ok) => setTimeout(ok, 1500 * (3 - retry) + Math.random() * 500));
      return call(path, init, retry - 1);
    }
  }
  if (!r.ok) {
    let msg = `${r.status}`;
    try { msg = (await r.json()).error?.message ?? msg; } catch {}
    throw new Error('Google Drive: ' + msg);
  }
  return r.status === 204 ? (undefined as T) : r.json();
}

interface ListPage { files: DriveFile[]; nextPageToken?: string }

export async function listChildren(parentId: string, onlyFolders = false): Promise<DriveFile[]> {
  const out: DriveFile[] = [];
  let pageToken: string | undefined;
  const q = `'${parentId}' in parents and trashed = false` + (onlyFolders ? ` and mimeType = '${FOLDER_MIME}'` : '');
  do {
    const p = new URLSearchParams({ q, pageSize: '1000', fields: `nextPageToken,files(${FILE_FIELDS})`, orderBy: 'name' });
    if (pageToken) p.set('pageToken', pageToken);
    const page = await call<ListPage>(`/files?${p}`);
    out.push(...page.files);
    pageToken = page.nextPageToken;
  } while (pageToken);
  return out;
}

export async function getFile(id: string): Promise<DriveFile> {
  return call<DriveFile>(`/files/${id}?fields=${encodeURIComponent(FILE_FIELDS)}`);
}

export interface ScanProgress { folders: number; files: number; current: string }

/**
 * Walks the chosen folders and every subfolder. Yields each folder's files as it goes,
 * so the library fills while the scan runs. Runs several folders at once.
 */
export async function scanFolders(
  roots: Folder[],
  onFolder: (folder: Folder, media: DriveFile[], subfolders: Folder[]) => Promise<void>,
  onProgress: (p: ScanProgress) => void,
  signal: { stop: boolean },
): Promise<void> {
  const queue: Folder[] = [...roots];
  let folders = 0, files = 0, active = 0;
  await new Promise<void>((done, fail) => {
    const next = () => {
      if (signal.stop) { if (active === 0) done(); return; }
      if (!queue.length && active === 0) return done();
      while (active < 4 && queue.length) {
        const f = queue.shift()!;
        active++;
        listChildren(f.id)
          .then(async (kids) => {
            const sub = kids.filter((k) => k.mimeType === FOLDER_MIME).map((k) => ({ id: k.id, name: k.name, parentId: f.id }));
            queue.push(...sub);
            const media = kids.filter((k) => k.mimeType !== FOLDER_MIME);
            folders++; files += media.length;
            await onFolder(f, media, sub);
            onProgress({ folders, files, current: f.name });
          })
          .then(() => { active--; next(); }, (e) => { active--; signal.stop = true; fail(e); });
      }
    };
    next();
  });
}

/** Moves a file to the Drive trash (recoverable for 30 days). */
export async function trashFile(id: string): Promise<void> {
  await call(`/files/${id}?fields=id`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ trashed: true }) });
}

/** Saves the app's tags on the file itself, so they travel with it to every device. */
export async function setTags(id: string, tags: string[]): Promise<void> {
  await call(`/files/${id}?fields=id`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ appProperties: { po_tags: tags.join('|').slice(0, 120) } }),
  });
}
