import type { ModAPI } from '../../api.d.ts';

// Trims trailing spaces from pasted lines and refuses pastes that look like private keys.
export default function activate(api: ModAPI) {
  api.intercept('composer_edit', { match: { source: 'paste' } }, (event, next) => {
    if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(event.edit.text)) return { deny: 'the paste looks like a private key' };
    return next({ ...event, edit: { ...event.edit, text: event.edit.text.replace(/[ \t]+$/gm, '') } });
  });
}
