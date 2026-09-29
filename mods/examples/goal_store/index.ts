import type { ModAPI } from '@oh-my-diff/mod-api';

export default function activate(api: ModAPI) {
  api.command('goal', text => {
    const current = api.host.call('store.get', { key: 'goal', scope: 'thread' });
    api.host.call('store.put', { key: 'goal', value: String(text), expected_revision: current?.revision ?? null, scope: 'thread' });
    return { display: 'Goal saved for this thread' };
  });
  api.on('resume', event => {
    if (event.restarted && event.last_turn?.status === 'interrupted') api.state.set({ interrupted: event.last_turn.turn_id });
  });
}
