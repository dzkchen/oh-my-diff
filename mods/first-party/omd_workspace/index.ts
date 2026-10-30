import type { CommandResult, Json, KeyAction, KeyContext, LayoutNode, ModAPI, TerminalComponent, TerminalPatch } from '../../api.d.ts';
import { CHILDREN, ID, PANELS, REGISTERED, WAYS, at, clone, failed, groupsOf, insert, kids, leaves, locate, mirror, move, obj, orient, parseNode, place, problem, prune, set, signature, swap } from './tree.ts';
import type { Edge, Failure, Group, Node } from './tree.ts';

type Tab = { title: string; site: string };
type Place = { beside: string; edge: Edge; share?: number };
type Run = { argv: string[]; write: boolean; network: boolean };
type Panel = { id: string; title: string; site: string; tabs?: Tab[]; order?: number; placement?: Place; run?: Run };
type Preset = typeof PRESETS[number];
type Arranged = { by: 'user' | 'mod'; preset?: Preset; tree?: Node };
type File = { path: string; code: string };
type Changes = { files: File[]; total: number; selected: string | null; diff: string; error: string | null };
type Thread = { sessions?: string[]; changes?: Changes };
type Level = 'normal' | 'half' | 'full';
type Border = 'rounded' | 'plain' | 'double' | 'thick';
type State = {
  off: boolean; registered: Panel[]; arranged: Arranged | null; saved: Record<string, Node>; ratios: Record<string, number[]>;
  recent: string[]; tabs: Record<string, number>; mode: { target: string; level: Exclude<Level, 'normal'> } | null; threads: Record<string, Thread>;
};
type Bind = { rank: number; panel?: Panel; key: string; action: KeyAction; label: string };

const BUILTIN: Panel[] = [
  { id: 'changes', title: 'Changes', site: 'omd_workspace/changes' },
  { id: 'terminal', title: 'Shell', site: 'omd_workspace/terminal' },
];
const PRESETS = ['dock', 'stack', 'columns', 'grid', 'corner'] as const;
const EDGES: Edge[] = ['left', 'right', 'top', 'bottom', 'tab'];
const LEVELS: Level[] = ['normal', 'half', 'full'];
const REGIONS = [['left', 'Panel on the left'], ['right', 'Panel on the right'], ['up', 'Panel above'], ['down', 'Panel below']] as const;
const KEYS: Record<string, string> = {
  ...Object.fromEntries(Array.from({ length: PANELS }, (_, index) => [`panel_${index + 1}`, String(index + 1)])),
  main: '0', left: 'Left', left_alt: 'h', right: 'Right', right_alt: 'l', up: 'Up', up_alt: 'k', down: 'Down', down_alt: 'j', help: '?',
  mode_next: '+', mode_previous: '_', tab_previous: '[', tab_next: ']', panel_tab_previous: '{', panel_tab_next: '}',
  grow: '=', shrink: '-', focus_shell: 'Enter',
};
const KEY = /^(?:[\x21-\x7e]|F(?:[2-9]|1[0-2])|(?:Ctrl\+(?![cdzhijm]$)|Alt\+|Ctrl\+Alt\+)[a-z0-9]|(?:Ctrl\+|Alt\+|Shift\+)?(?:Up|Down|Left|Right|Home|End|PageUp|PageDown|Delete|Insert|Tab|Enter|Backspace|Space))$/;
const SITE = /^[a-z][a-z0-9_]{0,23}\/[a-z0-9_-]{1,48}$/;
const DISABLED = '<disabled>';
const CELLS = 10;
const BINDINGS = 32;
const STEP = 5;
const TITLE = 30;
const THREADS = 6;
const SAVED = 8;
const RATIOS = 32;
const RECENT = 16;
const COMMANDS = 6;
const ARGS = 64;
const ARGV_BYTES = 8_192;
const STATE_BYTES = 120_000;
const FILES = 50;
const CLIP = 30_000;
const BUDGET = 40_000;
const LINES = 1_000;
const PTY_CAP = 'each mod runs at most pty_panes_per_mod terminals (4 unless mod_limits in the store\'s host.json sets 1-16) and all mods 16';
const START = 'omd_workspace_start';
const LIST = 'omd_workspace_changes';
const REFRESH = 'omd_workspace_refresh';
const SHELL = 'omd_workspace_shell';
const EXAMPLE = {
  layout: 'corner', panels: 'changes, terminal, snake', side: 'left', dock_size: 25, narrow_below: 90, border: 'plain', key_main: 'm',
  shell_write: true, terminals: [{ id: 'snake', title: 'Snake', argv: ['node', 'demo/snake.mjs'] }],
};
const encoder = new TextEncoder();

const str = (value: unknown, bytes: number): string | null => (typeof value === 'string' && value && !/[\u0000-\u001f\u007f-\u009f]/.test(value) && encoder.encode(value).length <= bytes ? value : null);
const sitesOf = (panel: Panel) => panel.tabs?.map(tab => tab.site) ?? [panel.site];
const size = (value: unknown) => encoder.encode(JSON.stringify(value)).length;
const own = <T>(record: Record<string, T>, key: string): T | undefined => (Object.hasOwn(record, key) ? record[key] : undefined);
const clamp = (percent: number) => Math.min(85, Math.max(15, percent));
const leaf = (name: string, title: string, border: Border): LayoutNode => ({ content: `site:${name}` as `site:${string}/${string}`, title, style: { border } });
const clip = (text: string, limit: number) => {
  const kept: string[] = [];
  let used = 0;
  for (const line of text.split('\n')) {
    used += size(line);
    if (used > limit || kept.length >= LINES) break;
    kept.push(line);
  }
  return kept.join('\n');
};

export default function activate(api: ModAPI) {
  const load = (): State => {
    const stored = obj(api.state.get());
    const empty: State = { off: false, registered: [], arranged: null, saved: {}, ratios: {}, recent: [], tabs: {}, mode: null, threads: {} };
    return Object.fromEntries(Object.entries(empty).map(([key, value]) => [key, own(stored, key) ?? value])) as State;
  };
  const save = (state: State) => api.state.set(state as unknown as Json);
  const changed = <T>(change: (state: State) => T): T => {
    const state = load();
    const before = JSON.stringify(state);
    const result = change(state);
    if (JSON.stringify(state) !== before) save(state);
    return result;
  };
  const touch = (state: State, thread: string, patch: Thread) => {
    const next = { ...state.threads[thread], ...patch };
    delete state.threads[thread];
    state.threads[thread] = next;
    for (const old of Object.keys(state.threads).slice(0, -THREADS)) delete state.threads[old];
    for (const old of Object.keys(state.threads).slice(0, -1)) {
      if (size(state) <= STATE_BYTES) break;
      delete state.threads[old];
    }
  };

  const keymap = () => {
    const keys: Record<string, string | null> = { ...KEYS };
    const invalid: string[] = [];
    for (const action of Object.keys(KEYS)) {
      const key = api.settings[`key_${action}`];
      if (key === undefined || key === null || key === '') continue;
      if (key === DISABLED) keys[action] = null;
      else if (typeof key === 'string' && KEY.test(key)) keys[action] = key;
      else invalid.push(`key_${action}: invalid key ${JSON.stringify(key)}`);
    }
    return { keys, invalid };
  };
  const { keys, invalid } = keymap();
  const { settings } = api;
  const right = settings.side !== 'left';
  const layoutSetting = (PRESETS as readonly string[]).includes(settings.layout as string) ? settings.layout as Preset : 'dock';
  const narrowBelow = settings.narrow_below as number;
  const border = settings.border as Border;
  const base = clamp(Math.round(settings.dock_size as number));
  const order = (settings.panels as string).split(/[\s,]+/).filter(Boolean);
  const shellWrite = settings.shell_write === true;
  const shellNetwork = settings.shell_network === 'loopback';
  const configured = Object.keys(obj(settings.arrangement)).length ? parseNode(settings.arrangement) : null;
  const settled = configured && !failed(configured) ? configured : null;
  const unusable = configured && failed(configured) ? configured.error : null;
  const ignored = [...invalid, ...(unusable ? [`arrangement: ${unusable}`] : [])];
  const commands: Panel[] = [];
  for (const [index, raw] of (Array.isArray(settings.terminals) ? settings.terminals : []).entries()) {
    const entry = obj(raw);
    const id = str(entry.id, 24);
    const title = str(entry.title, TITLE);
    const argv = Array.isArray(entry.argv) ? entry.argv : [];
    const runnable = typeof argv[0] === 'string' && argv[0] !== '' && argv.length <= ARGS + 1 && argv.every(arg => typeof arg === 'string' && !arg.includes('\0'))
      && encoder.encode(argv.slice(1).join('')).length <= ARGV_BYTES;
    const taken = !id || !ID.test(id) || ['chat', 'dock'].includes(id) || [...BUILTIN, ...commands].some(panel => panel.id === id);
    if (taken || !title || !runnable || commands.length >= COMMANDS) {
      ignored.push(`terminals[${index}]: needs a new id, a title of at most ${TITLE} bytes and argv (a program and up to ${ARGS} arguments of ${ARGV_BYTES} bytes in all); at most ${COMMANDS} terminals`);
      continue;
    }
    commands.push({ id, title, site: `omd_workspace/run_${id}`, run: { argv: argv as string[], write: entry.write === true, network: entry.network === 'loopback' } });
  }
  const pty = (panel: Panel) => (panel.id === 'terminal'
    ? { session: 'shell', component: SHELL, start: START, args: 'start' }
    : panel.run ? { session: `run_${panel.id}`, component: `omd_workspace_run_${panel.id}`, start: `omd_workspace_start_${panel.id}`, args: `start ${panel.id}` } : null);

  const shadowed = (state: State, hidden: boolean) => state.registered.filter(panel => commands.some(command => command.id === panel.id) === hidden);
  const presetOf = (state: State): Preset | null => (state.arranged ? state.arranged.preset ?? null : settled ? null : layoutSetting);
  const panels = (state: State): Panel[] => {
    const known = [...BUILTIN, ...commands, ...shadowed(state, false).sort((a, b) => (a.order ?? 100) - (b.order ?? 100))];
    const wanted = order.length ? [...new Set(order)].flatMap(id => known.filter(panel => panel.id === id)) : known;
    let cells = 0;
    const fits = (panel: Panel) => {
      const count = panel.tabs?.length ?? 1;
      if (cells + count > CELLS) return false;
      cells += count;
      return true;
    };
    return wanted.filter(fits).slice(0, PANELS);
  };
  const preset = (name: Preset, ids: string[]): Node => {
    if (!ids.length) return 'chat';
    const [first, second, ...more] = ids;
    const group = (list: string[]): Node => (list.length === 1 ? list[0] : { tabs: list });
    const wide = { split: 'horizontal' as const, ratio: [100 - base, base] };
    const shapes: Record<Preset, () => Node> = {
      dock: () => ({ ...wide, children: ['chat', { tabs: ids }] }),
      stack: () => ({ ...wide, children: ['chat', ids.length === 1 ? first : { split: 'vertical', children: ids.length <= CHILDREN ? ids : [...ids.slice(0, 3), group(ids.slice(3))] }] }),
      columns: () => ({ split: 'horizontal', children: ['chat', ...(ids.length <= 3 ? ids : [first, second, group(ids.slice(2))])] }),
      grid: () => (ids.length === 1 ? { ...wide, children: ['chat', first] } : {
        split: 'vertical', children: [{ split: 'horizontal', children: ['chat', first] }, more.length ? { split: 'horizontal', children: [second, group(more)] } : second],
      }),
      corner: () => {
        const left: Node = { split: 'vertical', ratio: [65, 35], children: ['chat', first] };
        return ids.length === 1 ? left : { split: 'horizontal', ratio: [55, 45], children: [left, group(ids.slice(1))] };
      },
    };
    return right ? shapes[name]() : mirror(shapes[name]());
  };
  const fallback = (tree: Node, panel: Panel): Node => {
    const open = groupsOf(tree).find(group => group.tabs.length < PANELS);
    if (open) {
      open.tabs.push(panel.id);
      return tree;
    }
    const last = leaves(tree).filter(name => name !== 'chat').at(-1);
    if (!last) return { split: 'horizontal', ratio: right ? [100 - base, base] : [base, 100 - base], children: right ? [tree, panel.id] : [panel.id, tree] };
    const path = locate(tree, last) as number[];
    const outer = path.length ? at(tree, path.slice(0, -1)) : null;
    const room = outer && typeof outer === 'object' && 'split' in outer && outer.children.length < CHILDREN;
    const placed = insert(tree, panel.id, last, room ? (outer.split === 'horizontal' ? 'right' : 'bottom') : 'tab');
    return failed(placed) ? tree : placed;
  };
  const arrangement = (state: State, list: Panel[]): Node => {
    const visible = new Set(['chat', ...list.map(panel => panel.id)]);
    const kept = state.arranged?.tree ?? (state.arranged ? null : settled);
    let tree = kept ? prune(clone(kept), id => visible.has(id)) ?? 'chat' : preset(presetOf(state) ?? 'dock', list.filter(panel => !panel.placement).map(panel => panel.id));
    for (const panel of list) {
      if (locate(tree, panel.id)) continue;
      const spot = panel.placement && locate(tree, panel.placement.beside) ? insert(clone(tree), panel.id, panel.placement.beside, panel.placement.edge, panel.placement.share) : null;
      const fits = spot !== null && !failed(spot) && !problem(expand(state, list, spot, false));
      tree = fits ? spot : fallback(clone(tree), panel);
    }
    return tree;
  };
  const shape = (state: State, list: Panel[], rows: number): Node => {
    const tree = arrangement(state, list);
    const { mode } = state;
    const rest = prune(tree, id => id !== 'chat');
    if (!mode || !rest) return tree;
    const chatFirst = leaves(tree)[0] === 'chat';
    const pair = (other: Node, chat: number): Node => ({ split: 'horizontal', ratio: chatFirst ? [chat, 100 - chat] : [100 - chat, chat], children: chatFirst ? ['chat', other] : [other, 'chat'] });
    if (mode.target === 'chat') return mode.level === 'full' ? 'chat' : pair(rest, 75);
    const path = locate(tree, mode.target);
    const holder = path && path.length ? at(tree, path.slice(0, -1)) : null;
    const other = !path ? rest : holder && typeof holder === 'object' && 'tabs' in holder ? holder : mode.target;
    if (mode.level === 'half') return pair(other, 50);
    const compact = Math.min(99, Math.max(1, Math.round(800 / rows)));
    return { split: 'vertical', ratio: [100 - compact, compact], children: [other, 'chat'] };
  };
  const activeOf = (state: State, group: Group) => Math.max(0, group.tabs.findIndex(id => id === state.recent.find(name => group.tabs.includes(name))));
  const ownTab = (state: State, panel: Panel) => Math.min(own(state.tabs, panel.id) ?? 0, (panel.tabs?.length ?? 1) - 1);
  const expand = (state: State, list: Panel[], tree: Node, narrow: boolean): LayoutNode => {
    const byId = new Map(list.map((panel, index) => [panel.id, { panel, title: `${index + 1} ${panel.title}` }]));
    const chat: LayoutNode = { split: 'vertical', ratio: [5, 1], children: [{ content: 'transcript', title: 'Chat' }, { content: 'composer' }] };
    const panelNode = (id: string, title: string): LayoutNode => {
      const { panel } = byId.get(id)!;
      return panel.tabs
        ? { tabs: panel.tabs.map(tab => ({ title: tab.title, node: leaf(tab.site, title, border) })), active: ownTab(state, panel) }
        : leaf(panel.site, title, border);
    };
    const walk = (node: Node, root = false): LayoutNode => {
      if (node === 'chat') return chat;
      if (typeof node === 'string') return panelNode(node, byId.get(node)!.title);
      if ('tabs' in node) return { tabs: node.tabs.map(id => ({ title: byId.get(id)!.title, node: panelNode(id, byId.get(id)!.title) })), active: activeOf(state, node) };
      const stored = root && state.mode ? undefined : state.ratios[signature(node)];
      const ratio = stored?.length === node.children.length ? stored : node.ratio;
      return { split: node.split, ...(ratio ? { ratio } : {}), children: node.children.map(child => walk(child)) };
    };
    return walk(orient(tree, narrow), true);
  };
  const render = (state: State, list: Panel[], columns = 120, rows = 40) => {
    const tree = shape(state, list, rows);
    const narrow = columns < narrowBelow;
    const layout = expand(state, list, tree, narrow);
    const refused = problem(layout);
    if (!refused) return { tree, layout, refused };
    const dock = preset('dock', list.map(panel => panel.id));
    return { tree: dock, layout: expand(state, list, dock, narrow), refused };
  };
  const check = (state: State, tree: Node): string | null => {
    const list = panels(state);
    const visible = new Set(['chat', ...list.map(panel => panel.id)]);
    const kept = prune(clone(tree), id => visible.has(id));
    return kept ? problem(expand(state, list, kept, false)) : null;
  };
  const commit = (state: State, tree: Node | Failure, by: 'user' | 'mod' = 'user'): string | null => {
    if (failed(tree)) return tree.error;
    const parsed = parseNode(tree);
    if (failed(parsed)) return parsed.error;
    const refused = check(state, parsed);
    if (refused) return refused;
    state.arranged = { by, tree: parsed };
    state.mode = null;
    return null;
  };
  const front = (state: State, id: string) => {
    state.recent = [id, ...state.recent.filter(name => name !== id)].slice(0, RECENT);
  };
  const locateEvent = (tree: Node, component: string): Node | null => {
    let node: Node | undefined = tree;
    for (const step of component.split('.').slice(1).map(Number)) {
      if (typeof node === 'string') break;
      node = kids(node)[step];
      if (node === undefined) return null;
    }
    return node;
  };

  const contexts = (state: State, tree: Node, all: Panel[], thread?: Thread): KeyContext[] => {
    const list = all.filter(panel => locate(tree, panel.id));
    const picks: Bind[] = [];
    const bind = (rank: number, action: string, run: KeyAction, label: string, panel?: Panel) => {
      const key = keys[action];
      if (key) picks.push({ rank, panel, key, action: run, label });
    };
    const run = (args: string): KeyAction => ({ command: 'workspace', args });
    const grouped = (id: string) => {
      const path = locate(tree, id);
      const holder = path && path.length ? at(tree, path.slice(0, -1)) : null;
      return !!holder && typeof holder === 'object' && 'tabs' in holder;
    };
    all.forEach((panel, index) => {
      if (!list.includes(panel)) return;
      const site = (panel.tabs ? panel.tabs[ownTab(state, panel)].site : panel.site) as `${string}/${string}`;
      bind(1, `panel_${index + 1}`, grouped(panel.id) ? run(`tab ${index + 1}`) : { region: site }, `${grouped(panel.id) ? 'Show' : 'Focus'} ${panel.title}`);
    });
    bind(1, 'main', { region: 'chat' }, 'Main view');
    for (const panel of list) {
      const session = pty(panel);
      if (session && thread?.sessions?.includes(session.session)) bind(2, 'focus_shell', { focus: session.component }, `Type in ${panel.title}`, panel);
      if (panel.tabs) {
        bind(3, 'panel_tab_previous', run(`tab previous ${panel.id}`), `Previous ${panel.title} tab`, panel);
        bind(3, 'panel_tab_next', run(`tab next ${panel.id}`), `Next ${panel.title} tab`, panel);
      }
    }
    for (const [region, label] of REGIONS) bind(4, region, { region }, label);
    bind(4, 'help', { help: true }, 'Show keys');
    if (list.some(panel => grouped(panel.id))) {
      bind(5, 'tab_previous', run('tab previous'), 'Previous tab');
      bind(5, 'tab_next', run('tab next'), 'Next tab');
    }
    for (const group of groupsOf(tree)) {
      const now = activeOf(state, group);
      const panel = all.find(item => item.id === group.tabs[now])!;
      const number = (step: number) => all.findIndex(item => item.id === group.tabs[(now + step + group.tabs.length) % group.tabs.length]) + 1;
      bind(5, 'tab_previous', run(`tab ${number(-1)}`), 'Previous tab', panel);
      bind(5, 'tab_next', run(`tab ${number(1)}`), 'Next tab', panel);
    }
    bind(5, 'grow', run('grow'), 'Grow the panels (or drag their border)');
    bind(5, 'shrink', run('shrink'), 'Shrink the panels (or drag their border)');
    for (const panel of list) {
      bind(6, 'mode_next', run(`mode next ${panel.id}`), 'Next screen mode', panel);
      bind(6, 'mode_previous', run(`mode previous ${panel.id}`), 'Previous screen mode', panel);
    }
    for (const [region, label] of REGIONS) bind(7, `${region}_alt`, { region }, label);
    const kept = picks.map((pick, index) => ({ pick, index })).sort((a, b) => a.pick.rank - b.pick.rank || a.index - b.index).slice(0, BINDINGS).sort((a, b) => a.index - b.index).map(({ pick }) => pick);
    const out: KeyContext[] = [];
    for (const panel of list) {
      const own = Object.fromEntries(kept.filter(pick => pick.panel === panel).map(pick => [pick.key, { action: pick.action, label: pick.label }]));
      if (Object.keys(own).length) out.push({ when: { focus: sitesOf(panel) }, keys: own });
    }
    const general = Object.fromEntries(kept.filter(pick => !pick.panel).map(pick => [pick.key, { action: pick.action, label: pick.label }]));
    return [...out, { when: { focus: 'site' }, keys: general }];
  };

  const git = (...argv: string[]): string | null => {
    const run = api.host.tryCall('exec.run', { program: 'git', argv: ['--no-pager', '--no-optional-locks', ...argv], timeout_ms: 10_000 });
    return run.ok && run.value.exit_code === 0 ? run.value.stdout : null;
  };
  const diffOf = ({ path, code }: File) => {
    const diff = (from: string[]) => api.host.tryCall('exec.run', {
      program: 'git', timeout_ms: 10_000, argv: ['--no-pager', 'diff', '--no-ext-diff', '--no-textconv', '--no-color', ...from, path],
    });
    let run = diff(code === '??' ? ['--no-index', '--', '/dev/null'] : ['HEAD', '--']);
    if (code !== '??' && run.ok && run.value.exit_code !== 0) run = diff(['--cached', '--']);
    return clip(run.ok ? run.value.stdout || run.value.stderr : run.error, CLIP);
  };
  const refresh = (state: State, thread: string) => {
    const prefix = git('rev-parse', '--show-prefix')?.trim();
    const status = prefix === undefined ? null : git('status', '--porcelain=v1', '-z', '--untracked-files=all', '--', '.');
    const files: File[] = [];
    const parts = (status ?? '').split('\0');
    for (let index = 0; index < parts.length; index += 1) {
      const [code, path] = [parts[index].slice(0, 2), parts[index].slice(3).slice(prefix?.length ?? 0)];
      if (parts[index].length > 3 && size(path) <= 200) files.push({ path, code });
      if (/[RC]/.test(code)) index += 1;
    }
    const kept = state.threads[thread]?.changes?.selected;
    const selected = files.find(file => file.path === kept);
    touch(state, thread, { changes: {
      files: files.slice(0, FILES), total: files.length, selected: selected?.path ?? null, diff: selected ? diffOf(selected) : '',
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
  const start = (state: State, thread: string, panel: Panel): string | null => {
    const session = pty(panel)!.session;
    const access = (write: boolean, network: boolean) => ({ ...(write ? { write: true } : {}), ...(network ? { network: 'loopback' as const } : {}) });
    const run = api.host.tryCall('terminal.pty', panel.run
      ? { action: 'start', session, program: panel.run.argv[0], argv: panel.run.argv.slice(1), ...access(panel.run.write, panel.run.network) }
      : { action: 'start', session, ...access(shellWrite, shellNetwork) });
    if (!run.ok) return /pty_session_exists_or_limit/.test(run.error) ? `${panel.title} is already running, or the terminal limit is reached (${PTY_CAP})` : run.error;
    if (!('running' in run.value)) return `${panel.title} start declined`;
    touch(state, thread, { sessions: [...new Set([...(state.threads[thread]?.sessions ?? []), session])] });
    return null;
  };

  const line = (id: string, text: string): TerminalComponent => ({ type: 'line', id: `omd_workspace_${id}_summary`, label: text, spans: [{ text, tone: 'muted' }] });
  const text = (id: string, body: string): TerminalComponent => ({ type: 'text', id: `omd_workspace_${id}_text`, label: body, text: body });
  const button = (id: string, label: string, args: string): TerminalComponent => ({ type: 'button', id, label, text: label, action: { command: 'workspace', args } });
  const ptySite = (panel: Panel, thread?: Thread): TerminalComponent[] => {
    const session = pty(panel)!;
    if (thread?.sessions?.includes(session.session)) return [{ type: 'terminal', id: session.component, label: panel.title, session: session.session }];
    const command = panel.run ? panel.run.argv.join(' ').replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ') : 'a sandboxed shell';
    const what = command.slice(0, encoder.encodeInto(command, new Uint8Array(100)).read);
    return [text(session.session, `Enter starts ${what}.`), button(session.start, `Start ${panel.run ? panel.title : 'shell'}`, session.args)];
  };
  const changesSite = (changes?: Changes): TerminalComponent[] => {
    if (!changes?.files.length) return [text('changes', changes ? changes.error ?? 'Working tree clean' : 'Not loaded yet'), button(REFRESH, 'Refresh', 'refresh')];
    const rows = changes.files.map(({ path, code }) => ({
      value: path, label: path,
      spans: [{ text: `${code.trim()} `, tone: code.includes('D') ? 'failure' as const : code === '??' || code.includes('A') ? 'success' as const : 'attention' as const }, { text: path }],
    }));
    const diff = clip(changes.diff, BUDGET - size(rows));
    return [
      line('changes', `${changes.total} changed${changes.total > rows.length ? `, first ${rows.length}` : ''}`),
      { type: 'list', id: LIST, label: 'Changed files', rows, height: Math.min(rows.length, 10), ...(changes.selected ? { selected: changes.selected } : {}), action: { command: 'workspace', args: 'diff' } },
      ...(changes.selected ? [diff
        ? { type: 'diff' as const, id: 'omd_workspace_diff', label: changes.selected, unified: diff }
        : text('diff', 'No textual diff')] : []),
    ];
  };

  api.on('terminal', ({ ledger, client }): TerminalPatch | null => {
    const state = load();
    if (state.off) return null;
    const list = panels(state);
    const thread = state.threads[ledger?.thread_id ?? ''];
    const { tree, layout } = render(state, list, client?.columns, client?.rows);
    const shown = new Set(leaves(tree));
    const sites: NonNullable<TerminalPatch['sites']> = {};
    for (const panel of list.filter(item => shown.has(item.id))) {
      if (pty(panel)) sites[panel.site as `${string}/${string}`] = { components: ptySite(panel, thread) };
      else if (panel.id === 'changes') sites[panel.site as `${string}/${string}`] = { components: changesSite(thread?.changes) };
    }
    return { layout, sites, ...(list.some(panel => shown.has(panel.id)) ? { key_contexts: contexts(state, tree, list, thread) } : {}) };
  });

  api.on('component_event', event => {
    const thread = event.thread_id ?? '';
    changed(state => {
      if (event.kind === 'focus') {
        const panel = [...BUILTIN, ...commands].find(item => pty(item)?.component === event.component);
        if (event.component === LIST || (event.component === REFRESH && !state.threads[thread]?.changes)) refresh(state, thread);
        else if (panel && state.threads[thread]?.sessions?.includes(pty(panel)!.session)) {
          const { session } = pty(panel)!;
          const read = api.host.tryCall('terminal.pty', { action: 'read', session });
          const gone = read.ok ? 'running' in read.value && !read.value.running : /^pty_(session_unknown|context_changed)/.test(read.error);
          if (gone) touch(state, thread, { sessions: state.threads[thread].sessions!.filter(name => name !== session) });
        }
        return;
      }
      if (!/^r(\.\d)*$/.test(event.component)) return;
      const list = panels(state);
      const { tree } = render(state, list, event.columns, event.rows);
      const node = locateEvent(tree, event.component);
      if (event.kind === 'resize' && event.ratio && !state.mode) {
        if (node === null || typeof node !== 'object' || !('split' in node) || node.children.length !== event.ratio.length) return;
        delete state.ratios[signature(node)];
        state.ratios[signature(node)] = event.ratio;
        for (const old of Object.keys(state.ratios).slice(0, -RATIOS)) delete state.ratios[old];
      } else if (event.kind === 'select' && event.index !== undefined) {
        if (node && typeof node === 'object' && 'tabs' in node && node.tabs[event.index]) front(state, node.tabs[event.index]);
        else if (typeof node === 'string' && list.find(panel => panel.id === node)?.tabs?.[event.index]) state.tabs[node] = event.index;
      } else if (event.kind === 'dock' && event.target && event.edge) {
        const [source, target] = [node, locateEvent(tree, event.target)];
        if (typeof source !== 'string' || source === 'chat' || typeof target !== 'string') return;
        const shown = orient(arrangement(state, list), (event.columns ?? 120) < narrowBelow);
        const refused = commit(state, place(shown, source, target, event.edge === 'center' ? 'tab' : event.edge));
        if (refused) api.host.tryCall('terminal.notice', { text: `Workspace: ${refused}`, kind: 'warning', placement: 'toast' });
      }
    });
  });

  api.on('turn_end', () => changed(state => {
    if (!state.off && panels(state).some(panel => panel.id === 'changes')) refresh(state, api.session().thread_id);
  }));

  const status = (state: State) => {
    const list = panels(state);
    const source = state.arranged ? `${state.arranged.preset ?? 'custom'}, set by ${state.arranged.by === 'mod' ? 'a mod' : 'you'}` : settled ? 'arrangement setting' : layoutSetting;
    const { refused } = render(state, list);
    const notes = [...(refused ? [`Showing dock instead: ${refused}.`] : []), ...(unusable ? [`Arrangement setting ignored: ${unusable}.`] : [])];
    const hints = ([['panel_1', 'shows or focuses the first panel'], ['grow', 'grows'], ['shrink', 'shrinks'], ['main', 'returns to the chat'], ['help', 'lists the keys']] as [string, string][])
      .flatMap(([action, what]) => keys[action] ? [`${keys[action]} ${what}`] : []);
    return [
      `Workspace is ${state.off ? 'off' : 'on'} (${source}). Panels: ${list.map((panel, index) => `${index + 1} ${panel.title}${panel.title.toLowerCase() === panel.id ? '' : ` (${panel.id})`}`).join(', ') || 'none'}. Screen mode: ${state.mode ? `${state.mode.target} ${state.mode.level}` : 'normal'}.`,
      ...notes,
      `Usage: /workspace on | off | layout ${PRESETS.join('|')}|save NAME|load NAME | move PANEL left|right|up|down|tab | swap PANEL PANEL | mode next|previous|normal|half|full [PANEL|dock|chat] | tab N|next|previous [PANEL] | grow | shrink | start [PANEL] | diff PATH | refresh | config | reset`,
      `Ctrl+] from the prompt enters the panels. In them: ${hints.join(', ')}.`,
    ].join('\n');
  };
  const config = (state: State) => {
    const file = api.settingsFile;
    const unknown = [...new Set(order)].filter(id => ![...BUILTIN, ...commands, ...state.registered].some(panel => panel.id === id));
    return [
      `Settings file: ${file.path} (${file.status}${file.error ? `: ${file.error}` : ''})`,
      `Keys: ${JSON.stringify(Object.fromEntries(Object.entries(keys).map(([action, key]) => [`key_${action}`, key ?? DISABLED])))}`,
      `Layout: ${JSON.stringify({ layout: layoutSetting, panels: panels(state).map(panel => panel.id).join(', '), side: right ? 'right' : 'left', dock_size: base, narrow_below: narrowBelow, border })}`,
      `Arrangement: ${JSON.stringify(arrangement(state, panels(state)))}`,
      `Shell: ${shellWrite ? 'writes the workspace' : 'read-only'}, ${shellNetwork ? 'loopback network' : 'no network'}. Terminals: ${commands.map(panel => panel.id).join(', ') || 'none'}. Terminal limit: ${PTY_CAP}.`,
      ...ignored.map(reason => `Ignored: ${reason}`),
      ...unknown.map(id => `Ignored: panels: unknown panel ${id}`),
      ...shadowed(state, true).map(panel => `Ignored: registered panel ${panel.id}: a terminal has that id`),
      `Example file:\n${JSON.stringify(EXAMPLE, null, 2)}`,
    ].join('\n');
  };

  api.command('workspace', (args): CommandResult => {
    const input = String(args ?? '').trim();
    const [op = '', ...words] = input.split(/\s+/);
    const display = changed(state => {
      const thread = () => api.session().thread_id;
      const list = panels(state);
      const current = () => arrangement(state, list);
      const known = (id: string) => id === 'chat' || list.some(panel => panel.id === id);
      const named = (word = '') => (list[Number(word) - 1] ?? list.find(panel => panel.id === word || panel.title.toLowerCase() === word.toLowerCase()))?.id ?? word;
      const resize = (step: number) => {
        state.mode = null;
        const tree = current();
        if (typeof tree !== 'object' || !('split' in tree)) return null;
        const chat = tree.children.findIndex(child => leaves(child).includes('chat'));
        const stored = state.ratios[signature(tree)];
        const ratio = stored?.length === tree.children.length ? stored : tree.ratio ?? tree.children.map(() => 1);
        const total = ratio.reduce((sum, weight) => sum + weight, 0);
        const now = Math.round(100 - ratio[chat] * 100 / total);
        const next = step > 0 ? Math.max(now, Math.min(85, now + step)) : Math.min(now, Math.max(15, now + step));
        const others = total - ratio[chat];
        delete state.ratios[signature(tree)];
        state.ratios[signature(tree)] = ratio.map((weight, index) => (index === chat ? 100 - next : Math.max(1, Math.round(weight * next / others))));
        return null;
      };
      const operations: Record<string, () => string | null> = {
        on: () => { state.off = false; return 'Workspace on'; },
        off: () => { state.off = true; return 'Workspace off'; },
        reset: () => {
          Object.assign(state, { arranged: null, ratios: {}, tabs: {}, recent: [], mode: null });
          return 'Arrangement, sizes, tabs and screen modes reset';
        },
        grow: () => resize(STEP),
        shrink: () => resize(-STEP),
        config: () => config(state),
        start: () => {
          const panel = list.find(item => item.id === named(words[0] ?? 'terminal') && pty(item));
          return panel ? start(state, thread(), panel) ?? `${panel.title} started` : `Usage: /workspace start [${list.filter(item => pty(item)).map(item => item.id).join('|')}]`;
        },
        refresh: () => { refresh(state, thread()); return null; },
        diff: () => choose(state, thread(), input.slice(op.length).trim()),
        layout: () => {
          const [what = '', name = ''] = words;
          if ((PRESETS as readonly string[]).includes(what)) {
            state.arranged = { by: 'user', preset: what as Preset };
            state.mode = null;
            return `Layout: ${what}`;
          }
          if (what === 'save' && ID.test(name)) {
            if (!own(state.saved, name) && Object.keys(state.saved).length >= SAVED) return `At most ${SAVED} saved layouts; /workspace layout delete NAME frees one`;
            state.saved[name] = current();
            return `Saved layout ${name}`;
          }
          const saved = own(state.saved, name);
          if (what === 'load' && saved) return commit(state, saved) ?? `Layout: ${name}`;
          if (what === 'delete' && saved) {
            delete state.saved[name];
            return `Deleted layout ${name}`;
          }
          return `Usage: /workspace layout ${PRESETS.join('|')}|save NAME|load NAME|delete NAME. Saved: ${Object.keys(state.saved).join(', ') || 'none'}`;
        },
        move: () => {
          const [id, way = ''] = [named(words[0]), words[1]];
          if (!known(id) || id === 'chat' || !Object.hasOwn(WAYS, way)) return 'Usage: /workspace move PANEL left|right|up|down|tab';
          return commit(state, move(current(), id, way));
        },
        swap: () => {
          const [first, second] = [named(words[0]), named(words[1])];
          if (!known(first) || !known(second) || first === second) return 'Usage: /workspace swap PANEL PANEL (chat counts as a panel)';
          return commit(state, swap(current(), first, second));
        },
        tab: () => {
          const [direction, word] = words;
          const id = word === undefined ? undefined : named(word);
          const tree = current();
          if (id === undefined && /^\d+$/.test(direction ?? '')) {
            const panel = list[Number(direction) - 1];
            if (!panel) return `Usage: /workspace tab 1-${list.length}|next|previous`;
            front(state, panel.id);
            return null;
          }
          if (id === undefined && (direction === 'next' || direction === 'previous')) {
            const groups = groupsOf(tree);
            const group = groups.find(item => item.tabs.includes(state.recent.find(name => groups.some(other => other.tabs.includes(name))) ?? '')) ?? groups[0];
            if (!group) return 'No panels are in tabs';
            const now = activeOf(state, group);
            front(state, group.tabs[(now + (direction === 'next' ? 1 : group.tabs.length - 1)) % group.tabs.length]);
            return null;
          }
          const panel = list.find(item => item.id === id);
          if (!panel?.tabs || (direction !== 'next' && direction !== 'previous')) return 'Usage: /workspace tab next|previous PANEL (a panel with tabs)';
          state.tabs[panel.id] = (ownTab(state, panel) + (direction === 'next' ? 1 : panel.tabs.length - 1)) % panel.tabs.length;
          return null;
        },
        mode: () => {
          const [action = '', word] = words;
          const target = word === undefined ? state.mode?.target ?? 'chat' : word === 'dock' ? word : named(word);
          if (target !== 'dock' && !known(target)) return `Unknown panel ${target}`;
          const now = LEVELS.indexOf(state.mode?.target === target ? state.mode.level : 'normal');
          const next = action === 'next' ? (now + 1) % 3 : action === 'previous' ? (now + 2) % 3 : LEVELS.indexOf(action as Level);
          if (next < 0) return 'Usage: /workspace mode next|previous|normal|half|full [PANEL|dock|chat]';
          state.mode = next === 0 ? null : { target, level: LEVELS[next] as 'half' | 'full' };
          return `Screen mode: ${target} ${LEVELS[next]}`;
        },
      };
      return Object.hasOwn(operations, op) ? operations[op]() : status(state);
    });
    return display === null ? null : { display };
  }, {
    description: 'Workspace panels: on, off, layout, move, swap, mode, tab, grow, shrink, start, diff, refresh, config, reset',
    args_hint: 'layout|move|swap|mode|tab|start|config|reset|…',
  });

  const refuse = (error: string): Json => ({ error });
  api.provide({
    name: 'omd.workspace', version: '1.2.0',
    methods: {
      register: { input: 'object', output: 'object' }, unregister: { input: 'object', output: 'object' }, panels: { input: 'null', output: 'object' },
      arrange: { input: 'object', output: 'object' }, arrangement: { input: 'object', output: 'object' }, mode: { input: 'object', output: 'object' },
    },
  }, {
    register: input => {
      const raw = obj(input);
      const id = str(raw.id, 24);
      const title = str(raw.title, TITLE);
      const where = str(raw.site, 80);
      if (!id || !ID.test(id) || id === 'chat' || id === 'dock' || [...BUILTIN, ...commands].some(panel => panel.id === id)) return refuse('invalid id');
      if (!title) return refuse('invalid title');
      if (!where || !SITE.test(where)) return refuse('site must be <mod>/<name>');
      const tabs = Array.isArray(raw.tabs) ? raw.tabs.map(item => ({ title: str(obj(item).title, 32), site: str(obj(item).site, 80) })) : undefined;
      if (raw.tabs !== undefined && (!tabs || !tabs.length || tabs.length > 4 || tabs.some(tab => !tab.title || !tab.site || !SITE.test(tab.site)))) return refuse('invalid tabs');
      const spot = obj(raw.placement);
      const share = spot.share;
      if (raw.placement !== undefined && (typeof spot.beside !== 'string' || (spot.beside !== 'chat' && !ID.test(spot.beside)) || spot.beside === id
        || !EDGES.includes(spot.edge as Edge) || (share !== undefined && (typeof share !== 'number' || share < 5 || share > 95)))) {
        return refuse('placement needs beside ("chat" or a panel id), edge (left, right, top, bottom or tab) and an optional share from 5 to 95');
      }
      const placement = raw.placement === undefined ? {} : { placement: { beside: spot.beside as string, edge: spot.edge as Edge, ...(share === undefined ? {} : { share: Math.round(share as number) }) } };
      const panel: Panel = { id, title, site: where, ...(tabs ? { tabs: tabs as Tab[] } : {}), ...(typeof raw.order === 'number' && Number.isFinite(raw.order) ? { order: raw.order } : {}), ...placement };
      return changed(state => {
        const others = state.registered.filter(item => item.id !== id);
        const taken = new Set([...BUILTIN, ...commands, ...others].flatMap(sitesOf));
        if (sitesOf(panel).some((name, index, all) => taken.has(name) || all.indexOf(name) !== index)) return refuse('site in use');
        if (others.length >= REGISTERED) return refuse('too many panels');
        state.registered = others.length < state.registered.length ? state.registered.map(item => item.id === id ? panel : item) : [...others, panel];
        if (raw.show === true) front(state, id);
        return { registered: id };
      });
    },
    unregister: input => changed(state => {
      const kept = state.registered.filter(panel => panel.id !== obj(input).id);
      const removed = kept.length < state.registered.length;
      state.registered = kept;
      if (removed && state.mode?.target === obj(input).id) state.mode = null;
      return { removed };
    }),
    panels: () => ({ panels: panels(load()).map(({ id, title, site: name, tabs, placement }) => ({ id, title, site: name, ...(tabs ? { tabs } : {}), ...(placement ? { placement } : {}) })) as unknown as Json }),
    arrange: input => changed(state => {
      if (state.arranged?.by === 'user' || (!state.arranged && settled)) return refuse('the user arranged the workspace; /workspace reset hands it back');
      const refused = commit(state, parseNode(obj(input).tree), 'mod');
      return refused ? refuse(refused) : { arranged: true };
    }),
    arrangement: () => {
      const state = load();
      const name = presetOf(state);
      return { tree: arrangement(state, panels(state)) as Json, by: state.arranged?.by ?? 'settings', ...(name ? { preset: name } : {}) };
    },
    mode: input => changed(state => {
      const raw = obj(input);
      const level = LEVELS.indexOf(raw.level as Level);
      const target = raw.target ?? 'chat';
      if (state.off) return refuse('the workspace is off');
      if (level < 0) return refuse('level must be normal, half or full');
      if (target !== 'chat' && target !== 'dock' && !panels(state).some(panel => panel.id === target)) return refuse('target must be chat, dock or a shown panel id');
      state.mode = level === 0 ? null : { target: target as string, level: LEVELS[level] as 'half' | 'full' };
      return { mode: state.mode as Json };
    }),
  });
}
