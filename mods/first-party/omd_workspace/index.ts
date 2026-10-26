import type { CommandResult, Json, KeyAction, KeyContext, LayoutNode, ModAPI, TerminalComponent, TerminalPatch } from '../../api.d.ts';

type Tab = { title: string; site: string };
type Panel = { id: string; title: string; site: string; tabs?: Tab[]; order?: number };
type File = { path: string; code: string };
type Changes = { files: File[]; total: number; selected: string | null; diff: string; error: string | null };
type Thread = { shell?: 'tried' | 'started'; changes?: Changes };
type Level = 'normal' | 'half' | 'full';
type State = {
  off: boolean; registered: Panel[]; share: number | null; stack: Record<string, number[]>; tabs: Record<string, number>; dock: string | null;
  mode: { target: string; level: Exclude<Level, 'normal'> } | null; threads: Record<string, Thread>;
};

const BUILTIN: Panel[] = [
  { id: 'changes', title: 'Changes', site: 'omd_workspace/changes' },
  { id: 'terminal', title: 'Shell', site: 'omd_workspace/terminal' },
];
const LEVELS: Level[] = ['normal', 'half', 'full'];
const KEYS: Record<string, string> = {
  ...Object.fromEntries(Array.from({ length: 9 }, (_, index) => [`panel_${index + 1}`, String(index + 1)])),
  main: '0', left: 'Left', left_alt: 'h', right: 'Right', right_alt: 'l', next: 'Tab', help: '?',
  mode_next: '+', mode_previous: '_', tab_previous: '[', tab_next: ']', panel_tab_previous: '{', panel_tab_next: '}',
  grow: '=', shrink: '-', focus_shell: 'Enter',
};
const KEY = /^(?:[\x21-\x7e]|F(?:[2-9]|1[0-2])|(?:Ctrl\+(?![cdzhijm]$)|Alt\+|Ctrl\+Alt\+)[a-z0-9]|(?:Ctrl\+|Alt\+|Shift\+)?(?:Up|Down|Left|Right|Home|End|PageUp|PageDown|Delete|Insert|Tab|Enter|Backspace|Space))$/;
const ID = /^[a-z][a-z0-9_]{0,23}$/;
const SITE = /^[a-z][a-z0-9_]{0,23}\/[a-z0-9_-]{1,48}$/;
const DISABLED = '<disabled>';
const TABS = 6;
const STACK = 4;
const CELLS = 10;
const STEP = 5;
const TITLE = 30;
const THREADS = 6;
const STATE_BYTES = 120_000;
const ROWS = 50;
const REGISTERED = 16;
const CLIP = 30_000;
const LINES = 1_000;
const START = 'omd_workspace_start';
const LIST = 'omd_workspace_changes';
const REFRESH = 'omd_workspace_refresh';
const EXAMPLE = { keybinding: { main: 'm', help: DISABLED, grow: '>' }, layout: { mode: 'tabs', panels: ['terminal', 'changes'], side: 'left', ratio: [1, 3], portrait: 90 } };
const encoder = new TextEncoder();

const obj = (value: unknown): Record<string, Json> => (value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, Json> : {});
const str = (value: unknown, bytes: number): string | null => (typeof value === 'string' && value && !/[\u0000-\u001f\u007f-\u009f]/.test(value) && encoder.encode(value).length <= bytes ? value : null);
const sitesOf = (panel: Panel) => panel.tabs?.map(tab => tab.site) ?? [panel.site];
const leaf = (name: string, title: string): LayoutNode => ({ content: `site:${name}` as `site:${string}/${string}`, title });
const clip = (text: string) => {
  const kept: string[] = [];
  let size = 0;
  for (const line of text.split('\n')) {
    size += encoder.encode(JSON.stringify(line)).length;
    if (size > CLIP || kept.length >= LINES) break;
    kept.push(line);
  }
  return kept.join('\n');
};

export default function activate(api: ModAPI) {
  const settings = { keybinding: obj(api.settings.keybinding), layout: obj(api.settings.layout) };
  const load = (): State => ({ off: false, registered: [], share: null, stack: {}, tabs: {}, dock: null, mode: null, threads: {}, ...(api.state.get() as Partial<State> | null) });
  const save = (state: State) => api.state.set(state as unknown as Json);
  const changed = (change: (state: State) => void) => {
    const state = load();
    const before = JSON.stringify(state);
    change(state);
    if (JSON.stringify(state) !== before) save(state);
  };
  const touch = (state: State, thread: string, patch: Thread) => {
    const next = { ...state.threads[thread], ...patch };
    delete state.threads[thread];
    state.threads[thread] = next;
    for (const old of Object.keys(state.threads).slice(0, -THREADS)) delete state.threads[old];
    for (const old of Object.keys(state.threads).slice(0, -1)) {
      if (encoder.encode(JSON.stringify(state)).length <= STATE_BYTES) break;
      delete state.threads[old];
    }
  };

  const keymap = () => {
    const keys: Record<string, string | null> = { ...KEYS };
    const invalid: string[] = [];
    for (const [action, key] of Object.entries(settings.keybinding)) {
      if (!(action in KEYS)) invalid.push(`${action}: unknown action`);
      else if (key === DISABLED) keys[action] = null;
      else if (typeof key === 'string' && KEY.test(key)) keys[action] = key;
      else invalid.push(`${action}: invalid key ${JSON.stringify(key)}`);
    }
    return { keys, invalid };
  };
  const right = settings.layout.side !== 'left';
  const stacked = settings.layout.mode === 'stack';
  const portrait = typeof settings.layout.portrait === 'number' ? settings.layout.portrait : 84;
  const ratio = Array.isArray(settings.layout.ratio) && settings.layout.ratio.length === 2 && settings.layout.ratio.every(n => typeof n === 'number' && n > 0)
    ? settings.layout.ratio as number[] : [1, 2];
  const base = Math.round(100 * ratio[0] / (ratio[0] + ratio[1]));

  const panels = (state: State): Panel[] => {
    const known = [...BUILTIN, ...[...state.registered].sort((a, b) => (a.order ?? 100) - (b.order ?? 100))];
    const wanted = Array.isArray(settings.layout.panels) ? [...new Set(settings.layout.panels)].flatMap(id => known.filter(panel => panel.id === id)) : known;
    let cells = 0;
    return wanted.filter(panel => (cells += panel.tabs?.length ?? 1) <= CELLS).slice(0, stacked ? STACK : TABS);
  };
  const shown = (state: State, all: Panel[]) => {
    const { mode } = state;
    if (!mode) return all;
    if (mode.target === 'chat') return mode.level === 'full' ? [] : all;
    const only = stacked ? all.filter(panel => panel.id === mode.target) : [];
    return only.length ? only : all;
  };
  const active = (state: State, panel: Panel) => Math.min(state.tabs[panel.id] ?? 0, (panel.tabs?.length ?? 1) - 1);
  const docked = (state: State, list: Panel[]) => Math.max(0, list.findIndex(panel => panel.id === state.dock));
  const full = (state: State) => state.mode?.level === 'full' && state.mode.target !== 'chat' && (!stacked || panels(state).some(panel => panel.id === state.mode?.target));
  const sidePath = (state: State) => `r.${right && !full(state) ? 1 : 0}`;
  const share = (state: State) => (state.mode ? (state.mode.target === 'chat' ? 25 : 50) : state.share ?? base);

  const arrange = (state: State, list: Panel[], columns: number, rows: number): LayoutNode => {
    const chat: LayoutNode = { split: 'vertical', ratio: [5, 1], children: [{ content: 'transcript', title: 'Chat' }, { content: 'composer' }] };
    if (!list.length) return chat;
    const narrow = columns < portrait;
    const node = (panel: Panel, title: string): LayoutNode => panel.tabs
      ? { tabs: panel.tabs.map(tab => ({ title: tab.title, node: leaf(tab.site, title) })), active: active(state, panel) }
      : leaf(panel.site, title);
    const stack = state.stack[list.map(panel => panel.id).join()];
    const side: LayoutNode = !stacked
      ? { tabs: list.map((panel, index) => ({ title: `${index + 1} ${panel.title}`, node: node(panel, '') })), active: docked(state, list) }
      : list.length === 1 ? node(list[0], `1 ${list[0].title}`)
        : { split: narrow ? 'horizontal' : 'vertical', ...(stack?.length === list.length ? { ratio: stack } : {}), children: list.map((panel, index) => node(panel, `${index + 1} ${panel.title}`)) };
    const weights = full(state) ? [Math.max(1, rows - 8), 8] : [share(state), 100 - share(state)];
    const flip = right && !full(state);
    return {
      split: full(state) || narrow ? 'vertical' : 'horizontal',
      ratio: flip ? weights.reverse() : weights,
      children: flip ? [chat, side] : [side, chat],
    };
  };

  const contexts = (list: Panel[], shell: boolean): KeyContext[] => {
    const { keys } = keymap();
    const bind = (into: KeyContext['keys'], action: string, run: KeyAction, label: string) => {
      const key = keys[action];
      if (key) into[key] = { action: run, label };
    };
    const run = (args: string): KeyAction => ({ command: 'workspace', args });
    const general: KeyContext['keys'] = {};
    list.forEach((panel, index) => bind(general, `panel_${index + 1}`, stacked ? { region: index + 1 } : run(`tab ${index + 1}`), `${stacked ? 'Focus' : 'Show'} ${panel.title}`));
    bind(general, 'main', { region: 'chat' }, 'Main view');
    for (const action of ['left', 'left_alt']) bind(general, action, { region: 'left' }, 'Panel on the left');
    for (const action of ['right', 'right_alt']) bind(general, action, { region: 'right' }, 'Panel on the right');
    bind(general, 'next', { region: 'next' }, 'Next panel');
    bind(general, 'help', { help: true }, 'Show keys');
    if (!stacked) {
      bind(general, 'tab_previous', run('tab previous'), 'Previous tab');
      bind(general, 'tab_next', run('tab next'), 'Next tab');
      bind(general, 'mode_next', run('mode next dock'), 'Next screen mode');
      bind(general, 'mode_previous', run('mode previous dock'), 'Previous screen mode');
    }
    bind(general, 'grow', run('grow'), 'Grow the panels (or drag their border)');
    bind(general, 'shrink', run('shrink'), 'Shrink the panels (or drag their border)');
    const out: KeyContext[] = [{ when: { focus: 'site' }, keys: general }];
    for (const panel of list) {
      const own: KeyContext['keys'] = {};
      if (stacked) {
        bind(own, 'mode_next', run(`mode next ${panel.id}`), 'Next screen mode');
        bind(own, 'mode_previous', run(`mode previous ${panel.id}`), 'Previous screen mode');
      }
      if (panel.id === 'terminal' && shell) bind(own, 'focus_shell', { focus: 'omd_workspace_shell' }, 'Type in the shell');
      if (panel.tabs) {
        bind(own, stacked ? 'tab_previous' : 'panel_tab_previous', run(`tab previous ${panel.id}`), `Previous ${panel.title} tab`);
        bind(own, stacked ? 'tab_next' : 'panel_tab_next', run(`tab next ${panel.id}`), `Next ${panel.title} tab`);
      }
      if (Object.keys(own).length) out.push({ when: { focus: sitesOf(panel) }, keys: own });
    }
    return out;
  };

  const git = (...argv: string[]): string | null => {
    const run = api.host.tryCall('exec.run', { program: 'git', argv: ['--no-pager', '--no-optional-locks', ...argv], timeout_ms: 10_000 });
    return run.ok && run.value.exit_code === 0 ? run.value.stdout : null;
  };
  const diffOf = ({ path, code }: File) => {
    const diff = (base: string[]) => api.host.tryCall('exec.run', {
      program: 'git', timeout_ms: 10_000, argv: ['--no-pager', 'diff', '--no-ext-diff', '--no-textconv', '--no-color', ...base, path],
    });
    let run = diff(code === '??' ? ['--no-index', '--', '/dev/null'] : ['HEAD', '--']);
    if (code !== '??' && run.ok && run.value.exit_code !== 0) run = diff(['--cached', '--']);
    return clip(run.ok ? run.value.stdout || run.value.stderr : run.error);
  };
  const refresh = (state: State, thread: string) => {
    const prefix = git('rev-parse', '--show-prefix')?.trim();
    const status = prefix === undefined ? null : git('status', '--porcelain=v1', '-z', '--untracked-files=all', '--', '.');
    const files: File[] = [];
    const parts = (status ?? '').split('\0');
    for (let index = 0; index < parts.length; index += 1) {
      const [code, path] = [parts[index].slice(0, 2), parts[index].slice(3).slice(prefix?.length ?? 0)];
      if (parts[index].length > 3 && encoder.encode(path).length <= 200) files.push({ path, code });
      if (/[RC]/.test(code)) index += 1;
    }
    const kept = state.threads[thread]?.changes?.selected;
    const selected = files.find(file => file.path === kept);
    touch(state, thread, { changes: {
      files: files.slice(0, ROWS), total: files.length, selected: selected?.path ?? null, diff: selected ? diffOf(selected) : '',
      error: status === null ? 'Not a Git repository' : null,
    } });
  };
  const choose = (state: State, thread: string, path: string): string | null => {
    const changes = state.threads[thread]?.changes;
    const file = changes?.files.find(item => item.path === path);
    if (!changes || !file) return `${path} is not in the changes list`;
    touch(state, thread, { changes: { ...changes, selected: path, diff: diffOf(file) } });
    return null;
  };
  const start = (state: State, thread: string): string | null => {
    const run = api.host.tryCall('terminal.pty', { action: 'start', session: 'shell' });
    const ok = run.ok && 'running' in run.value;
    touch(state, thread, { shell: ok ? 'started' : 'tried' });
    return ok ? null : run.ok ? 'Shell start declined' : run.error;
  };

  const line = (id: string, text: string): TerminalComponent => ({ type: 'line', id: `omd_workspace_${id}_summary`, label: text, spans: [{ text, tone: 'muted' }] });
  const text = (id: string, body: string): TerminalComponent => ({ type: 'text', id: `omd_workspace_${id}_text`, label: body, text: body });
  const button = (id: string, label: string, args: string): TerminalComponent => ({ type: 'button', id, label, text: label, action: { command: 'workspace', args } });
  const terminalSite = (thread?: Thread): TerminalComponent[] => thread?.shell === 'started'
    ? [{ type: 'terminal' as const, id: 'omd_workspace_shell', label: 'Shell', session: 'shell' }]
    : [text('terminal', 'Enter starts a sandboxed shell.'), button(START, 'Start shell', 'start')];
  const changesSite = (changes?: Changes): TerminalComponent[] => {
    if (!changes?.files.length) return [text('changes', changes ? changes.error ?? 'Working tree clean' : 'Not loaded yet'), button(REFRESH, 'Refresh', 'refresh')];
    const rows = changes.files.map(({ path, code }) => ({
      value: path, label: path,
      spans: [{ text: `${code.trim()} `, tone: code.includes('D') ? 'failure' as const : code === '??' || code.includes('A') ? 'success' as const : 'attention' as const }, { text: path }],
    }));
    return [
      line('changes', `${changes.total} changed${changes.total > rows.length ? `, first ${rows.length}` : ''}`),
      { type: 'list', id: LIST, label: 'Changed files', rows, height: Math.min(rows.length, 10), ...(changes.selected ? { selected: changes.selected } : {}), action: { command: 'workspace', args: 'diff' } },
      ...(changes.selected ? [changes.diff
        ? { type: 'diff' as const, id: 'omd_workspace_diff', label: changes.selected, unified: changes.diff }
        : text('diff', 'No textual diff')] : []),
    ];
  };

  api.on('terminal', ({ ledger, client }): TerminalPatch | null => {
    const state = load();
    if (state.off) return null;
    const all = panels(state);
    const list = shown(state, all);
    const thread = state.threads[ledger?.thread_id ?? ''];
    const sites: NonNullable<TerminalPatch['sites']> = {};
    if (list.some(panel => panel.id === 'terminal')) sites['omd_workspace/terminal'] = { components: terminalSite(thread) };
    if (list.some(panel => panel.id === 'changes')) sites['omd_workspace/changes'] = { components: changesSite(thread?.changes) };
    return { layout: arrange(state, list, client?.columns ?? 120, client?.rows ?? 40), sites, ...(list.length ? { key_contexts: contexts(list, thread?.shell === 'started') } : {}) };
  });

  api.on('component_event', event => {
    const thread = event.thread_id ?? '';
    changed(state => {
      if (event.kind === 'focus') {
        if (event.component === LIST || event.component === REFRESH) refresh(state, thread);
        return;
      }
      if (!/^r(\.\d)*$/.test(event.component)) return;
      const list = shown(state, panels(state));
      const side = sidePath(state);
      if (event.kind === 'resize' && event.ratio && !state.mode) {
        if (event.component === 'r' && event.ratio.length === 2) state.share = event.ratio[right ? 1 : 0];
        else if (stacked && event.component === side && event.ratio.length === list.length) state.stack[list.map(panel => panel.id).join()] = event.ratio;
      } else if (event.kind === 'select' && event.index !== undefined) {
        if (!stacked && event.component === side) {
          if (list[event.index]) state.dock = list[event.index].id;
          return;
        }
        const panel = !stacked ? list[Number(event.component.slice(side.length + 1))] : list.length === 1 ? list[0] : list[Number(event.component.split('.').pop())];
        if (panel?.tabs?.[event.index]) state.tabs[panel.id] = event.index;
      }
    });
  });

  api.on('turn_end', () => changed(state => {
    if (!state.off && panels(state).some(panel => panel.id === 'changes')) refresh(state, api.session().thread_id);
  }));

  const status = (state: State) => {
    const list = panels(state);
    return [
      `Workspace is ${state.off ? 'off' : 'on'} (${stacked ? 'stack' : 'tabs'}). Panels: ${list.map((panel, index) => `${index + 1} ${panel.title}`).join(', ') || 'none'}. Screen mode: ${state.mode ? `${state.mode.target} ${state.mode.level}` : 'normal'}.`,
      'Usage: /workspace on | off | mode next|previous|normal|half|full [PANEL|dock|chat] | tab N|next|previous [PANEL] | grow | shrink | start | diff PATH | refresh | config | reset',
      `Ctrl+] from the prompt enters the panels. In them ${stacked ? 'a number focuses that panel' : 'a number picks a tab, [ and ] switch tabs'}, = and - resize, 0 returns to the chat and ? lists the keys.`,
    ].join('\n');
  };
  const config = (state: State) => {
    const { keys, invalid } = keymap();
    const file = api.settingsFile;
    return [
      `Settings file: ${file.path} (${file.status}${file.error ? `: ${file.error}` : ''})`,
      `Keys: ${JSON.stringify(Object.fromEntries(Object.entries(keys).map(([action, key]) => [action, key ?? DISABLED])))}`,
      `Layout: ${JSON.stringify({ mode: stacked ? 'stack' : 'tabs', panels: panels(state).map(panel => panel.id), side: right ? 'right' : 'left', ratio, portrait })}`,
      ...invalid.map(problem => `Ignored: ${problem}`),
      `Example file:\n${JSON.stringify(EXAMPLE, null, 2)}`,
    ].join('\n');
  };

  api.command('workspace', (args): CommandResult => {
    const input = String(args ?? '').trim();
    const [op = '', ...words] = input.split(/\s+/);
    const state = load();
    const before = JSON.stringify(state);
    const thread = () => api.session().thread_id;
    const resize = (step: number) => {
      state.share = Math.min(85, Math.max(15, share(state) + step));
      state.mode = null;
      return null;
    };
    const operations: Record<string, () => string | null> = {
      on: () => { state.off = false; return 'Workspace on'; },
      off: () => { state.off = true; return 'Workspace off'; },
      reset: () => { state.share = null; state.stack = {}; state.tabs = {}; state.dock = null; state.mode = null; return 'Sizes, tabs and screen modes reset'; },
      grow: () => resize(STEP),
      shrink: () => resize(-STEP),
      config: () => config(state),
      start: () => start(state, thread()) ?? 'Shell started',
      refresh: () => { refresh(state, thread()); return null; },
      diff: () => choose(state, thread(), input.slice(op.length).trim()),
      tab: () => {
        const [direction, id] = words;
        const list = panels(state);
        if (!stacked && id === undefined && list.length) {
          const at = docked(state, list);
          const index = direction === 'next' ? (at + 1) % list.length : direction === 'previous' ? (at + list.length - 1) % list.length : Number(direction) - 1;
          if (!list[index]) return `Usage: /workspace tab 1-${list.length}|next|previous`;
          state.dock = list[index].id;
          return null;
        }
        const panel = list.find(item => item.id === id);
        if (!panel?.tabs || (direction !== 'next' && direction !== 'previous')) return 'Usage: /workspace tab next|previous PANEL (a panel with tabs)';
        state.tabs[panel.id] = (active(state, panel) + (direction === 'next' ? 1 : panel.tabs.length - 1)) % panel.tabs.length;
        return null;
      },
      mode: () => {
        const [action = '', target = state.mode?.target ?? 'chat'] = words;
        if (target !== 'chat' && (target !== 'dock' || stacked) && !panels(state).some(panel => panel.id === target)) return `Unknown panel ${target}`;
        const at = LEVELS.indexOf(state.mode?.target === target ? state.mode.level : 'normal');
        const next = action === 'next' ? (at + 1) % 3 : action === 'previous' ? (at + 2) % 3 : LEVELS.indexOf(action as Level);
        if (next < 0) return 'Usage: /workspace mode next|previous|normal|half|full [PANEL|dock|chat]';
        state.mode = next === 0 ? null : { target, level: LEVELS[next] as 'half' | 'full' };
        return `Screen mode: ${target} ${LEVELS[next]}`;
      },
    };
    const display = operations[op] ? operations[op]() : status(state);
    if (JSON.stringify(state) !== before) save(state);
    return display === null ? null : { display };
  }, { description: 'Workspace panels: on, off, mode, tab, grow, shrink, start, diff, refresh, config, reset', args_hint: 'on|off|mode|tab|grow|shrink|start|diff|refresh|config|reset' });

  const refuse = (error: string): Json => ({ error });
  api.provide({
    name: 'omd.workspace', version: '1.0.0',
    methods: { register: { input: 'object', output: 'object' }, unregister: { input: 'object', output: 'object' }, panels: { input: 'null', output: 'object' } },
  }, {
    register: input => {
      const raw = obj(input);
      const id = str(raw.id, 24);
      const title = str(raw.title, TITLE);
      const where = str(raw.site, 80);
      if (!id || !ID.test(id) || id === 'chat' || id === 'dock' || BUILTIN.some(panel => panel.id === id)) return refuse('invalid id');
      if (!title) return refuse('invalid title');
      if (!where || !SITE.test(where)) return refuse('site must be <mod>/<name>');
      const tabs = Array.isArray(raw.tabs) ? raw.tabs.map(item => ({ title: str(obj(item).title, 32), site: str(obj(item).site, 80) })) : undefined;
      if (raw.tabs !== undefined && (!tabs || !tabs.length || tabs.length > 4 || tabs.some(tab => !tab.title || !tab.site || !SITE.test(tab.site)))) return refuse('invalid tabs');
      const panel: Panel = { id, title, site: where, ...(tabs ? { tabs: tabs as Tab[] } : {}), ...(typeof raw.order === 'number' && Number.isFinite(raw.order) ? { order: raw.order } : {}) };
      const state = load();
      const others = state.registered.filter(item => item.id !== id);
      const taken = new Set([...BUILTIN, ...others].flatMap(sitesOf));
      if (sitesOf(panel).some((name, index, all) => taken.has(name) || all.indexOf(name) !== index)) return refuse('site in use');
      if (others.length >= REGISTERED) return refuse('too many panels');
      state.registered = [...others, panel];
      save(state);
      return { registered: id };
    },
    unregister: input => {
      const state = load();
      const id = obj(input).id;
      const removed = state.registered.some(panel => panel.id === id);
      if (removed) save({ ...state, registered: state.registered.filter(panel => panel.id !== id) });
      return { removed };
    },
    panels: () => ({ panels: panels(load()).map(({ id, title, site: name, tabs }) => ({ id, title, site: name, ...(tabs ? { tabs } : {}) })) as unknown as Json }),
  });
}
