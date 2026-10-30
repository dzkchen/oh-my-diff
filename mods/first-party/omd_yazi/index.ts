import type { CommandResult, ModAPI, TerminalPatch } from '../../api.d.ts';

type State = { running: boolean; panel: boolean; dir: string | null };

const SESSION = 'yazi';
const SITE = 'omd_yazi/main';
const ID = 'omd_yazi_terminal';
const PANEL = 'yazi';
const MENTIONS = 16;
const HINT = 'Install it with brew install yazi (https://yazi-rs.github.io/docs/installation).';
const plain = (path: string) => path.split('/').every(part => part !== '' && part !== '.' && part !== '..');
const mention = (path: string) => (/[\s\x22]|\W$/.test(path) ? `@${JSON.stringify(path)}` : `@${path}`);

export default function activate(api: ModAPI) {
  const load = (): State => ({ running: false, panel: false, dir: null, ...(api.state.get() as Partial<State> | null) });
  const inside = (path: string) => path === api.session().root || path.startsWith(`${api.session().root}/`) && plain(path.slice(api.session().root.length + 1));
  const close = (dir: string | null) => {
    api.host.tryCall('terminal.pty', { action: 'stop', session: SESSION });
    if (load().panel) {
      try { api.services.call('omd.workspace', 'unregister', { id: PANEL }); } catch {}
    }
    api.state.set({ running: false, panel: false, dir });
  };

  const finish = (files: Record<string, string> = {}) => {
    const root = `${api.session().root}/`;
    const picked = (files.chosen ?? '').split('\n').filter(path => path.startsWith(root) && plain(path.slice(root.length))).slice(0, MENTIONS);
    const dir = (files.cwd ?? '').trim();
    close(inside(dir) ? dir : load().dir);
    if (!picked.length) return;
    const { revision } = api.host.call('composer.read', null);
    api.host.call('composer.write', { revision, edit: { kind: 'insert', text: `${picked.map(path => mention(path.slice(root.length))).join(' ')} ` } });
  };

  api.command('yazi', (args): CommandResult => {
    if (load().running) {
      const read = api.host.tryCall('terminal.pty', { action: 'read', session: SESSION });
      if (read.ok && 'running' in read.value && read.value.running) {
        api.host.tryCall('terminal.pane', { action: 'focus', id: ID });
        return { display: 'yazi is running' };
      }
      close(load().dir);
    }
    const { cwd } = api.session();
    const given = String(args ?? '').trim();
    const remembered = load().dir;
    const path = given.startsWith('/') ? given : given ? `${cwd}/${given}` : remembered && inside(remembered) ? remembered : cwd;
    const found = api.host.tryCall('exec.run', { program: 'yazi', argv: ['--version'], sandbox: 'none', timeout_ms: 5000 });
    if (!found.ok || found.value.exit_code !== 0) return { display: `Cannot run yazi (${found.ok ? `exit ${found.value.exit_code}` : found.error}). ${HINT}` };
    const started = api.host.tryCall('terminal.pty', {
      action: 'start', session: SESSION, program: 'yazi', cwd, sandbox: 'none',
      argv: [path, '--chooser-file={dir}/chosen', '--cwd-file={dir}/cwd'], files: { chosen: '', cwd: '' },
    });
    if (!started.ok) return { display: `yazi did not start: ${started.error}` };
    if (!('running' in started.value)) return { display: 'yazi start declined' };
    let panel = false;
    if (api.settings.placement === 'panel') {
      try { panel = !api.services.call<{ error?: string }>('omd.workspace', 'register', { id: PANEL, title: 'Yazi', site: SITE }).error; } catch {}
    }
    api.state.set({ running: true, panel, dir: remembered });
    api.host.tryCall('terminal.pane', { action: 'focus', id: ID });
    return { display: panel ? 'yazi started in its workspace tab' : 'yazi started (Ctrl+] leaves it)' };
  }, { description: 'Run yazi in this session and mention the files you pick', args_hint: '[path]' });

  api.on('terminal', ({ client }): TerminalPatch | null => {
    const { running, panel } = load();
    if (!running) return null;
    const sites = { [SITE]: { components: [{ type: 'terminal' as const, id: ID, label: 'yazi', session: SESSION, autofocus: true }] } };
    if (panel) return { sites };
    const chat = Math.min(99, Math.max(1, Math.round(500 / (client?.rows ?? 40))));
    return {
      sites,
      layout: { split: 'vertical', ratio: [100 - chat, chat], children: [
        { content: 'site:omd_yazi/main', title: '', style: { border: 'none', padding: 0 } },
        { split: 'vertical', ratio: [2, 3], children: [{ content: 'transcript' }, { content: 'composer' }] },
      ] },
    };
  });

  api.on('component_event', event => {
    if (event.component !== ID || event.kind !== 'exit') return;
    finish(event.files);
    if (event.exit_code) api.host.tryCall('terminal.notice', { text: `yazi exited with ${event.exit_code}`, kind: 'warning' });
  });
}
