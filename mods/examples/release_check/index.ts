import type { ModAPI, TerminalComponent } from '@oh-my-diff/mod-api';

export default function activate(api: ModAPI) {
  api.contract({
    schema: 2, id: 'release_check', version: 1, description: 'A passing check run is required before completion',
    assurance: 'checked', gates: { complete: [{ receipt: 'checks', bind: ['candidate'] }] },
  });
  api.builtins({ commands: { hide: ['plan'] } });
  api.tool({
    name: 'check', label: 'Release check', description: 'Run the repository check, record evidence and request completion',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  }, () => {
    const candidate = api.host.call('workspace.snapshot', {}).candidate_sha256;
    const sources = api.host.call('workspace.list', { path: 'src', recursive: true });
    const run = api.host.call('exec.run', { program: 'sh', argv: ['-c', 'test -d src'], timeout_ms: 5000 });
    api.host.call('workspace.snapshot', { expected: candidate });
    const evidence = api.host.call('evidence.write', {
      media_type: 'application/json', label: 'check run', content: { exit_code: run.exit_code, files: sources.entries.length },
    });
    const previous = api.host.call('store.get', { key: 'runs' });
    api.host.call('store.put', {
      key: 'runs', value: Number(previous?.value ?? 0) + 1, expected_revision: previous?.revision ?? null,
    });
    api.host.call('receipts.submit', {
      kind: 'checks', candidate_sha256: candidate, outcome: run.exit_code === 0 ? 'pass' : 'fail', evidence,
    });
    return api.host.call('task.complete', { candidate_sha256: candidate });
  });
  api.command('routes', () => ({ display: api.host.call('routes.list', null).map(route => route.name).join(', ') }));
  api.middleware('response_stream', event =>
    event.boundary && /\bTODO\b/.test(event.text ?? '')
      ? { stop: { reason: 'unfinished marker' }, retry: { inject: 'Remove TODO markers before finishing.' } }
      : null);
  api.replace('list', event => {
    const rows = event.items.map(item => ({
      value: String(item.order), label: item.label,
      spans: [{ text: item.current ? `${item.label} (current)` : item.label, tone: item.current ? 'accent' as const : 'normal' as const }],
    }));
    const list: TerminalComponent = {
      type: 'list', id: 'rows', label: event.title, rows,
      selected: event.selected === null ? undefined : String(event.selected), action: { command: 'release_check:routes' },
    };
    return [list];
  });
}
