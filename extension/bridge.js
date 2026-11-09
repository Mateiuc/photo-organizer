// Runs on the Photo Organizer page only. Passes the page's requests to the add-on and the answers back.
(() => {
  const version = chrome.runtime.getManifest().version;
  window.addEventListener('message', (e) => {
    const m = e.data;
    if (e.source !== window || !m || m.to !== 'po-helper' || typeof m.id !== 'number') return;
    const answer = (res) => window.postMessage({ from: 'po-helper', id: m.id, res }, location.origin);
    try {
      chrome.runtime.sendMessage(m.msg).then(answer, (err) => answer({ error: String((err && err.message) || err) }));
    } catch (err) {
      // the add-on was updated or reloaded: this page has to be reloaded to talk to it again
      answer({ error: 'RELOAD_PAGE' });
    }
  });
  document.documentElement.dataset.poHelper = version; // lets the page see the add-on is installed
  window.postMessage({ from: 'po-helper', hello: version }, location.origin);
})();
