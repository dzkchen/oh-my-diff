import type { ModAPI } from '@oh-my-diff/mod-api';

export default function activate(api: ModAPI) {
  api.on('app_notification', notification => {
    if (notification.method === 'turn/completed') api.host.tryCall('terminal.notify', { title: 'Turn finished' });
  });
  api.on('focus', event => { if (!event.focused) api.state.set({ away_since: Date.now() }); });
}
