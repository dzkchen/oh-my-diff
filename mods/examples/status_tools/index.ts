import type { ModAPI } from '@oh-my-diff/mod-api';

const EVERY_MS = 300_000;

export default function activate(api: ModAPI) {
  api.command('abort_turn', argument => {
    const turn_id = typeof argument === 'string' ? argument.trim() : '';
    const result = api.host.call('turns.abort', { turn_id });
    return { display: result.accepted ? 'Cancellation requested.' : 'Turn unchanged: absent, stale or has queued input.' };
  });
  api.dynamicTools(({ name }) => ({ tool: name, last_check: api.state.get() }));
  api.on('start', () => {
    api.host.call('tools.define', { name: 'last_check', description: 'Report when this mod last checked the workspace.',
      parameters: { type: 'object', properties: {}, additionalProperties: false } });
    api.host.call('events.schedule', { key: 'check', delay_ms: EVERY_MS });
  });
  api.on('timer', () => {
    api.state.set(new Date().toISOString());
    api.host.call('events.schedule', { key: 'check', delay_ms: EVERY_MS });
  });
}
