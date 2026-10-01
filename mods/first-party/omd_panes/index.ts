import type { CommandResult, Json, KeyAction, KeyName, LayoutNode, ModAPI, PtyRequest, ResourceRef, TerminalComponent, TerminalListRow, TerminalRenderSite, TerminalSelectOption, TerminalTone } from '@oh-my-diff/mod-api';

type Kind = 'chat' | 'tree' | 'viewer' | 'shell' | 'diff' | 'site' | 'browser';
type Pane = { kind: Kind; cwd?: string; argv?: string[]; site?: string; path?: string; session?: string };
type Split = { split: 'horizontal' | 'vertical'; ratio: number[]; children: Node[] };
type Tabs = { tabs: { title: string; node: Node }[]; active: number };
type Node = string | Split | Tabs;
type Layout = { root: Node; panes: Record<string, Pane>; active: string; next: number };
type View = { path: string; start: number; total: number; lines: string[]; line: number | null; range: [number, number] | null; revision: number; error: string | null };
type State = {
  layout: Layout; revision: number | null; repository: string | null; prefix: string | null; running: string[];
  expanded: string[]; listings: Record<string, string[]>; truncated: string[]; status: Record<string, string>; dirs: Record<string, string>;
  selected: string | null; find: string[] | null; views: Record<string, View>; diffs: Record<string, string>;
  backup: { reference: ResourceRef; paths: string[] } | null; watch: string | null; watched: string[]; search: Search | null;
};
type Search = { query: string; regex: boolean; case: boolean };
type Direction = 'left' | 'right' | 'up' | 'down';
type Rect = { x: number; y: number; w: number; h: number };

const WINDOW = 300;
const LIST_LIMIT = 200;
const EXPANDED_LIMIT = 6;
const STATUS_LIMIT = 600;
const ROW_LIMIT = 300;
const OPS_LIMIT = 128;
const TEXT_LIMIT = 20_000;
const DIRECTIONS: Direction[] = ['left', 'right', 'up', 'down'];
const KEYWORDS = new Set(['as', 'async', 'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'def', 'else', 'enum', 'export', 'extends', 'false', 'fn', 'for', 'from', 'function', 'if', 'impl', 'import', 'in', 'let', 'match', 'mut', 'new', 'None', 'null', 'of', 'pub', 'return', 'self', 'static', 'struct', 'this', 'true', 'try', 'type', 'use', 'var', 'while', 'with']);
const LANGUAGE = /\.(?:pyi?|[cm]?[jt]sx?|rs|java)$/;

const chat = (): Layout => ({ root: 'chat', panes: { chat: { kind: 'chat' } }, active: 'chat', next: 1 });
const kids = (node: Split | Tabs): Node[] => 'tabs' in node ? node.tabs.map(tab => tab.node) : node.children;
const leaves = (node: Node): string[] => typeof node === 'string' ? [node] : kids(node).flatMap(leaves);
const parentOf = (node: Node, target: Node): [Split | Tabs, number] | null => {
  if (typeof node === 'string') return null;
  const index = kids(node).indexOf(target);
  if (index >= 0) return [node, index];
  for (const child of kids(node)) {
    const found = parentOf(child, target);
    if (found) return found;
  }
  return null;
};
const replace = (layout: Layout, old: Node, next: Node) => {
  const found = parentOf(layout.root, old);
  if (!found) layout.root = next;
  else if ('tabs' in found[0]) found[0].tabs[found[1]].node = next;
  else found[0].children[found[1]] = next;
};
const detach = (layout: Layout, node: Node) => {
  const found = parentOf(layout.root, node);
  if (!found) return;
  const [parent, index] = found;
  if ('tabs' in parent) {
    parent.tabs.splice(index, 1);
    parent.active = Math.max(0, Math.min(parent.active - (index < parent.active ? 1 : 0), parent.tabs.length - 1));
    if (!parent.tabs.length) detach(layout, parent);
    return;
  }
  parent.children.splice(index, 1);
  parent.ratio = normalize(parent.ratio.filter((_, position) => position !== index));
  if (parent.children.length === 1) replace(layout, parent, parent.children[0]);
};
// The tab commands keep at most one tab group, beside the conversation.
const groupOf = (node: Node): Tabs | null => typeof node === 'string' ? null : 'tabs' in node ? node : kids(node).map(groupOf).find(Boolean) ?? null;
const reveal = (layout: Layout) => {
  for (let node: Node = layout.active, found = parentOf(layout.root, node); found; node = found[0], found = parentOf(layout.root, node)) if ('tabs' in found[0]) found[0].active = found[1];
};
const normalize = (ratio: number[]) => {
  const total = ratio.reduce((sum, value) => sum + value, 0) || 1;
  return ratio.map(value => Math.min(100, Math.max(1, Math.round(value * 100 / total))));
};
const rects = (node: Node, rect: Rect, out: Record<string, Rect> = {}): Record<string, Rect> => {
  if (typeof node === 'string') {
    out[node] = rect;
    return out;
  }
  if ('tabs' in node) return rects(node.tabs[node.active].node, rect, out);
  const total = node.ratio.reduce((sum, value) => sum + value, 0);
  let offset = 0;
  node.children.forEach((child, index) => {
    const share = node.ratio[index] / total;
    rects(child, node.split === 'horizontal' ? { ...rect, x: rect.x + offset * rect.w, w: share * rect.w } : { ...rect, y: rect.y + offset * rect.h, h: share * rect.h }, out);
    offset += share;
  });
  return out;
};
const neighbor = (layout: Layout, id: string, direction: Direction): string | null => {
  const all = rects(layout.root, { x: 0, y: 0, w: 1, h: 1 });
  const from = all[id];
  if (!from) return null;
  const across = direction === 'left' || direction === 'right';
  let best: string | null = null;
  let score = 1e-6;
  for (const [other, rect] of Object.entries(all)) {
    const gap = { right: rect.x - from.x - from.w, left: from.x - rect.x - rect.w, down: rect.y - from.y - from.h, up: from.y - rect.y - rect.h }[direction];
    const overlap = across ? Math.min(from.y + from.h, rect.y + rect.h) - Math.max(from.y, rect.y) : Math.min(from.x + from.w, rect.x + rect.w) - Math.max(from.x, rect.x);
    if (Math.abs(gap) < 1e-6 && overlap > score) {
      best = other;
      score = overlap;
    }
  }
  return best;
};
const label = (text: string, limit = 32) => {
  let out = '';
  let bytes = 0;
  for (const char of text.replace(/[\u0000-\u001f\u007f-\u009f]/g, '?')) {
    const code = char.codePointAt(0) ?? 0;
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
    if (bytes > limit) break;
    out += char;
  }
  return out;
};
const titleOf = (pane: Pane) => label(pane.kind === 'tree' ? 'Files' : pane.kind === 'viewer' ? pane.path ?? 'Viewer' : pane.kind === 'diff' ? `Diff ${pane.path ?? 'HEAD'}`
  : pane.kind === 'browser' ? `Browser ${pane.session ?? 'default'}` : pane.kind === 'site' ? pane.site ?? 'Panel' : pane.kind === 'chat' ? 'Conversation'
    : pane.argv ? pane.argv.join(' ') : `Shell ${pane.cwd ?? '.'}`);
const siteName = (id: string, pane: Pane) => pane.kind === 'site' ? pane.site ?? 'sidebar' : `omd_panes/${id}-${pane.kind}`;
const native = (layout: Layout, node: Node): LayoutNode => typeof node !== 'string'
  ? 'tabs' in node ? { tabs: node.tabs.map(tab => ({ title: tab.title, node: native(layout, tab.node) })), active: node.active }
    : { split: node.split, ratio: node.ratio, children: node.children.map(child => native(layout, child)) }
  : layout.panes[node].kind === 'chat'
    ? { split: 'vertical', ratio: [5, 1], children: [{ content: 'transcript' }, { content: 'composer' }] }
    : { content: `site:${siteName(node, layout.panes[node])}` as `site:${string}/${string}` };
const valid = (layout: Layout) => {
  const ids = leaves(layout.root);
  const sites = ids.map(id => siteName(id, layout.panes[id]));
  const cells = ids.reduce((total, id) => total + (layout.panes[id].kind === 'chat' ? 2 : 1), 0);
  const fits = (node: Node, depth: number): boolean => typeof node === 'string'
    ? depth + (layout.panes[node].kind === 'chat' ? 1 : 0) <= 4
    : 'tabs' in node ? node.tabs.length <= 6 && !leaves(node).includes('chat') && node.tabs.every(tab => fits(tab.node, depth + 1))
      : node.children.length <= 4 && node.children.every(child => fits(child, depth + 1));
  return cells <= 12 && new Set(sites).size === sites.length && fits(layout.root, 1);
};
const words = (value: Json) => String(value ?? '').trim().split(/\s+/).filter(Boolean);
const clean = (path: string) => /^\/|(^|\/)\.\.?(\/|$)|(^|\/)\.git(\/|$)/.test(path.trim()) ? null : path.trim().split('/').filter(Boolean).join('/');
const parent = (path: string) => path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
const join = (dir: string, name: string) => dir ? `${dir}/${name}` : name;
const natural = (a: string, b: string) => Number(b.endsWith('/')) - Number(a.endsWith('/')) || a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
const rank = (code: string) => code.includes('U') || code === 'AA' || code === 'DD' ? 4 : code[1] !== ' ' && code !== '??' ? 3 : code === '??' ? 1 : 2;
const tone = (code?: string): TerminalTone => !code ? 'normal' : code === '!!' ? 'muted' : code === '??' ? 'accent' : rank(code) === 4 ? 'failure' : rank(code) === 3 ? 'attention' : 'success';

export default function activate(api: ModAPI) {
  const glyph = api.settings.icons === 'ascii' ? { open: '- ', closed: '+ ', active: '*', idle: 'o' } : { open: '▾ ', closed: '▸ ', active: '●', idle: '○' };
  const empty = (): State => ({ layout: chat(), revision: null, repository: null, prefix: null, running: [], expanded: [], listings: {}, truncated: [], status: {}, dirs: {},
    selected: null, find: null, views: {}, diffs: {}, backup: null, watch: null, watched: [], search: null });
  const load = (): State => ({ ...empty(), ...(api.state.get() as Partial<State> | null) });
  const save = (state: State) => api.state.set(state as unknown as Json);
  const has = (state: State, kind: Kind) => leaves(state.layout.root).some(id => state.layout.panes[id].kind === kind);
  const guard = (run: () => CommandResult): CommandResult => {
    try {
      return run();
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      return { display: `panes: ${error.message}` };
    }
  };

  const commit = (state: State) => {
    reveal(state.layout);
    const put = (expected: number | null) => api.host.tryCall('store.put', { key: 'layout', scope: 'thread', value: state.layout as unknown as Json, expected_revision: expected });
    let saved = put(state.revision);
    if (!saved.ok) {
      const current = api.host.tryCall('store.get', { key: 'layout', scope: 'thread' });
      saved = current.ok ? put(current.value?.revision ?? null) : saved;
    }
    state.revision = saved.ok ? saved.value.revision : null;
    save(state);
  };
  const edit = (state: State, change: (layout: Layout) => string | null): string | null => {
    const before = JSON.stringify(state.layout);
    const refused = change(state.layout);
    if (!refused && valid(state.layout)) return null;
    state.layout = JSON.parse(before) as Layout;
    return refused ?? 'the layout allows at most 12 panes nested 4 deep, and each mod panel once';
  };
  const insert = (layout: Layout, anchor: string, direction: 'right' | 'down', pane: Pane): string => {
    const id = `p${layout.next++}`;
    layout.panes[id] = pane;
    const orientation = direction === 'down' ? 'vertical' : 'horizontal';
    const found = parentOf(layout.root, anchor);
    const [split, index] = found ?? [];
    if (split && 'split' in split && index !== undefined && split.split === orientation && split.children.length < 4) {
      split.ratio.splice(index, 1, split.ratio[index] / 2, split.ratio[index] / 2);
      split.children.splice(index + 1, 0, id);
      split.ratio = normalize(split.ratio);
    } else replace(layout, anchor, { split: orientation, ratio: [50, 50], children: [anchor, id] });
    layout.active = id;
    return id;
  };
  const remove = (state: State, id: string) => {
    detach(state.layout, id);
    delete state.layout.panes[id];
    delete state.views[id];
    delete state.diffs[id];
    if (state.running.includes(id)) api.host.tryCall('terminal.pty', { action: 'stop', session: id });
    state.running = state.running.filter(session => session !== id);
    if (state.layout.active === id) state.layout.active = leaves(state.layout.root)[0];
  };

  const repository = (state: State): string | null => {
    if (state.repository) return state.repository;
    const run = api.host.tryCall('exec.run', { program: 'pwd', timeout_ms: 5_000 });
    state.repository = run.ok && run.value.exit_code === 0 ? run.value.stdout.trim() : null;
    return state.repository;
  };
  const list = (state: State, dir: string) => {
    const listed = api.host.tryCall('workspace.list', { ...(dir ? { path: dir } : {}), recursive: false, include_ignored: true, max_entries: LIST_LIMIT });
    state.truncated = state.truncated.filter(item => item !== dir);
    if (!listed.ok) {
      delete state.listings[dir];
      state.expanded = state.expanded.filter(item => item !== dir);
      return;
    }
    if (listed.value.truncated) state.truncated.push(dir);
    state.listings[dir] = listed.value.entries.map(entry => `${entry.path.slice(dir ? dir.length + 1 : 0)}${entry.kind === 'dir' ? '/' : ''}`).sort(natural);
  };
  const gitStatus = (state: State) => {
    state.status = {};
    state.dirs = {};
    if (state.prefix === null) {
      const prefix = api.host.tryCall('exec.run', { program: 'git', argv: ['rev-parse', '--show-prefix'], timeout_ms: 5_000 });
      if (!prefix.ok || prefix.value.exit_code !== 0) return;
      state.prefix = prefix.value.stdout.trim();
    }
    const run = (ignored: boolean) => api.host.tryCall('exec.run', { program: 'git', argv: ['--no-pager', '--no-optional-locks', '-c', 'core.quotepath=false', '-c', 'core.fsmonitor=false', 'status', '--porcelain=v1', '-z', ...(ignored ? ['--ignored'] : []), '--', '.'], timeout_ms: 10_000 });
    let result = run(true);
    if (result.ok && result.value.stdout_preview_truncated) result = run(false);
    if (!result.ok || result.value.exit_code !== 0 || result.value.stdout_preview_truncated) return;
    const parts = result.value.stdout.split('\0');
    const entries: [string, string][] = [];
    for (let index = 0; index < parts.length; index++) {
      if (parts[index].length < 4) continue;
      if (parts[index].slice(3).startsWith(state.prefix)) entries.push([parts[index].slice(3 + state.prefix.length), parts[index].slice(0, 2)]);
      if ('RC'.includes(parts[index][0])) index++;
    }
    entries.sort(([, a], [, b]) => Number(a === '!!') - Number(b === '!!'));
    for (const [path, code] of entries.slice(0, STATUS_LIMIT)) {
      state.status[path] = code;
      if (code === '!!') continue;
      for (let dir = parent(path.replace(/\/$/, '')); dir; dir = parent(dir)) if (!state.dirs[dir] || rank(code) > rank(state.dirs[dir])) state.dirs[dir] = code;
    }
  };
  const statusOf = (state: State, path: string, dir: boolean): string | undefined => {
    const own = state.status[dir ? `${path}/` : path];
    if (own) return own;
    for (let above = parent(path); above; above = parent(above)) if (state.status[`${above}/`]) return state.status[`${above}/`];
    return dir ? state.dirs[path] : undefined;
  };
  const readView = (state: State, id: string, path: string, line: number | null, start?: number) => {
    const from = start ?? (line ? Math.max(0, line - Math.floor(WINDOW / 4)) : 0);
    const run = api.host.tryCall('exec.run', { program: 'awk', argv: ['-v', `s=${from + 1}`, '-v', `e=${from + WINDOW}`, 'NR>=s && NR<=e { print substr($0, 1, 300) } END { print NR > "/dev/stderr" }', `./${path}`], timeout_ms: 10_000 });
    const revision = (state.views[id]?.revision ?? 0) + 1;
    const error = !run.ok ? run.error : run.value.exit_code !== 0 ? run.value.stderr.trim().split('\n')[0] || 'read failed' : null;
    const lines = run.ok && !error ? run.value.stdout.split('\n').slice(0, -1) : [];
    let size = 0;
    const kept = lines.slice(0, run.ok && run.value.stdout_preview_truncated ? -1 : undefined).filter(text => (size += text.length + 1) <= TEXT_LIMIT);
    const binary = kept.some(text => text.includes('\u0000'));
    state.views[id] = { path, start: from, total: run.ok ? Number(run.value.stderr.trim().split('\n').at(-1)) || kept.length : 0, lines: binary ? [] : kept,
      line, range: line ? [line, line] : null, revision, error: error ?? (binary ? 'binary file' : null) };
  };
  const readDiff = (state: State, id: string) => {
    const path = state.layout.panes[id].path;
    const run = api.host.tryCall('exec.run', { program: 'git', argv: ['--no-pager', '--no-optional-locks', '-c', 'core.quotepath=false', 'diff', '--no-ext-diff', '--no-color', 'HEAD', '--', ...(path ? [path] : [])], timeout_ms: 10_000 });
    state.diffs[id] = !run.ok ? `error: ${run.error}` : run.value.exit_code !== 0 ? `error: ${run.value.stderr.trim().split('\n')[0]}` : run.value.stdout.slice(0, TEXT_LIMIT);
  };
  const refresh = (state: State, paths: string[] | null) => {
    const ids = leaves(state.layout.root);
    if (has(state, 'tree')) {
      const dirs = ['', ...state.expanded].filter(dir => paths === null || paths.some(path => !dir || path.startsWith(`${dir}/`)));
      for (const dir of dirs) list(state, dir);
    }
    if (has(state, 'tree') || has(state, 'diff')) gitStatus(state);
    for (const id of ids) {
      const view = state.views[id];
      if (view && (paths === null || paths.includes(view.path))) readView(state, id, view.path, view.line, view.start);
      if (state.layout.panes[id].kind === 'diff' && (paths === null || paths.length)) readDiff(state, id);
    }
  };
  const syncWatch = (state: State) => {
    const wanted = [...state.expanded, ...Object.values(state.views).map(view => view.path)].slice(0, 32);
    if (JSON.stringify(wanted) === JSON.stringify(state.watched) && (state.watch || !wanted.length)) return;
    if (state.watch) api.host.tryCall('workspace.unwatch', { watch_id: state.watch });
    const watched = wanted.length ? api.host.tryCall('workspace.watch', { paths: wanted, recursive: false, debounce_ms: 300 }) : null;
    state.watch = watched?.ok ? watched.value.watch_id : null;
    state.watched = wanted;
  };
  const rewatch = () => api.host.tryCall('events.publish', { channel: 'watch', data: null });

  const start = (state: State, id: string): string | null => {
    const pane = state.layout.panes[id];
    let request: PtyRequest;
    if (pane.kind === 'browser') {
      const endpoint = String(api.settings.browser ?? '');
      if (!endpoint) return 'set the omd_panes `browser` setting to the omd-browser pane.json path';
      const read = api.host.tryCall('exec.run', { program: 'cat', argv: [endpoint], timeout_ms: 5_000 });
      let client = '';
      try {
        client = read.ok && read.value.exit_code === 0 ? String((JSON.parse(read.value.stdout) as { client?: string }).client ?? '') : '';
      } catch {
        client = '';
      }
      if (!client) return `no omd-browser pane endpoint at ${endpoint}; is the omd-browser plugin running?`;
      request = { action: 'start', session: id, program: 'node', argv: [client, endpoint, pane.session ?? 'default'], network: 'loopback' };
    } else request = { action: 'start', session: id, cwd: pane.cwd ?? '.', write: api.settings.shell_write !== false, ...(pane.argv ? { program: pane.argv[0], argv: pane.argv.slice(1) } : {}) };
    const started = api.host.tryCall('terminal.pty', request);
    if (!started.ok) return started.error;
    if ('status' in started.value) return 'declined';
    state.running = [...new Set([...state.running, id])];
    return null;
  };
  const openTree = (state: State): string | null => {
    const existing = leaves(state.layout.root).find(id => state.layout.panes[id].kind === 'tree');
    if (existing) {
      state.layout.active = existing;
      return null;
    }
    const refused = edit(state, layout => {
      const id = `p${layout.next++}`;
      const root = layout.root;
      layout.panes[id] = { kind: 'tree' };
      layout.active = id;
      if (typeof root !== 'string' && 'split' in root && root.split === 'horizontal' && root.children.length < 4) {
        root.children.unshift(id);
        root.ratio = normalize([root.ratio.reduce((sum, value) => sum + value, 0) / 3, ...root.ratio]);
      } else layout.root = { split: 'horizontal', ratio: [25, 75], children: [id, root] };
      return null;
    });
    if (!refused) refresh(state, null);
    return refused;
  };
  const openFile = (state: State, target: string, from?: string): CommandResult => {
    const match = /^(.*?)(?::(\d+))?$/.exec(target.trim());
    const path = clean(match?.[1] ?? '');
    const line = match?.[2] ? Number(match[2]) : null;
    if (!path) return { display: 'usage: /open PATH[:LINE]' };
    const stat = api.host.tryCall('workspace.stat', { paths: [path] });
    if (!stat.ok || stat.value.files[path]?.kind !== 'file') return { display: `No file ${path} in the workspace` };
    let viewer = [state.layout.active, ...leaves(state.layout.root)].find(candidate => state.layout.panes[candidate]?.kind === 'viewer') ?? '';
    if (!viewer) {
      const refused = edit(state, layout => {
        viewer = insert(layout, from ?? layout.active, 'right', { kind: 'viewer' });
        return null;
      });
      if (refused) return { display: refused };
    }
    state.layout.panes[viewer].path = path;
    state.layout.active = viewer;
    readView(state, viewer, path, line);
    commit(state);
    rewatch();
    return null;
  };

  const paneFor = (state: State, spec: string[]): Pane | null => {
    const [kind = 'shell', ...rest] = { notes: ['site', 'omd_notes/notes'], lsp: ['site', 'omd_lsp_view/lsp'] }[spec[0] ?? ''] ?? spec;
    const dir = state.selected && state.listings[state.selected] ? state.selected : parent(state.selected ?? '');
    return kind === 'shell' ? { kind: 'shell', cwd: clean(rest[0] ?? dir) || '.' }
      : kind === 'run' && rest.length ? { kind: 'shell', argv: rest, cwd: clean(dir) || '.' }
        : kind === 'diff' ? { kind: 'diff', ...(rest[0] ? { path: clean(rest[0]) ?? undefined } : {}) }
          : kind === 'site' && /^(sidebar|[a-z0-9_-]{1,24}\/[a-z0-9_-]{1,32})$/.test(rest[0] ?? '') ? { kind: 'site', site: rest[0] }
            : kind === 'browser' ? { kind: 'browser', session: /^[A-Za-z0-9][\w-]{0,31}$/.test(rest[0] ?? '') ? rest[0] : 'default' }
              : kind === 'tree' ? { kind: 'tree' } : null;
  };
  const launch = (state: State, id: string): CommandResult => {
    const pane = state.layout.panes[id];
    if (pane.kind === 'shell' || pane.kind === 'browser') {
      const failed = start(state, id);
      if (failed) {
        remove(state, id);
        return done(state, failed === 'declined' ? null : failed);
      }
    }
    if (pane.kind === 'diff') readDiff(state, id);
    if (pane.kind === 'tree') refresh(state, null);
    return done(state, null);
  };
  const create = (state: State, anchor: string, direction: 'right' | 'down', spec: string[]): CommandResult => {
    if (spec[0] === 'tree') return done(state, openTree(state));
    if (spec[0] === 'view') return openFile(state, spec.slice(1).join(' '), anchor);
    const pane = paneFor(state, spec);
    if (!pane) return { display: 'usage: /pane split right|down [shell [DIR] | run CMD... | diff [PATH] | site NAME | notes | lsp | browser [SESSION] | tree | view PATH]' };
    let id = '';
    const refused = edit(state, layout => {
      id = insert(layout, anchor, direction, pane);
      return null;
    });
    return refused ? { display: refused } : launch(state, id);
  };
  const tab = (state: State, op: string | undefined, rest: string[]): CommandResult => {
    const group = groupOf(state.layout.root);
    if (op === 'new') {
      const pane = paneFor(state, rest);
      if (!pane) return { display: 'usage: /pane tab new [shell [DIR] | run CMD... | diff [PATH] | site NAME | notes | lsp | browser [SESSION] | tree]' };
      let id = '';
      const refused = edit(state, layout => {
        const target = groupOf(layout.root);
        if (target || layout.active !== 'chat') {
          id = `p${layout.next++}`;
          layout.panes[id] = pane;
          if (target) target.tabs.push({ title: titleOf(pane), node: id });
          else replace(layout, layout.active, { tabs: [{ title: titleOf(layout.panes[layout.active]), node: layout.active }, { title: titleOf(pane), node: id }], active: 1 });
        } else replace(layout, id = insert(layout, 'chat', 'right', pane), { tabs: [{ title: titleOf(pane), node: id }], active: 0 });
        layout.active = id;
        return null;
      });
      return refused ? { display: refused } : launch(state, id);
    }
    if (!group) return { display: 'No tabs yet; /pane tab new [KIND] opens one' };
    if (op === 'close') {
      for (const id of leaves(group.tabs[group.active].node)) remove(state, id);
      rewatch();
      return done(state, null);
    }
    if (op === 'rename') {
      const title = label(rest.join(' ').trim());
      if (!title) return { display: 'usage: /pane tab rename TITLE' };
      group.tabs[group.active].title = title;
      return done(state, null);
    }
    const count = group.tabs.length;
    const index = op === 'next' ? (group.active + 1) % count : op === 'prev' ? (group.active + count - 1) % count : Number(op) - 1;
    if (!group.tabs[index]) return { display: 'usage: /pane tab new [KIND] | close | rename TITLE | next | prev | 1-6' };
    group.active = index;
    state.layout.active = leaves(group.tabs[index].node)[0];
    return done(state, null);
  };
  const cockpit = (state: State) => {
    for (const pane of leaves(state.layout.root)) if (pane !== 'chat') remove(state, pane);
    state.layout = { root: { split: 'horizontal', ratio: [22, 48, 30], children: ['p1', 'chat', { tabs: [{ title: 'Changes', node: 'p2' }, { title: 'Files', node: 'p3' }, { title: 'Diff', node: 'p4' }], active: 0 }] },
      panes: { chat: { kind: 'chat' }, p1: { kind: 'site', site: 'omd_layout/sessions' }, p2: { kind: 'site', site: 'sidebar' }, p3: { kind: 'tree' }, p4: { kind: 'diff' } }, active: 'chat', next: 5 };
    refresh(state, null);
    readDiff(state, 'p4');
    rewatch();
    return done(state, null);
  };
  const done = (state: State, message: string | null): CommandResult => {
    commit(state);
    return message ? { display: message } : null;
  };

  api.command('pane', value => guard(() => {
    const args = words(value);
    const state = load();
    const layout = state.layout;
    const named = args.find(word => word.startsWith('@'))?.slice(1);
    const id = named && layout.panes[named] ? named : layout.active;
    const [op, ...rest] = args.filter(word => !word.startsWith('@'));
    const direction = DIRECTIONS.find(item => item === rest[0]);
    switch (op) {
      case undefined:
        return { display: leaves(layout.root).map(pane => `${pane === layout.active ? glyph.active : glyph.idle} ${pane} ${layout.panes[pane].kind}${layout.panes[pane].path ? ` ${layout.panes[pane].path}` : ''}`).join('\n') };
      case 'focus': {
        const next = rest[0] && layout.panes[rest[0]] ? rest[0] : direction ? neighbor(layout, id, direction) : id;
        if (!next) return null;
        layout.active = next;
        return done(state, null);
      }
      case 'split':
        return create(state, id, rest[0] === 'down' ? 'down' : 'right', rest.slice(1));
      case 'move': {
        const other = direction && neighbor(layout, id, direction);
        if (!other) return null;
        const swap = (node: Node): Node => typeof node === 'string' ? node === id ? other : node === other ? id : node
          : 'tabs' in node ? { ...node, tabs: node.tabs.map(item => ({ ...item, node: swap(item.node) })) } : { ...node, children: node.children.map(swap) };
        return done(state, edit(state, current => {
          current.root = swap(current.root);
          return null;
        }));
      }
      case 'grow':
      case 'shrink': {
        const orientation = rest[0] === 'height' ? 'vertical' : 'horizontal';
        let current: Node = id;
        for (let found = parentOf(layout.root, current); found; current = found[0], found = parentOf(layout.root, current)) {
          const [split, index] = found;
          if (!('split' in split) || split.split !== orientation) continue;
          const other = index + 1 < split.children.length ? index + 1 : index - 1;
          const total = split.ratio.reduce((sum, item) => sum + item, 0);
          const step = Math.round(total / 10) * (op === 'grow' ? 1 : -1);
          const moved = Math.max(-(split.ratio[index] - 1), Math.min(step, split.ratio[other] - 1));
          split.ratio[index] += moved;
          split.ratio[other] -= moved;
          split.ratio = normalize(split.ratio);
          return done(state, null);
        }
        return null;
      }
      case 'close':
        if (layout.panes[id].kind === 'chat') return { display: 'The conversation pane stays open; close the other panes instead' };
        remove(state, id);
        rewatch();
        return done(state, null);
      case 'restart': {
        if (!['shell', 'browser'].includes(layout.panes[id].kind)) return { display: `${id} is not a shell or browser pane` };
        api.host.tryCall('terminal.pty', { action: 'stop', session: id });
        return done(state, start(state, id));
      }
      case 'reset':
        for (const pane of leaves(layout.root)) if (pane !== 'chat') remove(state, pane);
        state.layout = chat();
        rewatch();
        return done(state, null);
      case 'tab':
        return tab(state, rest[0], rest.slice(1));
      case 'cockpit':
        return cockpit(state);
      default:
        return { display: 'usage: /pane [split right|down KIND | focus left|right|up|down|ID | move DIR | grow|shrink width|height | close | restart | reset | tab new|close|rename|next|prev|N | cockpit] [@ID]' };
    }
  }), { description: 'Split, focus, move, resize and close panes (Alt+h/j/k/l focus, Alt+v/Alt+o split, Alt+x close, Alt+e files)' });

  api.command('tree', value => guard(() => {
    const text = String(value ?? '').trim();
    const [op = '', ...rest] = text.split(' ');
    const argument = rest.join(' ');
    const state = load();
    if (op === '') {
      const tree = leaves(state.layout.root).find(id => state.layout.panes[id].kind === 'tree');
      if (tree) remove(state, tree);
      const refused = tree ? null : openTree(state);
      rewatch();
      return done(state, refused);
    }
    if (op === 'select') {
      if (argument.startsWith('…')) return { display: 'This folder has more entries than the tree lists; use Find to reach them' };
      state.selected = argument;
      if (state.listings[argument] !== undefined || (state.listings[parent(argument)] ?? []).includes(`${argument.slice(argument.lastIndexOf('/') + 1)}/`)) {
        state.expanded = state.expanded.includes(argument)
          ? state.expanded.filter(dir => dir !== argument && !dir.startsWith(`${argument}/`))
          : [...state.expanded, argument].slice(-EXPANDED_LIMIT);
        for (const dir of Object.keys(state.listings)) if (dir && !state.expanded.includes(dir)) delete state.listings[dir];
        if (state.expanded.includes(argument)) list(state, argument);
        save(state);
        rewatch();
        return null;
      }
      const tree = leaves(state.layout.root).find(id => state.layout.panes[id].kind === 'tree');
      return openFile(state, argument, tree);
    }
    if (op === 'find') {
      if (!argument) {
        state.find = null;
        save(state);
        return null;
      }
      const root = repository(state);
      const scope = state.selected && state.listings[state.selected] !== undefined ? state.selected : '';
      const found = root ? api.host.tryCall('app.request', { method: 'fuzzyFileSearch', params: { query: scope ? `${scope}/ ${argument}` : argument, roots: [root], cancellationToken: 'omd_panes' } }) : null;
      if (!found?.ok) return { display: `find failed: ${found?.error ?? 'repository path unavailable'}` };
      const files = ((found.value as { files?: { path?: string }[] }).files ?? []).map(file => String(file.path ?? '')).filter(path => path && (!scope || path.startsWith(`${scope}/`)));
      state.find = files.slice(0, 200);
      save(state);
      api.host.tryCall('events.publish', { channel: 'find', data: { query: argument, scope, paths: state.find } });
      return files.length ? null : { display: `No files match ${argument}${scope ? ` in ${scope}` : ''}` };
    }
    if (op === 'refresh') {
      refresh(state, null);
      save(state);
      return null;
    }
    return { display: 'usage: /tree [select PATH | find QUERY | refresh]' };
  }), { description: 'Toggle the file tree pane (Alt+e), or select, find and refresh its entries' });

  api.command('open', value => guard(() => openFile(load(), String(value ?? ''))), { description: 'Open a workspace file in the viewer pane: /open PATH[:LINE]' });

  const confirm = (title: string, message: string) => {
    const answer = api.host.tryCall('terminal.prompt', { kind: 'confirm', title, message });
    return answer.ok && answer.value.status === 'accepted';
  };
  const ask = (title: string, message: string): string | null => {
    const answer = api.host.tryCall('terminal.prompt', { kind: 'text', title, message });
    return answer.ok && answer.value.status === 'accepted' ? clean(answer.value.value ?? '') : null;
  };
  const files = (path: string): { files: string[]; dirs: string[] } | string => {
    const listed = api.host.tryCall('workspace.list', { path, recursive: true, include_ignored: true, max_entries: OPS_LIMIT + 1 });
    if (!listed.ok) return listed.error;
    const entries = listed.value.entries;
    if (listed.value.truncated || entries.filter(entry => entry.kind !== 'dir').length > OPS_LIMIT) return `${path} holds more than ${OPS_LIMIT} files; use a shell pane for bulk moves`;
    if (entries.some(entry => entry.kind === 'symlink')) return `${path} contains symbolic links; use a shell pane`;
    return { files: entries.filter(entry => entry.kind === 'file').map(entry => entry.path), dirs: entries.filter(entry => entry.kind === 'dir').map(entry => entry.path) };
  };
  const hashes = (paths: string[]): Record<string, string> | string => {
    const stat = api.host.tryCall('workspace.stat', { paths, hash: true });
    if (!stat.ok) return stat.error;
    const out: Record<string, string> = {};
    for (const path of paths) {
      const sha = stat.value.files[path]?.sha256;
      if (!sha) return `${path} changed; refresh and retry`;
      out[path] = sha;
    }
    return out;
  };
  const shell = (program: string, argv: string[], paths: string[]) => api.host.tryCall('exec.run', { program, argv, write: true, required_access: { write: paths.slice(0, 128) }, timeout_ms: 10_000 });
  const mkdirs = (dirs: string[]) => {
    const needed = [...new Set(dirs.filter(Boolean))];
    return needed.length ? shell('mkdir', ['-p', '--', ...needed], needed) : null;
  };
  const prune = (dir: string) => shell('find', [dir, '-depth', '-type', 'd', '-empty', '-delete'], [dir]);
  const settle = (state: State, touched: string[], select: string | null): CommandResult => {
    state.selected = select;
    refresh(state, touched);
    save(state);
    return null;
  };

  api.command('file', value => guard(() => {
    const text = String(value ?? '').trim();
    const op = text.split(' ')[0];
    const path = text.slice(op.length).trim();
    const state = load();
    const stat = path ? api.host.tryCall('workspace.stat', { paths: [path] }) : null;
    const kind = stat?.ok ? stat.value.files[path]?.kind ?? null : null;
    const dir = kind === 'dir' ? path : parent(path);
    switch (op) {
      case 'open':
        return kind === 'file' ? openFile(state, path) : null;
      case 'insert':
        api.host.tryCall('composer.write', { insert: `${path} ` });
        return null;
      case 'editor': {
        const root = repository(state);
        const opened = root ? api.host.tryCall('terminal.open', { path: `${root}/${path}`, editor: true }) : null;
        return opened?.ok ? null : { display: opened?.error ?? 'repository path unavailable' };
      }
      case 'new_file':
      case 'new_folder': {
        const name = ask(op === 'new_file' ? 'New file' : 'New folder', `Name inside ${dir || 'the repository root'}`);
        if (!name) return null;
        const target = join(dir, name);
        const exists = api.host.tryCall('workspace.stat', { paths: [target] });
        if (!exists.ok || exists.value.files[target]) return { display: `${target} already exists` };
        if (!confirm(op === 'new_file' ? 'Create file' : 'Create folder', `Create ${target}`)) return null;
        const made = mkdirs(op === 'new_file' ? [parent(target)] : [target]);
        if (made && (!made.ok || made.value.exit_code !== 0)) return { display: `mkdir failed: ${made.ok ? made.value.stderr.trim() : made.error}` };
        if (op === 'new_file') {
          const written = api.host.tryCall('workspace.transaction', { expected: { [target]: null }, writes: { [target]: '' } });
          if (!written.ok) return { display: `create failed: ${written.error}` };
        }
        return settle(state, [target], target);
      }
      case 'rename':
      case 'move': {
        if (!kind) return { display: `No ${path} in the workspace` };
        const answer = ask(op === 'rename' ? 'Rename' : 'Move', op === 'rename' ? `New name for ${path}` : `New path for ${path}`);
        const target = answer && (op === 'rename' ? join(parent(path), answer) : answer);
        if (!target || target === path) return null;
        if (target.startsWith(`${path}/`)) return { display: 'A folder cannot move into itself' };
        const exists = api.host.tryCall('workspace.stat', { paths: [target] });
        if (!exists.ok || exists.value.files[target]) return { display: `${target} already exists` };
        const tree = kind === 'dir' ? files(path) : { files: [path], dirs: [] };
        if (typeof tree === 'string') return { display: tree };
        const expected = hashes(tree.files);
        if (typeof expected === 'string') return { display: expected };
        const moved = (item: string) => target + item.slice(path.length);
        if (!confirm(op === 'rename' ? 'Rename' : 'Move', `${path} → ${target}${kind === 'dir' ? ` (${tree.files.length} files)` : ''}`)) return null;
        const made = mkdirs([parent(target), ...(kind === 'dir' ? [target, ...tree.dirs.map(moved)] : [])]);
        if (made && (!made.ok || made.value.exit_code !== 0)) return { display: `mkdir failed: ${made.ok ? made.value.stderr.trim() : made.error}` };
        const renamed = tree.files.length ? api.host.tryCall('workspace.transaction', {
          expected: { ...expected, ...Object.fromEntries(tree.files.map(item => [moved(item), null])) },
          renames: tree.files.map(item => ({ old: item, new: moved(item) })),
        }) : null;
        if (renamed && !renamed.ok) return { display: `move failed: ${renamed.error}` };
        if (kind === 'dir') prune(path);
        return settle(state, [path, target, ...tree.files.map(moved)], target);
      }
      case 'delete': {
        if (!kind) return { display: `No ${path} in the workspace` };
        const tree = kind === 'dir' ? files(path) : { files: [path], dirs: [] };
        if (typeof tree === 'string') return { display: tree };
        const expected = hashes(tree.files);
        if (typeof expected === 'string') return { display: expected };
        if (!confirm('Delete', `Delete ${path}${kind === 'dir' ? ` and its ${tree.files.length} files` : ''}? A backup is kept; the Undo action restores it.`)) return null;
        const deleted = tree.files.length ? api.host.tryCall('workspace.transaction', { expected, deletes: tree.files, backup: true }) : null;
        if (deleted && !deleted.ok) return { display: `delete failed: ${deleted.error}` };
        if (deleted?.ok && deleted.value.backup) state.backup = { reference: deleted.value.backup, paths: tree.files };
        if (kind === 'dir') prune(path);
        return settle(state, [path, ...tree.files], parent(path) || null);
      }
      case 'undo': {
        if (!state.backup) return { display: 'Nothing to undo' };
        const { reference, paths } = state.backup;
        mkdirs(paths.map(parent));
        const restored = api.host.tryCall('workspace.restore', { backup: reference, expected: Object.fromEntries(paths.map(item => [item, null])) });
        if (!restored.ok) return { display: `undo failed: ${restored.error}` };
        state.backup = null;
        return settle(state, paths, paths[0] ?? null);
      }
      default:
        return { display: 'usage: /file open|insert|editor|new_file|new_folder|rename|move|delete|undo PATH' };
    }
  }), { description: 'File-tree actions through workspace transactions with previews and confirmation' });

  api.command('view', value => guard(() => {
    const args = words(value);
    const state = load();
    const id = args.find(word => word.startsWith('@'))?.slice(1) ?? '';
    const view = state.views[id];
    if (!view) return { display: 'Open a file in the viewer first' };
    const [op, number] = args.filter(word => !word.startsWith('@'));
    const span = view.range ? `${view.range[0]}${view.range[1] !== view.range[0] ? `-${view.range[1]}` : ''}` : String(view.line ?? 1);
    switch (op) {
      case 'line': {
        const line = Number(number);
        view.line = line;
        view.range = view.range && view.range[0] <= line && line <= view.range[1] ? view.range : [line, line];
        save(state);
        return null;
      }
      case 'insert':
        api.host.tryCall('composer.write', { insert: `${view.path}:${span} ` });
        return null;
      case 'editor': {
        const root = repository(state);
        const opened = root ? api.host.tryCall('terminal.open', { path: `${root}/${view.path}`, line: view.line ?? 1, editor: true }) : null;
        return opened?.ok ? null : { display: opened?.error ?? 'repository path unavailable' };
      }
      case 'next':
      case 'previous':
      case 'reload':
        readView(state, id, view.path, view.line, op === 'reload' ? view.start : Math.max(0, view.start + (op === 'next' ? WINDOW : -WINDOW)));
        save(state);
        return null;
      default:
        return { display: 'usage: /view line|insert|editor|next|previous|reload @PANE' };
    }
  }), { description: 'Act on the selected viewer lines' });

  api.on('component_event', event => {
    const state = load();
    const node = /^r(\.\d+)*$/.test(event.component) ? event.component.split('.').slice(1)
      .reduce<Node | undefined>((current, part) => typeof current === 'string' || !current ? undefined : kids(current)[Number(part)], state.layout.root) : undefined;
    if (node && typeof node !== 'string' && 'split' in node && event.kind === 'resize' && event.ratio?.length === node.ratio.length) {
      node.ratio = normalize(event.ratio);
      commit(state);
      return;
    }
    if (node && typeof node !== 'string' && 'tabs' in node && event.kind === 'select' && event.index !== undefined && node.tabs[event.index]) {
      node.active = event.index;
      state.layout.active = leaves(node.tabs[event.index].node)[0];
      commit(state);
      return;
    }
    const match = /^omd_panes_(p\d+)_doc_\d+$/.exec(event.component);
    const view = match && state.views[match[1]];
    if (event.kind !== 'select' || !view || !event.range) return;
    view.range = [view.start + event.range.start + 1, view.start + event.range.end + 1];
    save(state);
  });

  const restore = () => {
    const state = load();
    const saved = api.host.tryCall('store.get', { key: 'layout', scope: 'thread' });
    if (saved.ok && saved.value) {
      state.layout = saved.value.value as unknown as Layout;
      state.revision = saved.value.revision;
    } else if (saved.ok) state.revision = null;
    const keep = new Set(leaves(state.layout.root));
    for (const session of state.running.filter(item => !keep.has(item))) api.host.tryCall('terminal.pty', { action: 'stop', session });
    state.running = state.running.filter(item => keep.has(item));
    for (const id of Object.keys(state.views)) if (!keep.has(id)) delete state.views[id];
    for (const id of Object.keys(state.diffs)) if (!keep.has(id)) delete state.diffs[id];
    refresh(state, null);
    syncWatch(state);
    save(state);
  };
  api.on('start', restore);
  api.on('resume', restore);
  api.provide({ name: 'omd.panes', version: '1.0.0', methods: { tabs: { input: 'null', output: 'object' }, show_tab: { input: 'object', output: 'object' }, find: { input: 'object', output: 'object' }, cockpit: { input: 'null', output: 'object' }, open: { input: 'object', output: 'object' } } }, {
    tabs: () => {
      const { layout } = load();
      const group = groupOf(layout.root);
      return { titles: group ? group.tabs.map(item => item.title) : [], active: group?.active ?? null };
    },
    show_tab: input => {
      const shown = tab(load(), String(Number((input as { index?: number }).index) + 1), []);
      return { display: (shown as { display?: string } | null)?.display ?? null };
    },
    find: input => {
      const state = load();
      const search = input as Partial<Search>;
      state.search = typeof search.query === 'string' && search.query ? { query: label(search.query, 256), regex: search.regex === true, case: search.case === true } : null;
      save(state);
      return { views: Object.values(state.views).map(view => ({ path: view.path, matches: state.search ? matches(view.lines, state.search) : 0 })) };
    },
    cockpit: () => {
      cockpit(load());
      return { layout: 'cockpit' };
    },
    open: input => ({ display: (openFile(load(), String((input as { path?: string }).path ?? '')) as { display?: string } | null)?.display ?? null }),
  });
  api.on('channel', event => {
    const state = load();
    const find = event.data as { query: string; scope: string; paths: string[] } | null;
    if (event.channel.endsWith('/find') && find && JSON.stringify(state.find) === JSON.stringify(find.paths)) {
      try {
        const ranked = api.services.call<{ paths: string[] }>('omd.frecency', 'rank', { query: find.query, paths: find.paths }).paths;
        state.find = ranked.filter(path => !find.scope || path.startsWith(`${find.scope}/`)).slice(0, 200);
      } catch (error) {
        if (!(error instanceof Error)) throw error;
      }
    }
    syncWatch(state);
    save(state);
  });
  api.on('workspace_change', event => {
    const state = load();
    if (!has(state, 'tree') && !has(state, 'diff') && !Object.keys(state.views).length) return;
    refresh(state, event.status === 'observed' ? event.changes.map(change => change.path) : null);
    save(state);
  });

  const menu = (id: string, pane: Pane, active: boolean): TerminalComponent => {
    const options: TerminalSelectOption[] = ['focus', 'split right', 'split down', 'move left', 'move right', 'move up', 'move down', 'grow width', 'shrink width', 'grow height', 'shrink height',
      ...(pane.kind === 'shell' || pane.kind === 'browser' ? ['restart'] : []), 'close'].map(option => ({ value: option, label: option }));
    return { type: 'select', id: `omd_panes_${id}_menu`, label: `${active ? glyph.active : glyph.idle} ${titleOf(pane)}`, value: 'focus', options, action: { command: 'omd_panes:pane', args: `@${id}` } };
  };
  const treeBody = (state: State, id: string): TerminalComponent[] => {
    const rows: TerminalListRow[] = [];
    const row = (path: string, dir: boolean, depth: number, name: string): TerminalListRow => {
      const code = statusOf(state, path, dir);
      const mark = code && code !== '!!' ? ` ${code === '??' ? 'U' : code.trim()}` : '';
      const text = `${'  '.repeat(depth)}${dir ? state.expanded.includes(path) ? glyph.open : glyph.closed : '  '}${name}${dir ? '/' : ''}`;
      const color = code ? { tone: tone(code) } : {};
      return { value: path, label: name, spans: [{ text, ...color }, ...(mark ? [{ text: mark, ...color, bold: true }] : [])] };
    };
    const walk = (dir: string, depth: number) => {
      for (const name of state.listings[dir] ?? []) {
        if (rows.length >= 2_000) return;
        const folder = name.endsWith('/');
        const path = join(dir, name.replace(/\/$/, ''));
        rows.push(row(path, folder, depth, name.replace(/\/$/, '')));
        if (folder && state.expanded.includes(path)) walk(path, depth + 1);
      }
      if (state.truncated.includes(dir)) rows.push({ value: `…${dir}`, label: 'More entries', spans: [{ text: `${'  '.repeat(depth)}… more, use Find`, tone: 'muted' }] });
    };
    if (state.find) state.find.forEach(path => rows.push(row(path, false, 0, path)));
    else walk('', 0);
    const selected = state.selected;
    const around = Math.max(0, Math.min(rows.findIndex(item => item.value === selected) - ROW_LIMIT / 2, rows.length - ROW_LIMIT));
    rows.splice(0, around);
    rows.splice(ROW_LIMIT);
    const code = selected ? statusOf(state, selected, state.listings[selected] !== undefined) : undefined;
    const folder = selected !== null && state.listings[selected] !== undefined;
    const actions = selected ? [...(folder ? [] : ['open', 'editor']), 'new_file', 'new_folder', 'rename', 'move', 'delete', 'insert', ...(state.backup ? ['undo'] : [])] : [];
    return [
      { type: 'input', id: `omd_panes_${id}_find`, label: 'Find', placeholder: state.find ? `${state.find.length} matches; Enter on empty clears` : 'type and press Enter', action: { command: 'omd_panes:tree', args: 'find' } },
      { type: 'list', id: `omd_panes_${id}_body`, label: 'Files', rows, ...(selected && rows.some(item => item.value === selected) ? { selected } : {}), action: { command: 'omd_panes:tree', args: 'select' } },
      ...(selected ? [{ type: 'select' as const, id: `omd_panes_${id}_actions`, label: `${selected} (Alt+y copies)`, value: actions[0], options: actions.map(action => ({ value: `${action} ${selected}`, label: action.replace('_', ' ') })), action: { command: 'omd_panes:file' } }] : []),
      ...(selected && code && code !== '!!' && api.settings.git === true ? [{ type: 'select' as const, id: `omd_panes_${id}_git`, label: `Git ${code}`, value: `stage ${selected}`,
        options: ['stage', 'unstage', 'discard'].map(action => ({ value: `${action} ${selected}`, label: action })), action: { command: 'omd_git:act' } }] : []),
      ...(selected && !folder && api.settings.lsp === true && LANGUAGE.test(selected) ? [{ type: 'select' as const, id: `omd_panes_${id}_lsp`, label: 'Code intelligence', value: `symbols ${selected}`,
        options: ['symbols', 'diagnostics', 'format'].map(action => ({ value: `${action} ${selected}`, label: action })), action: { command: 'omd_lsp_view:lsp' } }] : []),
    ];
  };
  const matches = (lines: string[], search: Search): number | string => {
    try {
      const pattern = new RegExp(search.regex ? search.query : search.query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), search.case ? 'g' : 'gi');
      return lines.reduce((total, line) => total + [...line.matchAll(pattern)].filter(match => match[0]).length, 0);
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      return 'invalid pattern';
    }
  };
  const viewerBody = (state: State, id: string): TerminalComponent[] => {
    const view = state.views[id];
    if (!view) return [{ type: 'text', id: `omd_panes_${id}_empty`, label: 'Viewer', text: 'Open a file with /open PATH or from the file tree', tone: 'muted' }];
    if (view.error) return [{ type: 'text', id: `omd_panes_${id}_error`, label: 'Viewer error', text: `${view.path}: ${view.error}`, tone: 'failure' }];
    const width = String(view.start + view.lines.length).length;
    const document: TerminalComponent = { type: 'document', id: `omd_panes_${id}_doc_${view.revision}`, label: view.path,
      lines: view.lines.map((text, index) => [{ text: `${String(view.start + index + 1).padStart(width)} `, tone: 'muted' }, { text }]),
      anchors: view.lines.map((_, index) => String(view.start + index + 1)),
      ...(state.search ? { find: state.search } : {}),
      ...(view.line && view.line > view.start && view.line <= view.start + view.lines.length ? { selected: { start: view.line - view.start - 1, end: view.line - view.start - 1 } } : {}),
      action: { command: 'omd_panes:view', args: `line @${id}` } };
    const line = view.line;
    const text = line ? view.lines[line - view.start - 1] ?? '' : '';
    const symbols = [...new Set([...text.matchAll(/[A-Za-z_$][\w$]*/g)].filter(match => !KEYWORDS.has(match[0])).map(match => `${match[0]}:${(match.index ?? 0) + 1}`))].slice(0, 5);
    const span = view.range ? `${view.range[0]}-${view.range[1]}` : String(line);
    const paging = [...(view.start > 0 ? ['previous'] : []), ...(view.start + view.lines.length < view.total ? ['next'] : [])];
    return [
      document,
      { type: 'text', id: `omd_panes_${id}_position`, label: 'Position', text: `lines ${view.start + 1}-${view.start + view.lines.length} of ${view.total}${line ? ` · line ${line}` : ' · Enter selects a line'}${state.search ? ` · ${matches(view.lines, state.search)} matches for ${state.search.query}` : ''}`, tone: 'muted' },
      ...(line || paging.length ? [{ type: 'select' as const, id: `omd_panes_${id}_line`, label: line ? `Lines ${span}` : 'Page', value: line ? 'insert' : paging[0],
        options: [...(line ? ['insert', 'editor'] : []), ...paging, 'reload'].map(action => ({ value: action, label: action === 'insert' ? `insert ${view.path}:${span}` : action })), action: { command: 'omd_panes:view', args: `@${id}` } }] : []),
      ...(line && api.settings.lsp === true && LANGUAGE.test(view.path) ? [{ type: 'select' as const, id: `omd_panes_${id}_lsp`, label: 'Code intelligence', value: `definition ${view.path}:${line}:${symbols[0]?.split(':')[1] ?? 1}`,
        options: [...symbols.flatMap(symbol => {
          const [name, column] = symbol.split(':');
          return ['definition', 'references', 'hover'].map(action => ({ value: `${action} ${view.path}:${line}:${column}`, label: `${action} ${name}` }));
        }), ...['actions', 'symbols', 'diagnostics', 'format'].map(action => ({ value: `${action} ${view.path}:${line}`, label: action === 'actions' ? 'code actions' : action }))], action: { command: 'omd_lsp_view:lsp' } }] : []),
      ...(line && api.settings.notes === true ? [{ type: 'button' as const, id: `omd_panes_${id}_note`, label: 'Create a note from the selected lines', text: `Note from lines ${span}`, action: { command: 'omd_notes:note', args: `from ${view.path}:${span}` } }] : []),
    ];
  };
  const body = (state: State, id: string, pane: Pane): TerminalComponent[] => pane.kind === 'tree' ? treeBody(state, id)
    : pane.kind === 'viewer' ? viewerBody(state, id)
      : pane.kind === 'diff' ? [state.diffs[id] ? { type: 'diff', id: `omd_panes_${id}_body`, label: `Diff ${pane.path ?? 'HEAD'}`, unified: state.diffs[id] } : { type: 'text', id: `omd_panes_${id}_body`, label: 'Diff', text: 'No changes against HEAD', tone: 'muted' }]
        : [{ type: 'terminal', id: `omd_panes_${id}_body`, label: pane.kind === 'browser' ? 'Browser' : 'Shell', session: id }];

  api.on('terminal', () => {
    const state = load();
    const layout = state.layout;
    const sites: Record<string, TerminalRenderSite> = {};
    for (const id of leaves(layout.root)) {
      const pane = layout.panes[id];
      if (pane.kind !== 'chat' && pane.kind !== 'site') sites[siteName(id, pane)] = { mode: 'replace', components: [menu(id, pane, id === layout.active), ...body(state, id, pane)] };
    }
    const pane = (op: string): KeyAction => ({ command: 'omd_panes:pane', args: op });
    const active = layout.panes[layout.active];
    const focus = active && !['chat', 'site'].includes(active.kind) ? `omd_panes_${layout.active}_${active.kind === 'viewer' && state.views[layout.active] ? `doc_${state.views[layout.active].revision}` : 'body'}` : null;
    const keybindings: Partial<Record<KeyName, KeyAction>> = {
      'Alt+e': { command: 'omd_panes:tree' },
      'Alt+h': pane('focus left'), 'Alt+j': pane('focus down'), 'Alt+k': pane('focus up'), 'Alt+l': pane('focus right'),
      'Alt+v': pane('split right'), 'Alt+o': pane('split down'), 'Alt+x': pane('close'),
      'Alt+Shift+Left': pane('shrink width'), 'Alt+Shift+Right': pane('grow width'), 'Alt+Shift+Up': pane('shrink height'), 'Alt+Shift+Down': pane('grow height'),
      'Ctrl+Alt+Left': pane('move left'), 'Ctrl+Alt+Right': pane('move right'), 'Ctrl+Alt+Up': pane('move up'), 'Ctrl+Alt+Down': pane('move down'),
      'Alt+c': pane('tab new'), 'Alt+1': pane('tab 1'), 'Alt+2': pane('tab 2'), 'Alt+3': pane('tab 3'), 'Alt+4': pane('tab 4'), 'Alt+5': pane('tab 5'), 'Alt+6': pane('tab 6'),
      ...(focus ? { 'Alt+t': { focus } } : {}),
      ...(state.selected ? { 'Alt+y': { copy: state.selected, label: 'path' } } : {}),
    };
    return { ...(typeof layout.root === 'string' ? {} : { layout: native(layout, layout.root) }), sites, keybindings };
  });
}
