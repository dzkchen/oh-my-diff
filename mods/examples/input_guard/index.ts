import type { ModAPI } from '../../api.d.ts';

// Ignores Ctrl+U so one keystroke can't wipe a draft, and spaces typed at the start of the prompt.
export default function activate(api: ModAPI) {
  api.intercept('composer_key', { match: { key: 'Ctrl+u' } }, () => ({ deny: 'Ctrl+U is disabled' }));
  api.intercept('composer_key', { match: { key: ' ', cursor: 0 } }, () => ({ deny: 'leading space' }));
}
