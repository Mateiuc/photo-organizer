import { LATEST_HELPER } from '../gphotos/bridge';

const EDGE = typeof navigator !== 'undefined' && /\bEdg\//.test(navigator.userAgent);

/** How to put the new helper add-on in place of the old one. */
export function UpdateHelper({ have, need = LATEST_HELPER, what }: { have?: string; need?: string; what: string }) {
  return (
    <div className="notice">
      <p style={{ marginTop: 0 }}><b>The helper add-on needs an update for {what}</b>{have ? ` (this browser has version ${have}; this needs ${need})` : ''}. It takes a minute:</p>
      <ol className="steps">
        <li><a href={`${import.meta.env.BASE_URL}photo-organizer-helper.zip`} download>Download the new helper</a> and unzip it over the old helper folder, replacing the files.</li>
        <li>Open <code>{EDGE ? 'edge://extensions' : 'chrome://extensions'}</code> and click the reload button (circular arrow) on “Photo Organizer helper”.</li>
        <li>Come back here and reload this page.</li>
      </ol>
    </div>
  );
}
