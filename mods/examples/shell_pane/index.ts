import type { ModAPI } from '@oh-my-diff/mod-api';

export default function activate(api: ModAPI) {
  api.command('shell', cwd => {
    const started = api.host.call('terminal.pty', { action: 'start', session: 'shell', cwd: String(cwd || '.') });
    api.state.set('status' in started ? null : 'shell');
    return { display: 'status' in started ? 'Shell declined' : 'Shell pane opened; Alt+t or a click focuses it, Ctrl+] leaves it' };
  });
  api.command('run', line => {
    const [program, ...argv] = String(line).trim().split(/\s+/);
    if (!program) return { display: 'Usage: /run PROGRAM [ARGS]' };
    const started = api.host.call('terminal.pty', { action: 'start', session: 'shell', program, argv });
    api.state.set('status' in started ? null : 'shell');
    return { display: 'status' in started ? 'Run declined' : `${program} opened in the pane` };
  });
  api.command('shell_stop', () => {
    api.host.call('terminal.pty', { action: 'stop', session: 'shell' });
    api.state.set(null);
    return { display: 'Shell stopped' };
  });
  api.on('terminal', () => api.state.get() === 'shell'
    ? { keybindings: { 'Alt+t': { focus: 'shell_pane' } }, sites: { 'shell_pane/shell': { components: [{ type: 'terminal', id: 'shell_pane', label: 'Shell', session: 'shell', height: 16 }] } } }
    : null);
}
