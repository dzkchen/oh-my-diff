import type { CommandResult, ModAPI, TerminalPatch } from '../../api.d.ts';

type State = { running: boolean; panel: boolean; dir: string | null };

const SESSION = 'yazi';
const SITE = 'omd_yazi/main';
const ID = 'omd_yazi_terminal';
const PANEL = 'yazi';
const MENTIONS = 16;
const HINT = 'Install it: https://yazi-rs.github.io/docs/installation (Homebrew: brew install yazi).';
const IDLE = 'yazi is not running in this thread; /yazi starts it.';
const plain = (path: string) => path.split('/').every(part => part !== '' && part !== '.' && part !== '..');
const mention = (path: string) => (/[\s\x22]|\W$/.test(path) ? `@${JSON.stringify(path)}` : `@${path}`);
const lastLine = (text: string) => text.split('\n').map(line => line.trim()).filter(Boolean).pop()?.slice(0, 200) ?? '';

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
    const chosen = (files.chosen ?? '').split('\n').filter(Boolean);
    const inRoot = chosen.filter(path => path.startsWith(root) && plain(path.slice(root.length)));
    const picked = inRoot.slice(0, MENTIONS);
    const dir = (files.cwd ?? '').trim();
    close(inside(dir) ? dir : load().dir);
    const reasons = [chosen.length - inRoot.length && `${chosen.length - inRoot.length} outside this session`, inRoot.length - picked.length && `${inRoot.length - picked.length} over the ${MENTIONS} mention limit`].filter(Boolean);
    if (reasons.length) api.host.tryCall('terminal.notice', { text: `Skipped ${chosen.length - picked.length} picked paths (${reasons.join(', ')})`, kind: 'warning' });
    if (!picked.length) return;
    const { revision } = api.host.call('composer.read', null);
    api.host.call('composer.write', { revision, edit: { kind: 'insert', text: `${picked.map(path => mention(path.slice(root.length))).join(' ')} ` } });
  };

  api.command('yazi', (args): CommandResult => {
    const given = String(args ?? '').trim();
    if (given === '--stop' || given === 'stop') {
      if (!load().running) return { display: 'yazi is not running' };
      close(load().dir);
      return { display: 'yazi stopped' };
    }
    if (load().running) {
      const read = api.host.tryCall('terminal.pty', { action: 'read', session: SESSION });
      if (read.ok && 'running' in read.value && read.value.running) {
        api.host.tryCall('terminal.pane', { action: 'focus', id: ID });
        return { display: 'yazi is running' };
      }
      close(load().dir);
    }
    const { cwd } = api.session();
    const remembered = load().dir;
    const path = given.startsWith('/') ? given : given ? `${cwd}/${given}` : remembered && inside(remembered) ? remembered : cwd;
    const started = api.host.tryCall('terminal.pty', {
      action: 'start', session: SESSION, program: 'yazi', cwd, sandbox: 'none',
      argv: [path, '--chooser-file={dir}/chosen', '--cwd-file={dir}/cwd'], files: { chosen: '', cwd: '' },
    });
    if (!started.ok) return { display: started.error.includes('program_unavailable') ? `Cannot run yazi. ${HINT}` : started.error.includes('pty_cwd_invalid') ? `No such directory: ${cwd}` : `yazi did not start: ${started.error}` };
    if (!('running' in started.value)) return { display: 'yazi start declined' };
    const full = api.settings.placement === 'full';
    let panel = false;
    try {
      panel = !api.services.call<{ error?: string }>('omd.workspace', 'register', { id: PANEL, title: 'Yazi', site: SITE, show: true }).error
        && (!full || !api.services.call<{ error?: string }>('omd.workspace', 'mode', { level: 'full', target: PANEL }).error);
      if (full && !panel) api.services.call('omd.workspace', 'unregister', { id: PANEL });
    } catch {}
    api.state.set({ running: true, panel, dir: remembered });
    api.host.tryCall('terminal.pane', { action: 'focus', id: ID });
    return { display: panel && !full ? 'yazi started in its workspace tab (Ctrl+] leaves it)' : 'yazi started (Ctrl+] leaves it)' };
  }, { description: 'Run yazi in this session and mention the files you pick; --stop closes it', args_hint: '[path|--stop]' });

  const docked = () => {
    try { return api.services.call<{ panels: { id: string }[] }>('omd.workspace', 'panels', null).panels.some(item => item.id === PANEL); } catch { return false; }
  };

  api.on('terminal', ({ client }): TerminalPatch | null => {
    const { running, panel } = load();
    if (!running) return api.settings.placement === 'panel' && docked() ? { sites: { [SITE]: { components: [{ type: 'text', id: `${ID}_idle`, label: 'yazi', text: IDLE }] } } } : null;
    const sites = { [SITE]: { components: [{ type: 'terminal' as const, id: ID, label: 'yazi', session: SESSION, autofocus: true }] } };
    if (panel && docked()) return { sites };
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
    const read = api.host.tryCall('terminal.pty', { action: 'read', session: SESSION });
    if (read.ok && 'running' in read.value && read.value.running) return;
    const last = read.ok && 'text' in read.value ? lastLine(read.value.text) : '';
    finish(event.files);
    if (event.exit_code) api.host.tryCall('terminal.notice', { text: `yazi exited with ${event.exit_code}${last ? `: ${last}` : ''}`, kind: 'warning' });
  });
}
