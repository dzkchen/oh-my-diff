import type { CommandResult, Json, KeyAction, KeyContext, LayoutNode, ModAPI, TerminalComponent, TerminalPatch } from '../../api.d.ts';

type Tab = { title: string; site: string };
type Edge = 'left' | 'right' | 'top' | 'bottom' | 'tab';
type Place = { beside: string; edge: Edge; share?: number };
type Run = { argv: string[]; write: boolean; network: boolean };
type Panel = { id: string; title: string; site: string; tabs?: Tab[]; order?: number; placement?: Place; run?: Run };
type Split = 'horizontal' | 'vertical';
type Group = { tabs: string[] };
type Fork = { split: Split; ratio?: number[]; children: Node[] };
type Node = string | Fork | Group;
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
const WAYS: Record<string, Edge> = { left: 'left', right: 'right', up: 'top', down: 'bottom', tab: 'tab' };
const LEVELS: Level[] = ['normal', 'half', 'full'];
const REGIONS = [['left', 'Panel on the left'], ['right', 'Panel on the right'], ['up', 'Panel above'], ['down', 'Panel below']] as const;
const TABS = 6;
const KEYS: Record<string, string> = {
  ...Object.fromEntries(Array.from({ length: TABS }, (_, index) => [`panel_${index + 1}`, String(index + 1)])),
  main: '0', left: 'Left', left_alt: 'h', right: 'Right', right_alt: 'l', up: 'Up', up_alt: 'k', down: 'Down', down_alt: 'j', help: '?',
  mode_next: '+', mode_previous: '_', tab_previous: '[', tab_next: ']', panel_tab_previous: '{', panel_tab_next: '}',
  grow: '=', shrink: '-', focus_shell: 'Enter',
};
const KEY = /^(?:[\x21-\x7e]|F(?:[2-9]|1[0-2])|(?:Ctrl\+(?![cdzhijm]$)|Alt\+|Ctrl\+Alt\+)[a-z0-9]|(?:Ctrl\+|Alt\+|Shift\+)?(?:Up|Down|Left|Right|Home|End|PageUp|PageDown|Delete|Insert|Tab|Enter|Backspace|Space))$/;
const ID = /^[a-z][a-z0-9_]{0,23}$/;
const SITE = /^[a-z][a-z0-9_]{0,23}\/[a-z0-9_-]{1,48}$/;
const DISABLED = '<disabled>';
const CHILDREN = 4;
const DEPTH = 6;
const LEAVES = 12;
const CELLS = 10;
const BINDINGS = 32;
const STEP = 5;
const TITLE = 30;
const THREADS = 6;
const SAVED = 8;
const RATIOS = 32;
const RECENT = 16;
const COMMANDS = 6;
const STATE_BYTES = 120_000;
const ROWS = 50;
const REGISTERED = 16;
const CLIP = 30_000;
const BUDGET = 40_000;
const LINES = 1_000;
const PTY_CAP = 'each mod runs at most pty_panes_per_mod PTYs (4 unless mod_limits in the store\'s host.json sets 1-16) and all mods 16';
const START = 'omd_workspace_start';
const LIST = 'omd_workspace_changes';
const REFRESH = 'omd_workspace_refresh';
const SHELL = 'omd_workspace_shell';
const EXAMPLE = {
  layout: 'corner', panels: 'terminal, changes', side: 'left', dock_size: 25, narrow_below: 90, border: 'plain', key_main: 'm', key_help: DISABLED,
  shell_write: true, terminals: [{ id: 'snake', title: 'Snake', argv: ['node', 'demo/snake.mjs'] }],
};
const encoder = new TextEncoder();

const obj = (value: unknown): Record<string, Json> => (value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, Json> : {});
const str = (value: unknown, bytes: number): string | null => (typeof value === 'string' && value && !/[\u0000-\u001f\u007f-\u009f]/.test(value) && encoder.encode(value).length <= bytes ? value : null);
const sitesOf = (panel: Panel) => panel.tabs?.map(tab => tab.site) ?? [panel.site];
const size = (value: unknown) => encoder.encode(JSON.stringify(value)).length;
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

const kids = (node: Node): Node[] => (typeof node === 'string' ? [] : 'tabs' in node ? node.tabs : node.children);
const leaves = (node: Node): string[] => (typeof node === 'string' ? [node] : kids(node).flatMap(leaves));
const signature = (node: Fork) => node.children.map(child => leaves(child).sort().join(',')).join('|');
const at = (root: Node, path: number[]): Node => path.reduce((node, index) => kids(node)[index], root);
const set = (root: Node, path: number[], node: Node): Node => {
  if (!path.length) return node;
  kids(at(root, path.slice(0, -1)))[path[path.length - 1]] = node;
  return root;
};
const locate = (node: Node, id: string, path: number[] = []): number[] | null => {
  if (node === id) return path;
  for (const [index, child] of kids(node).entries()) {
    const found = locate(child, id, [...path, index]);
    if (found) return found;
  }
  return null;
};
const clone = (node: Node): Node => JSON.parse(JSON.stringify(node)) as Node;
const failed = (value: Node | string): value is string => typeof value === 'string' && value.includes(' ');
const mirror = (node: Node): Node => {
  if (typeof node === 'string' || 'tabs' in node) return node;
  const children = node.children.map(mirror);
  return node.split === 'horizontal'
    ? { split: node.split, ...(node.ratio ? { ratio: [...node.ratio].reverse() } : {}), children: children.reverse() }
    : { ...node, children };
};
const prune = (node: Node, keep: (id: string) => boolean): Node | null => {
  if (typeof node === 'string') return keep(node) ? node : null;
  if ('tabs' in node) {
    const tabs = node.tabs.filter(keep);
    return tabs.length ? { tabs } : null;
  }
  const children = node.children.map(child => prune(child, keep)).filter((child): child is Node => child !== null);
  if (children.length <= 1) return children[0] ?? null;
  return { split: node.split, ...(node.ratio && children.length === node.children.length ? { ratio: node.ratio } : {}), children };
};
const tidy = (node: Node): Node | null => {
  if (typeof node === 'string') return node;
  if ('tabs' in node) return node.tabs.length ? node : null;
  const children = node.children.map(tidy).filter((child): child is Node => child !== null);
  const flat = children.flatMap(child => (typeof child === 'object' && 'split' in child && child.split === node.split ? child.children : [child]));
  const list = flat.length <= CHILDREN ? flat : children;
  if (list.length <= 1) return list[0] ?? null;
  return { split: node.split, ...(node.ratio?.length === list.length && node.children.length === list.length ? { ratio: node.ratio } : {}), children: list };
};
const remove = (root: Node, id: string): Node | null => {
  const path = locate(root, id);
  if (!path) return root;
  if (!path.length) return null;
  const parent = at(root, path.slice(0, -1)) as Fork | Group;
  const index = path[path.length - 1];
  kids(parent).splice(index, 1);
  if ('split' in parent && parent.ratio) parent.ratio.splice(index, 1);
  if ('tabs' in parent && parent.tabs.length === 1) root = set(root, path.slice(0, -1), parent.tabs[0]);
  return tidy(root);
};
const spread = (ratio: number[] | undefined, count: number, index: number, share: number) => {
  const old = ratio ?? Array.from({ length: count }, () => 1);
  const total = old.reduce((sum, weight) => sum + weight, 0);
  const scaled = old.map(weight => Math.max(1, Math.round(weight * (100 - share) / total)));
  scaled.splice(index, 0, share);
  return scaled;
};
const insert = (root: Node, id: string, beside: string, edge: Edge, share?: number): Node | string => {
  let path = locate(root, beside);
  if (!path) return `${beside} is not shown`;
  const holder = path.length ? at(root, path.slice(0, -1)) : null;
  if (holder && typeof holder === 'object' && 'tabs' in holder) {
    if (edge === 'tab') {
      if (holder.tabs.length >= TABS) return `tabs hold at most ${TABS} panels`;
      holder.tabs.splice(path[path.length - 1] + 1, 0, id);
      return root;
    }
    path = path.slice(0, -1);
  }
  if (edge === 'tab') return beside === 'chat' ? 'the chat cannot hold tabs' : set(root, path, { tabs: [beside, id] });
  const split: Split = edge === 'left' || edge === 'right' ? 'horizontal' : 'vertical';
  const before = edge === 'left' || edge === 'top';
  const outer = path.length ? at(root, path.slice(0, -1)) : null;
  if (outer && typeof outer === 'object' && 'split' in outer && outer.split === split && outer.children.length < CHILDREN) {
    const index = path[path.length - 1] + (before ? 0 : 1);
    if (share) outer.ratio = spread(outer.ratio, outer.children.length, index, share);
    else delete outer.ratio;
    outer.children.splice(index, 0, id);
    return root;
  }
  const target = at(root, path);
  const ratio = share ? { ratio: before ? [share, 100 - share] : [100 - share, share] } : {};
  return set(root, path, { split, ...ratio, children: before ? [id, target] : [target, id] });
};
const place = (root: Node, id: string, beside: string, edge: Edge, share?: number): Node | string => {
  if (id === beside) return 'a panel cannot move beside itself';
  const rest = remove(clone(root), id);
  if (rest === null || !locate(rest, beside)) return `${beside} is not shown`;
  const placed = insert(rest, id, beside, edge, share);
  return failed(placed) ? placed : tidy(placed) ?? 'nothing left to show';
};
const move = (root: Node, id: string, way: string): Node | string => {
  const tree = clone(root);
  const path = locate(tree, id);
  if (!path || !path.length) return `${id} is not shown`;
  const parent = at(tree, path.slice(0, -1)) as Fork | Group;
  const index = path[path.length - 1];
  if (way === 'tab') {
    if ('tabs' in parent) return `${id} is already in tabs`;
    const panelsIn = (node?: Node) => (node === undefined ? [] : leaves(node).filter(name => name !== 'chat'));
    const beside = panelsIn(parent.children[index - 1]).at(-1) ?? panelsIn(parent.children[index + 1])[0];
    return beside ? place(tree, id, beside, 'tab') : `no panel next to ${id}`;
  }
  if ('tabs' in parent) {
    const other = parent.tabs.find(name => name !== id) as string;
    return place(tree, id, other, WAYS[way]);
  }
  const split: Split = way === 'left' || way === 'right' ? 'horizontal' : 'vertical';
  const step = way === 'right' || way === 'down' ? 1 : -1;
  for (let depth = path.length - 1; depth >= 0; depth -= 1) {
    const outer = at(tree, path.slice(0, depth));
    const slot = path[depth];
    if (typeof outer === 'string' || 'tabs' in outer || outer.split !== split || !outer.children[slot + step]) continue;
    if (depth === path.length - 1) {
      [outer.children[slot], outer.children[slot + step]] = [outer.children[slot + step], outer.children[slot]];
      if (outer.ratio) [outer.ratio[slot], outer.ratio[slot + step]] = [outer.ratio[slot + step], outer.ratio[slot]];
      return tree;
    }
    if (outer.children.length >= CHILDREN) return `no room ${way} of ${id}`;
    parent.children.splice(index, 1);
    if (parent.ratio) parent.ratio.splice(index, 1);
    outer.children.splice(slot + (step > 0 ? 1 : 0), 0, id);
    delete outer.ratio;
    return tidy(tree) ?? `${id} is not shown`;
  }
  if (typeof tree === 'object' && 'split' in tree && tree.split === split && tree.children[step > 0 ? tree.children.length - 1 : 0] === id) return `${id} is already at the ${way} edge`;
  const rest = remove(tree, id);
  if (rest === null) return `${id} is not shown`;
  return tidy({ split, children: step > 0 ? [rest, id] : [id, rest] }) ?? `${id} is not shown`;
};
const swap = (root: Node, first: string, second: string): Node | string => {
  const tree = clone(root);
  const [one, two] = [locate(tree, first), locate(tree, second)];
  if (!one || !two) return `${one ? second : first} is not shown`;
  set(tree, one, second);
  return set(tree, two, first);
};
const parseNode = (value: unknown): Node | string => {
  const seen = new Set<string>();
  const walk = (raw: unknown, depth = 1): Node => {
    if (depth > DEPTH + 2 || seen.size >= LEAVES + REGISTERED) throw new Error(`a tree nests at most ${DEPTH + 2} levels and names at most ${LEAVES + REGISTERED} panels`);
    if (typeof raw === 'string') {
      if (raw !== 'chat' && !ID.test(raw)) throw new Error(`invalid panel id ${JSON.stringify(raw).slice(0, 40)}`);
      if (seen.has(raw)) throw new Error(`${raw} appears twice`);
      seen.add(raw);
      return raw;
    }
    const node = obj(raw);
    if (Array.isArray(node.tabs) && Object.keys(node).length === 1) {
      if (!node.tabs.length || node.tabs.length > TABS || node.tabs.some(tab => typeof tab !== 'string')) throw new Error(`tabs hold 1 to ${TABS} panel ids`);
      if (node.tabs.includes('chat')) throw new Error('the chat cannot go into tabs');
      return { tabs: node.tabs.map(tab => walk(tab, depth + 1)) as string[] };
    }
    const { split, ratio, children } = node;
    if ((split !== 'horizontal' && split !== 'vertical') || !Array.isArray(children) || Object.keys(node).some(key => !['split', 'ratio', 'children'].includes(key))) {
      throw new Error('a node is "chat", a panel id, {split, children, ratio?} or {tabs}');
    }
    if (children.length < 2 || children.length > CHILDREN) throw new Error(`a split holds 2 to ${CHILDREN} children`);
    if (ratio !== undefined && (!Array.isArray(ratio) || ratio.length !== children.length || ratio.some(weight => !Number.isInteger(weight) || (weight as number) < 1 || (weight as number) > 100))) {
      throw new Error('ratio needs one whole number from 1 to 100 per child');
    }
    return { split, ...(ratio ? { ratio: ratio as number[] } : {}), children: children.map(child => walk(child, depth + 1)) };
  };
  try {
    const node = walk(value);
    return seen.has('chat') ? node : 'the arrangement needs "chat" once';
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return error.message;
  }
};
const measure = (node: LayoutNode, depth = 1): { depth: number; cells: string[] } => {
  const inner = 'tabs' in node ? node.tabs.map(tab => tab.node) : 'children' in node ? node.children : [];
  const parts = inner.map(child => measure(child, depth + 1));
  return { depth: Math.max(depth, ...parts.map(part => part.depth)), cells: 'content' in node ? [node.content] : parts.flatMap(part => part.cells) };
};
const problem = (layout: LayoutNode): string | null => {
  const { depth, cells } = measure(layout);
  if (depth > DEPTH) return `nested ${depth} levels deep (the host draws ${DEPTH}; the chat counts two)`;
  if (cells.length > LEAVES) return `${cells.length} cells (the host draws ${LEAVES}; the chat counts two)`;
  return new Set(cells).size === cells.length ? null : 'a panel site appears twice';
};

export default function activate(api: ModAPI) {
  const load = (): State => ({
    off: false, registered: [], arranged: null, saved: {}, ratios: {}, recent: [], tabs: {}, mode: null, threads: {},
    ...(api.state.get() as Partial<State> | null),
  });
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
  const settled = typeof configured === 'object' ? configured : null;
  const ignored = [...invalid, ...(typeof configured === 'string' ? [`arrangement: ${configured}`] : [])];
  const commands: Panel[] = [];
  for (const [index, raw] of (Array.isArray(settings.terminals) ? settings.terminals : []).entries()) {
    const entry = obj(raw);
    const id = str(entry.id, 24);
    const title = str(entry.title, TITLE);
    const argv = Array.isArray(entry.argv) ? entry.argv.map(arg => str(arg, 1024)) : [];
    const taken = !id || !ID.test(id) || ['chat', 'dock'].includes(id) || [...BUILTIN, ...commands].some(panel => panel.id === id);
    if (taken || !title || !argv.length || argv.length > 64 || argv.some(arg => arg === null) || commands.length >= COMMANDS) {
      ignored.push(`terminals[${index}]: needs a new id, a title of at most ${TITLE} bytes and argv (1-64 strings); at most ${COMMANDS} terminals`);
      continue;
    }
    commands.push({ id, title, site: `omd_workspace/run_${id}`, run: { argv: argv as string[], write: entry.write === true, network: entry.network === 'loopback' } });
  }
  const pty = (panel: Panel) => (panel.id === 'terminal'
    ? { session: 'shell', component: SHELL, start: START, args: 'start' }
    : panel.run ? { session: `run_${panel.id}`, component: `omd_workspace_run_${panel.id}`, start: `omd_workspace_start_${panel.id}`, args: `start ${panel.id}` } : null);

  const presetOf = (state: State): Preset | null => (state.arranged ? state.arranged.preset ?? null : settled ? null : layoutSetting);
  const panels = (state: State): Panel[] => {
    const known = [...BUILTIN, ...commands, ...[...state.registered].sort((a, b) => (a.order ?? 100) - (b.order ?? 100))];
    const wanted = order.length ? [...new Set(order)].flatMap(id => known.filter(panel => panel.id === id)) : known;
    let cells = 0;
    const fits = (panel: Panel) => {
      const count = panel.tabs?.length ?? 1;
      if (cells + count > CELLS) return false;
      cells += count;
      return true;
    };
    return wanted.filter(fits).slice(0, TABS);
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
    const groups: number[][] = [];
    const visit = (node: Node, path: number[]) => {
      if (typeof node === 'object' && 'tabs' in node) groups.push(path);
      kids(node).forEach((child, index) => visit(child, [...path, index]));
    };
    visit(tree, []);
    const open = groups.find(path => (at(tree, path) as Group).tabs.length < TABS);
    if (open) {
      (at(tree, open) as Group).tabs.push(panel.id);
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
  const ownTab = (state: State, panel: Panel) => Math.min(state.tabs[panel.id] ?? 0, (panel.tabs?.length ?? 1) - 1);
  const expand = (state: State, list: Panel[], tree: Node, narrow: boolean): LayoutNode => {
    const byId = new Map(list.map((panel, index) => [panel.id, { panel, title: `${index + 1} ${panel.title}` }]));
    const chat: LayoutNode = { split: 'vertical', ratio: [5, 1], children: [{ content: 'transcript', title: 'Chat' }, { content: 'composer' }] };
    const panelNode = (id: string, title: string): LayoutNode => {
      const { panel } = byId.get(id)!;
      return panel.tabs
        ? { tabs: panel.tabs.map(tab => ({ title: tab.title, node: leaf(tab.site, title, border) })), active: ownTab(state, panel) }
        : leaf(panel.site, title, border);
    };
    const walk = (node: Node): LayoutNode => {
      if (node === 'chat') return chat;
      if (typeof node === 'string') return panelNode(node, byId.get(node)!.title);
      if ('tabs' in node) return { tabs: node.tabs.map(id => ({ title: byId.get(id)!.title, node: panelNode(id, '') })), active: activeOf(state, node) };
      const stored = state.ratios[signature(node)];
      const ratio = stored?.length === node.children.length ? stored : node.ratio;
      const split = narrow ? (leaves(node).includes('chat') ? 'vertical' : 'horizontal') : node.split;
      return { split, ...(ratio ? { ratio } : {}), children: node.children.map(walk) };
    };
    return walk(tree);
  };
  const render = (state: State, list: Panel[], columns: number, rows: number) => {
    const tree = shape(state, list, rows);
    const layout = expand(state, list, tree, columns < narrowBelow);
    if (!problem(layout)) return { tree, layout };
    const dock = preset('dock', list.map(panel => panel.id));
    return { tree: dock, layout: expand(state, list, dock, columns < narrowBelow) };
  };
  const check = (state: State, tree: Node): string | null => {
    const list = panels(state);
    const visible = new Set(['chat', ...list.map(panel => panel.id)]);
    const kept = prune(clone(tree), id => visible.has(id));
    return kept ? problem(expand(state, list, kept, false)) : null;
  };
  const commit = (state: State, tree: Node | string, by: 'user' | 'mod' = 'user'): string | null => {
    if (failed(tree)) return tree;
    const parsed = parseNode(tree);
    if (failed(parsed)) return parsed;
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
  const start = (state: State, thread: string, panel: Panel): string | null => {
    const session = pty(panel)!.session;
    const access = (write: boolean, network: boolean) => ({ ...(write ? { write: true } : {}), ...(network ? { network: 'loopback' as const } : {}) });
    const run = api.host.tryCall('terminal.pty', panel.run
      ? { action: 'start', session, program: panel.run.argv[0], argv: panel.run.argv.slice(1), ...access(panel.run.write, panel.run.network) }
      : { action: 'start', session, ...access(shellWrite, shellNetwork) });
    if (!run.ok) return /pty_session_exists_or_limit/.test(run.error) ? `${run.error}: ${PTY_CAP}` : run.error;
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
    const line = panel.run ? panel.run.argv.join(' ') : 'a sandboxed shell';
    const what = line.slice(0, encoder.encodeInto(line, new Uint8Array(100)).read);
    return [text(`${panel.id}_start`, `Enter starts ${what}.`), button(session.start, `Start ${panel.run ? panel.title : 'shell'}`, session.args)];
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
    const { tree, layout } = render(state, list, client?.columns ?? 120, client?.rows ?? 40);
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
      const { tree } = render(state, list, narrowBelow, 40);
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
        const refused = commit(state, place(arrangement(state, list), source, target, event.edge === 'center' ? 'tab' : event.edge));
        if (refused) api.host.tryCall('terminal.notice', { text: `Workspace: ${refused}`, kind: 'warning', placement: 'toast' });
      }
    });
  });

  api.on('turn_end', () => changed(state => {
    if (!state.off && panels(state).some(panel => panel.id === 'changes')) refresh(state, api.session().thread_id);
  }));

  const status = (state: State) => {
    const list = panels(state);
    const source = state.arranged ? `${state.arranged.preset ?? 'custom'}, set by ${state.arranged.by === 'mod' ? 'a mod' : 'you'}` : typeof configured === 'object' && configured ? 'arrangement setting' : layoutSetting;
    const hints = ([['panel_1', 'shows or focuses the first panel'], ['grow', 'grows'], ['shrink', 'shrinks'], ['main', 'returns to the chat'], ['help', 'lists the keys']] as [string, string][])
      .flatMap(([action, what]) => keys[action] ? [`${keys[action]} ${what}`] : []);
    return [
      `Workspace is ${state.off ? 'off' : 'on'} (${source}). Panels: ${list.map((panel, index) => `${index + 1} ${panel.title}`).join(', ') || 'none'}. Screen mode: ${state.mode ? `${state.mode.target} ${state.mode.level}` : 'normal'}.`,
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
      `Shell: ${shellWrite ? 'writes the workspace' : 'read-only'}, ${shellNetwork ? 'loopback network' : 'no network'}. Terminals: ${commands.map(panel => panel.id).join(', ') || 'none'}. PTYs: ${PTY_CAP}.`,
      ...ignored.map(reason => `Ignored: ${reason}`),
      ...unknown.map(id => `Ignored: panels: unknown panel ${id}`),
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
          const panel = list.find(item => item.id === (words[0] ?? 'terminal') && pty(item));
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
            if (!state.saved[name] && Object.keys(state.saved).length >= SAVED) return `At most ${SAVED} saved layouts; /workspace layout delete NAME frees one`;
            state.saved[name] = current();
            return `Saved layout ${name}`;
          }
          if (what === 'load' && state.saved[name]) return commit(state, state.saved[name]) ?? `Layout: ${name}`;
          if (what === 'delete' && state.saved[name]) {
            delete state.saved[name];
            return `Deleted layout ${name}`;
          }
          return `Usage: /workspace layout ${PRESETS.join('|')}|save NAME|load NAME|delete NAME. Saved: ${Object.keys(state.saved).join(', ') || 'none'}`;
        },
        move: () => {
          const [id = '', way = ''] = words;
          if (!known(id) || id === 'chat' || !Object.hasOwn(WAYS, way)) return 'Usage: /workspace move PANEL left|right|up|down|tab';
          return commit(state, move(current(), id, way));
        },
        swap: () => {
          const [first = '', second = ''] = words;
          if (!known(first) || !known(second) || first === second) return 'Usage: /workspace swap PANEL PANEL (chat counts as a panel)';
          return commit(state, swap(current(), first, second));
        },
        tab: () => {
          const [direction, id] = words;
          const tree = current();
          if (id === undefined && /^\d+$/.test(direction ?? '')) {
            const panel = list[Number(direction) - 1];
            if (!panel) return `Usage: /workspace tab 1-${list.length}|next|previous`;
            front(state, panel.id);
            return null;
          }
          if (id === undefined && (direction === 'next' || direction === 'previous')) {
            const groups: Group[] = [];
            const visit = (node: Node) => {
              if (typeof node === 'object' && 'tabs' in node) groups.push(node);
              kids(node).forEach(visit);
            };
            visit(tree);
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
          const [action = '', target = state.mode?.target ?? 'chat'] = words;
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
    name: 'omd.workspace', version: '1.1.0',
    methods: {
      register: { input: 'object', output: 'object' }, unregister: { input: 'object', output: 'object' }, panels: { input: 'null', output: 'object' },
      arrange: { input: 'object', output: 'object' }, arrangement: { input: 'object', output: 'object' },
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
        return { registered: id };
      });
    },
    unregister: input => changed(state => {
      const kept = state.registered.filter(panel => panel.id !== obj(input).id);
      const removed = kept.length < state.registered.length;
      state.registered = kept;
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
  });
}
