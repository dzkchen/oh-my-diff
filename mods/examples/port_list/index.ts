import type { ModAPI } from '@oh-my-diff/mod-api';

export default function activate(api: ModAPI) {
  api.command('port_list', () => {
    const { ports } = api.host.call('sessions.ports', null);
    return { display: ports.map(item => `${item.address} (pid ${item.pid})`).join('\n') || 'No listening ports from this session' };
  });
}
