import type { CommandResult, ModAPI, TerminalPatch } from '../../api.d.ts';

type State = { running: boolean; panel: boolean };

const SESSION = 'lazygit';
const SITE = 'omd_lazygit/main';
const ID = 'omd_lazygit_terminal';
const PANEL = 'lazygit';
const EDIT = 'omd-edit:';
const HINT = 'Install it: https://github.com/jesseduffield/lazygit#installation (Homebrew: brew install lazygit).';
const tell = (path: string, suffix: string, args: string) => `f=${path}; case "$f" in /*) ;; *) f="$PWD/$f";; esac; printf '\\033]9;${EDIT}%s:${suffix}\\007' "$f"${args} > /dev/tty`;
const CONFIG = JSON.stringify({ os: { edit: tell('{{filename}}', '', ''), editAtLine: tell('{{filename}}', '%s', ' {{line}}'), openDirInEditor: tell('{{dir}}', '', ''), editInTerminal: false } });
const IDLE = 'lazygit is not running in this thread; /lazygit starts it.';
const plain = (path: string) => path.split('/').every(part => part !== '' && part !== '.' && part !== '..');
const mention = (path: string) => (/[\s\x22]|\W$/.test(path) ? `@${JSON.stringify(path)}` : `@${path}`);
const lastLine = (text: string) => text.split('\n').map(line => line.trim()).filter(Boolean).pop()?.slice(0, 200) ?? '';

export default function activate(api: ModAPI) {
  const { settings } = api;
  const load = (): State => ({ running: false, panel: false, ...(api.state.get() as Partial<State> | null) });
  const close = () => {
    api.host.tryCall('terminal.pty', { action: 'stop', session: SESSION });
    if (load().panel) {
      try { api.services.call('omd.workspace', 'unregister', { id: PANEL }); } catch {}
    }
    api.state.set({ running: false, panel: false });
  };

  const edit = (text: string) => {
    const split = text.lastIndexOf(':');
    const file = text.slice(0, split);
    const line = Number(text.slice(split + 1));
    const root = `${api.session().root}/`;
    if (!file.startsWith(root) || !plain(file.slice(root.length))) {
      api.host.tryCall('terminal.notice', { text: `${file} is outside this session`, kind: 'warning' });
      return;
    }
    const path = file.slice(root.length);
    if (settings.edit !== 'composer') {
      const opened = api.host.tryCall('terminal.open', { path, editor: true, ...(line > 0 ? { line } : {}) });
      if (opened.ok) return;
      const why = opened.error.includes('terminal_open_editor_unconfigured') ? 'set editor in host.json or edit: composer in the mod settings' : opened.error;
      api.host.tryCall('terminal.notice', { text: `Could not open ${path} in an editor (${why}). Mentioning it instead.`, kind: 'warning' });
    }
    const { revision } = api.host.call('composer.read', null);
    api.host.call('composer.write', { revision, edit: { kind: 'insert', text: `${mention(path)} ` } });
  };

  api.command('lazygit', (args): CommandResult => {
    const given = String(args ?? '').trim();
    if (given === '--stop' || given === 'stop') {
      if (!load().running) return { display: 'lazygit is not running' };
      close();
      return { display: 'lazygit stopped' };
    }
    if (load().running) {
      const read = api.host.tryCall('terminal.pty', { action: 'read', session: SESSION });
      if (read.ok && 'running' in read.value && read.value.running) {
        api.host.tryCall('terminal.pane', { action: 'focus', id: ID });
        return { display: 'lazygit is running' };
      }
      close();
    }
    const { cwd } = api.session();
    const path = given.startsWith('/') ? given : given ? `${cwd}/${given}` : cwd;
    const dir = api.host.tryCall('exec.run', { program: 'lazygit', argv: ['-cd'], sandbox: 'none', timeout_ms: 5000 });
    if (!dir.ok) return { display: dir.error.startsWith('exec_program_declined') ? 'lazygit start declined' : dir.error.includes('program_unavailable') ? `Cannot run lazygit. ${HINT}` : `lazygit did not start: ${dir.error}` };
    const config = dir.value.exit_code === 0 && dir.value.stdout.trim() ? `${dir.value.stdout.trim()}/config.yml` : null;
    const exists = config ? api.host.tryCall('exec.run', { program: '/bin/test', argv: ['-f', config], timeout_ms: 5000 }) : null;
    const userConfig = exists?.ok && exists.value.exit_code === 0 ? `${config},` : '';
    const started = api.host.tryCall('terminal.pty', {
      action: 'start', session: SESSION, program: 'lazygit', cwd: path, sandbox: 'none',
      argv: ['-p', path, '--use-config-file', `${userConfig}{dir}/omd.yml`], files: { 'omd.yml': CONFIG },
    });
    if (!started.ok) return { display: started.error.includes('program_unavailable') ? `Cannot run lazygit. ${HINT}` : started.error.includes('pty_cwd_invalid') ? `No such directory: ${path}` : `lazygit did not start: ${started.error}` };
    if (!('running' in started.value)) return { display: 'lazygit start declined' };
    const full = settings.placement === 'full';
    let panel = false;
    try {
      panel = !api.services.call<{ error?: string }>('omd.workspace', 'register', { id: PANEL, title: 'Lazygit', site: SITE, show: true }).error
        && (!full || !api.services.call<{ error?: string }>('omd.workspace', 'mode', { level: 'full', target: PANEL }).error);
      if (full && !panel) api.services.call('omd.workspace', 'unregister', { id: PANEL });
    } catch {}
    api.state.set({ running: true, panel });
    api.host.tryCall('terminal.pane', { action: 'focus', id: ID });
    return { display: panel && !full && docked() ? 'lazygit started in its workspace tab (Ctrl+] leaves it)' : 'lazygit started (Ctrl+] leaves it)' };
  }, { description: 'Run lazygit in this session; --stop closes it', args_hint: '[path|--stop]' });

  const docked = () => {
    try { return api.services.call<{ panels: { id: string }[] }>('omd.workspace', 'panels', null).panels.some(item => item.id === PANEL); } catch { return false; }
  };

  api.on('terminal', ({ client }): TerminalPatch | null => {
    const { running, panel } = load();
    if (!running) return settings.placement === 'panel' && docked() ? { sites: { [SITE]: { components: [{ type: 'text', id: `${ID}_idle`, label: 'lazygit', text: IDLE }] } } } : null;
    const sites = { [SITE]: { components: [{ type: 'terminal' as const, id: ID, label: 'lazygit', session: SESSION, autofocus: true }] } };
    if (panel && docked()) return { sites };
    const chat = Math.min(99, Math.max(1, Math.round(500 / (client?.rows ?? 40))));
    return {
      sites,
      layout: { split: 'vertical', ratio: [100 - chat, chat], children: [
        { content: 'site:omd_lazygit/main', title: '', style: { border: 'none', padding: 0 } },
        { split: 'vertical', ratio: [2, 3], children: [{ content: 'transcript' }, { content: 'composer' }] },
      ] },
    };
  });

  api.on('component_event', event => {
    if (event.component !== ID) return;
    if (event.kind === 'exit') {
      const read = api.host.tryCall('terminal.pty', { action: 'read', session: SESSION });
      if (read.ok && 'running' in read.value && read.value.running) return;
      const last = read.ok && 'text' in read.value ? lastLine(read.value.text) : '';
      close();
      if (event.exit_code) api.host.tryCall('terminal.notice', { text: `lazygit exited with ${event.exit_code}${last ? `: ${last}` : ''}`, kind: 'warning' });
    }
    else if (event.kind === 'notify' && event.text?.startsWith(EDIT)) edit(event.text.slice(EDIT.length));
  });
}
