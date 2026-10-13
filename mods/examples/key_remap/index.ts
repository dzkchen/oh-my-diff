import type { ModAPI } from '../../api.d.ts';

const keys: Record<string, string> = { 'Ctrl+b': 'Left', 'Ctrl+f': 'Right', 'Ctrl+p': 'Up', 'Ctrl+n': 'Down' };

// Emacs-style cursor keys in the prompt box; other keys never reach the mod.
export default function activate(api: ModAPI) {
  api.intercept('composer_key', { match: { key: Object.keys(keys) } }, (event, next) => next({ ...event, key: keys[event.key] }));
}
