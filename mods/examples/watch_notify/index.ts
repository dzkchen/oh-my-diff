import type { ModAPI } from '@oh-my-diff/mod-api';

export default function activate(api: ModAPI) {
  api.on('start', () => {
    api.host.call('workspace.watch', { paths: ['src'], recursive: true, debounce_ms: 250 });
  });
  api.on('workspace_change', change => {
    if (change.source !== 'external' || change.changes.length === 0) return;
    const first = change.changes[0].path;
    api.host.tryCall('terminal.notify', { title: 'Files changed outside Codex', body: `${change.changes.length} change(s), first: ${first}` });
  });
}
