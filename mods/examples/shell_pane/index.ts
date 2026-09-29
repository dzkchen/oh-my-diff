import type { ModAPI } from '@oh-my-diff/mod-api';

export default function activate(api: ModAPI) {
  api.command('shell', cwd => {
    const started = api.host.call('terminal.pty', { action: 'start', session: 'shell', cwd: String(cwd || '.') });
    api.state.set('status' in started ? null : 'shell');
    return { display: 'status' in started ? 'Shell declined' : 'Shell pane opened; Tab focuses it, Ctrl+] leaves it' };
  });
  api.command('shell_stop', () => {
    api.host.call('terminal.pty', { action: 'stop', session: 'shell' });
    api.state.set(null);
    return { display: 'Shell stopped' };
  });
  api.on('terminal', () => api.state.get() === 'shell'
    ? { sites: { 'shell_pane/shell': { components: [{ type: 'terminal', id: 'shell-pane', label: 'Shell', session: 'shell', height: 16 }] } } }
    : null);
}
