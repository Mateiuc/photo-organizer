// Photo Organizer helper.
// The Photo Organizer page asks; this add-on runs Google Photos' own web requests inside your signed-in
// photos.google.com tab, exactly as the Google Photos website does, and hands the answer back to the page.
// Nothing is sent anywhere else.
//
// The request formats come from Google Photos Toolkit by xob0t (MIT licence):
// https://github.com/xob0t/google-photos-toolkit

// What the app may ask for. This version only reads: list the library, read file details and albums, and search.
const ALLOWED = new Set([
  'lcxiM', // library page, by date taken
  'EWgK9e', // file name and size for many items
  'fDcn4b', // full details of one item (camera, place name, albums)
  'VrseUb', // one item (fresh preview link)
  'Z5xsfc', // albums
  'snAcKc', // items in an album
  'EzwWhf', // storage used
  'EzkLib', // search, as in the Google Photos search box (added in 0.2.0)
]);
const IMAGE_HOSTS = /(^|\.)(googleusercontent\.com|usercontent\.google\.com|ggpht\.com)$/;
const PHOTOS = 'https://photos.google.com/';

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (sender.id !== chrome.runtime.id || !sender.tab) return false; // only the bridge on the app page
  handle(msg).then(reply, (e) => reply({ error: String((e && e.message) || e) }));
  return true; // answer comes later
});

async function handle(msg) {
  switch (msg && msg.op) {
    case 'ping':
      return { version: chrome.runtime.getManifest().version };
    case 'connect': {
      const r = await run(pageAccount, []);
      if (r.error === 'NOT_SIGNED_IN' && ownTab != null) chrome.tabs.update(ownTab, { active: true }).catch(() => {});
      return r;
    }
    case 'rpc':
      if (!ALLOWED.has(msg.rpcid)) return { error: 'NOT_ALLOWED' };
      return run(pageRpc, [msg.rpcid, msg.data]);
    case 'image': {
      let host = '';
      try { host = new URL(msg.url).hostname; } catch { /* not a URL */ }
      if (!IMAGE_HOSTS.test(host)) return { error: 'NOT_ALLOWED' };
      return run(pageImage, [msg.url]);
    }
    default:
      return { error: 'UNKNOWN' };
  }
}

// ---------- the Google Photos tab ----------
let ownTab = null; // a tab this add-on opened
let opening = null;

function loaded(tabId) {
  return new Promise((done) => {
    const finish = () => { clearTimeout(timer); chrome.tabs.onUpdated.removeListener(onUpd); done(); };
    const onUpd = (id, info) => { if (id === tabId && info.status === 'complete') finish(); };
    const timer = setTimeout(finish, 45000);
    chrome.tabs.onUpdated.addListener(onUpd);
    chrome.tabs.get(tabId).then((t) => { if (t.status === 'complete') finish(); }, finish);
  });
}

/** A signed-in photos.google.com tab: one you have open, or one opened in the background. */
async function photosTab() {
  const tabs = await chrome.tabs.query({ url: PHOTOS + '*' });
  const t = tabs.find((x) => !x.discarded && x.status === 'complete') || tabs.find((x) => !x.discarded) || tabs[0];
  if (t) {
    if (t.discarded) { await chrome.tabs.reload(t.id); await loaded(t.id); }
    else if (t.status !== 'complete') await loaded(t.id);
    return t.id;
  }
  if (ownTab != null) {
    // The tab we opened is still there but is no longer on photos.google.com: Google sent it to its sign-in page.
    const still = await chrome.tabs.get(ownTab).catch(() => null);
    if (still) return null;
    ownTab = null;
  }
  return (opening ??= (async () => {
    const nt = await chrome.tabs.create({ url: PHOTOS, active: false });
    ownTab = nt.id;
    await loaded(nt.id);
    const now = await chrome.tabs.get(nt.id).catch(() => null);
    return now && now.url && now.url.startsWith(PHOTOS) ? nt.id : null;
  })().finally(() => { opening = null; }));
}

async function run(func, args) {
  for (let attempt = 0; ; attempt++) {
    const tabId = await photosTab();
    if (tabId == null) return { error: 'NOT_SIGNED_IN' };
    try {
      const [r] = await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func, args });
      const res = r && r.result;
      if (res && res.error === 'NOT_READY' && attempt < 2) { await loaded(tabId); await new Promise((d) => setTimeout(d, 1500)); continue; }
      return res || { error: 'NO_ANSWER' };
    } catch (e) {
      if (attempt >= 1) throw e; // the tab was closed or reloaded meanwhile: try once more with a fresh tab
    }
  }
}

// ---------- these run inside the photos.google.com page ----------
function pageAccount() {
  const g = window.WIZ_global_data;
  if (!g) return { error: 'NOT_READY' };
  if (!g.SNlM0e) return { error: 'NOT_SIGNED_IN' };
  return { account: g.oPEP7c || '' };
}

async function pageRpc(rpcid, data) {
  const g = window.WIZ_global_data;
  if (!g) return { error: 'NOT_READY' };
  if (!g.SNlM0e) return { error: 'NOT_SIGNED_IN' };
  const wrapped = [[[rpcid, JSON.stringify(data), null, 'generic']]];
  const body = `f.req=${encodeURIComponent(JSON.stringify(wrapped))}&at=${encodeURIComponent(g.SNlM0e)}&`;
  const params = new URLSearchParams({ rpcids: rpcid, 'source-path': location.pathname, 'f.sid': g.FdrFJe, bl: g.cfb2h, pageId: 'none', rt: 'c' });
  const url = `https://photos.google.com${g.eptZe}data/batchexecute?${params}`;
  let last = '';
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const r = await fetch(url, { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8' }, body });
      if (r.status === 401) return { error: 'NOT_SIGNED_IN' };
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const text = await r.text();
      const line = text.split('\n').find((l) => l.includes('wrb.fr'));
      if (!line) throw new Error('Unexpected answer from Google Photos');
      const outer = JSON.parse(line);
      const payload = outer && outer[0] && outer[0][2];
      if (!payload) return { data: null }; // nothing there (an empty page)
      return { data: JSON.parse(payload) };
    } catch (e) {
      last = String((e && e.message) || e);
      if (attempt < 3) await new Promise((d) => setTimeout(d, 1500 * attempt));
    }
  }
  return { error: last };
}

async function pageImage(url) {
  try {
    const r = await fetch(url, { credentials: 'include', cache: 'force-cache' });
    if (!r.ok) return { error: `HTTP ${r.status}` };
    const blob = await r.blob();
    const dataUrl = await new Promise((done, fail) => { const fr = new FileReader(); fr.onload = () => done(fr.result); fr.onerror = () => fail(fr.error); fr.readAsDataURL(blob); });
    return { dataUrl };
  } catch (e) {
    return { error: String((e && e.message) || e) };
  }
}
