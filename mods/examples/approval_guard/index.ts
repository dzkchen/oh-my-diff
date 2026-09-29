import type { Json, ModAPI } from '@oh-my-diff/mod-api';

export default function activate(api: ModAPI) {
  api.middleware('approval', event => {
    const text = JSON.stringify(event.details);
    if (event.kind === 'exec' && /rm -rf \//.test(text)) return { deny: 'refusing to remove the filesystem root' };
    if (event.kind === 'network' && event.host_decision === 'skip') return { ask: 'network access needs a person' };
    return null;
  });
  api.on('approval_result', result => {
    const log = (api.state.get() as Json[] | null) ?? [];
    api.state.set([...log.slice(-49), { id: result.id, decision: result.decision, source: result.source }]);
  });
  api.command('approvals_log', () => ({ display: JSON.stringify(api.state.get(), null, 2) }), { description: 'Show recent approval outcomes' });
}
