import type { ModAPI } from '@oh-my-diff/mod-api';

export default function activate(api: ModAPI) {
  api.on('terminal', () => ({ inline_sites: 'hidden' }));
}
