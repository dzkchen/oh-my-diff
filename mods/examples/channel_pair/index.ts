import type { ModAPI } from '@oh-my-diff/mod-api';

export default function activate(api: ModAPI) {
  api.command('ping', text => {
    const delivery = api.host.call('events.publish', { channel: 'ping', data: typeof text === 'string' ? text : null });
    return { display: `delivered to ${delivery.delivered} subscriber(s)` };
  });
  api.on('channel', event => {
    api.state.set({ last: event.data, sequence: event.sequence, dropped: event.dropped });
  });
}
