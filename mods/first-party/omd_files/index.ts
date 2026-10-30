import type { CommandResult, Json, KeyContext, ModAPI, TerminalClient, TerminalComponent, TerminalPatch, TerminalSpan } from '../../api.d.ts';

type Entry = [string, boolean];
type Tab = { dir: string; sel: Record<string, string> };
type Preview =
  | { kind: 'dir'; path: string; entries: Entry[] }
  | { kind: 'text'; path: string; text: string; language: string }
  | { kind: 'image'; path: string }
  | { kind: 'none'; path: string; text: string };
type View = {
  root: string; tabs: Tab[]; tab: number; hidden: boolean; find: string | null; pending: boolean; seek: number; notice: string | null;
  parent: Entry[]; entries: Entry[]; truncated: boolean; preview: Preview | null;
};
type State = { placed: boolean; view: View | null; watch?: string };
type Action = [string, () => string | null];

const SITE = 'omd_files/main';
const PARENT = 'omd_files_parent';
const CURRENT = 'omd_files_current';
const PREVIEW = 'omd_files_preview';
const RASTER = 'omd_files_image';
const MAX_HEIGHT = 40;
const NARROW = 60;
const HINTS = 'Open: l | Parent: h | Find: / | Jump: z | Tab: t | Rename: r | Trash: d | Add to prompt: @ | Keybindings: ?';
const TABS = 9;
const SELECTIONS = 16;
const ENTRIES = 1_000;
const WINDOW = 150;
const SIDE = 100;
const READ_BYTES = 256 * 1024;
const PREVIEW_LINES = 300;
const ENTRY_BYTES = 28_000;
const PARENT_BYTES = 6_000;
const SIDE_BYTES = 4_000;
const PREVIEW_BYTES = 16_000;
const VIEW_BYTES = 64_000;
const SEEK = 5;
const RECENT = 32;
const LINE_BYTES = 200;
const BUDGET = 56_000;
const BLITS = 3;
const IMAGES = /\.(png|jpe?g|gif|webp|heic|bmp|tiff?)$/i;
const RENAME = 'mkdir -p -- "$(dirname -- "$2")" && mv -n -- "$1" "$2" && test ! -e "$1"';
const CASE_RENAME = [
  'if [ -e "$2" ] && ! [ "$1" -ef "$2" ]; then echo "$2 already exists" >&2; exit 1; fi',
  'step="$1.omd-rename-$$"',
  'mv -n -- "$1" "$step" && mv -n -- "$step" "$2" && test ! -e "$step"',
].join('\n');
const THUMBNAIL = 'dir=$(mktemp -d) && trap \'rm -rf "$dir"\' EXIT && sips -s format jpeg -s formatOptions 50 -Z 480 "./$1" --out "$dir/preview.jpg" >/dev/null && base64 -i "$dir/preview.jpg"';
const FINDER = ['-e', 'on run argv', '-e', 'tell application "Finder" to delete (POSIX file (item 1 of argv) as alias)', '-e', 'end run'];
const TRASHES: [string, string[]][] = [['/usr/bin/trash', []], ['trash', []], ['osascript', FINDER]];
const encoder = new TextEncoder();
const bytesOf = (value: unknown) => encoder.encode(JSON.stringify(value)).length;

const limit = (text: string, bytes: number) => (encoder.encode(text).length <= bytes ? text : text.slice(0, encoder.encodeInto(text, new Uint8Array(bytes)).read));
const cut = (text: string, bytes: number) => limit(text.replace(/\r/g, '').replace(/\t/g, '    ').replace(/[\u0000-\u001f\u007f-\u009f]/g, '?'), bytes);
const fitted = (text: string, bytes: number) => {
  let room = bytes;
  let kept = limit(text, room);
  while (bytesOf(kept) > bytes) {
    room = Math.floor(room * 0.8);
    kept = limit(kept, room);
  }
  return kept;
};
const within = (entries: Entry[], bytes: number) => {
  let used = 0;
  const over = entries.findIndex(([name]) => (used += bytesOf(name) + 9) > bytes);
  return over < 0 ? entries : entries.slice(0, over);
};
const join = (dir: string, name: string) => (dir ? `${dir}/${name}` : name);
const parentOf = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf('/')));
const nameOf = (path: string) => path.slice(path.lastIndexOf('/') + 1);
const smart = (query: string, text: string) => (query === query.toLowerCase() ? text.toLowerCase() : text).includes(query);
const natural = (a: Entry, b: Entry) => Number(b[1]) - Number(a[1]) || a[0].localeCompare(b[0], undefined, { sensitivity: 'base', numeric: true });
const mention = (path: string) => (/[\s"\\]|[,.;:!?)\]}'"`]$/.test(path) ? `@${JSON.stringify(path)}` : `@${path}`);
const language = (path: string) => {
  const name = nameOf(path);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1) : name;
};
const depth = (preview: Preview | null) => {
  if (preview?.kind === 'text') return preview.text.split('\n').length - 1;
  if (preview?.kind === 'dir') return preview.entries.length - 1;
  return 0;
};
const blank = (root: string, dir: string): View => ({
  root, tabs: [{ dir, sel: {} }], tab: 0, hidden: false, find: null, pending: false, seek: 0, notice: null,
  parent: [], entries: [], truncated: false, preview: null,
});
const tab = (v: View) => v.tabs[v.tab];
const index = (v: View) => Math.max(0, v.entries.findIndex(([name]) => name === tab(v).sel[tab(v).dir]));
const current = (v: View) => v.entries[index(v)];
const fit = (v: View) => {
  const shrink = [
    () => { for (const item of v.tabs) item.sel = item.dir in item.sel ? { [item.dir]: item.sel[item.dir] } : {}; },
    () => { v.parent = []; },
    () => { if (v.preview) v.preview = { kind: 'none', path: v.preview.path, text: 'Too large to preview' }; },
  ];
  for (const step of shrink) if (bytesOf(v) > VIEW_BYTES) step();
};

export default function activate(api: ModAPI) {
  const load = (): State => ({ placed: false, view: null, ...(api.state.get() as Partial<State> | null) });
  const changed = <T>(change: (state: State) => T): T => {
    const state = load();
    const before = JSON.stringify(state);
    const result = change(state);
    if (state.view) fit(state.view);
    if (JSON.stringify(state) !== before) api.state.set(state as unknown as Json);
    return result;
  };
  const root = () => api.session().root;
  const home = () => {
    const { cwd, root: top } = api.session();
    return cwd.startsWith(`${top}/`) ? cwd.slice(top.length + 1) : '';
  };

  const list = (v: View, dir: string, max: number): { entries: Entry[]; truncated: boolean } | string => {
    const listed = api.host.tryCall('workspace.list', { path: dir || '.', include_ignored: true, max_entries: max });
    if (!listed.ok) return listed.error;
    const entries = listed.value.entries
      .map((entry): Entry => [nameOf(entry.path), entry.kind === 'dir'])
      .filter(([name]) => name && (v.hidden || !name.startsWith('.')))
      .sort(natural);
    return { entries, truncated: listed.value.truncated };
  };

  const preview = (v: View) => {
    v.seek = 0;
    const entry = current(v);
    if (!entry) {
      v.preview = null;
      return;
    }
    tab(v).sel[tab(v).dir] = entry[0];
    const path = join(tab(v).dir, entry[0]);
    if (entry[1]) {
      const listed = list(v, path, SIDE);
      v.preview = typeof listed === 'string' ? { kind: 'none', path, text: listed } : { kind: 'dir', path, entries: within(listed.entries, SIDE_BYTES) };
      return;
    }
    if (IMAGES.test(path)) {
      v.preview = { kind: 'image', path };
      api.host.tryCall('events.publish', { channel: 'blit', data: path });
      return;
    }
    const stat = api.host.tryCall('workspace.stat', { paths: [path] });
    const bytes = stat.ok ? stat.value.files[path]?.size ?? 0 : 0;
    let text: string | null = null;
    if (bytes <= READ_BYTES) {
      const read = api.host.tryCall('workspace.read', { paths: [path] });
      text = read.ok ? read.value.files[path]?.text ?? null : null;
    } else {
      const head = api.host.tryCall('exec.run', { program: 'head', argv: ['-c', String(PREVIEW_BYTES), '--', path], timeout_ms: 5_000 });
      text = head.ok && head.value.exit_code === 0 ? head.value.stdout : null;
    }
    if (text === null || text.includes('\u0000')) {
      v.preview = { kind: 'none', path, text: `Binary file, ${bytes} bytes` };
      return;
    }
    const lines = text.replace(/\r\n?/g, '\n').split('\n').slice(0, PREVIEW_LINES);
    v.preview = { kind: 'text', path, text: fitted(lines.join('\n'), PREVIEW_BYTES), language: language(path) };
  };
  const enter = (v: View, dir: string, select?: string, at = v.tab) => {
    const listed = list(v, dir, ENTRIES);
    if (typeof listed === 'string') return listed;
    const entries = within(listed.entries, ENTRY_BYTES);
    const above = dir ? list(v, parentOf(dir), ENTRIES) : null;
    v.tab = at;
    const now = tab(v);
    now.dir = dir;
    if (select !== undefined) now.sel[dir] = select;
    v.entries = entries;
    v.truncated = listed.truncated || entries.length < listed.entries.length;
    v.parent = [];
    if (above && typeof above !== 'string') {
      const from = Math.max(0, above.entries.findIndex(([name]) => name === nameOf(dir)) - SIDE / 2);
      v.parent = within(above.entries.slice(from, from + SIDE), PARENT_BYTES);
    }
    for (const key of Object.keys(now.sel)) {
      if (Object.keys(now.sel).length <= SELECTIONS) break;
      if (key !== dir && !dir.startsWith(`${key}/`)) delete now.sel[key];
    }
    preview(v);
    return null;
  };
  const reach = (v: View, at: number) => {
    let dir = v.tabs[at].dir;
    let error = enter(v, dir, undefined, at);
    while (error && dir) {
      dir = parentOf(dir);
      error = enter(v, dir, undefined, at);
    }
    return error;
  };
  const viewOf = (state: State) => {
    const top = root();
    if (state.view?.root === top) return state.view;
    state.view = blank(top, home());
    reach(state.view, 0);
    return state.view;
  };

  const select = (v: View, at: number) => {
    const entry = v.entries[Math.max(0, Math.min(v.entries.length - 1, at))];
    if (entry) tab(v).sel[tab(v).dir] = entry[0];
    preview(v);
  };
  const jump = (v: View, path: string) => {
    const clean = path.replace(/^(\.\/)+/, '').replace(/\/+$/, '');
    if (clean === '' || clean === '.') return enter(v, '');
    const stat = api.host.tryCall('workspace.stat', { paths: [clean] });
    const found = stat.ok ? stat.value.files[clean] : null;
    if (!found) return `${clean} not found`;
    return found.kind === 'dir' ? enter(v, clean) : enter(v, parentOf(clean), nameOf(clean));
  };
  const find = (v: View, step: number) => {
    if (!v.find) return 'Find first with /';
    const at = index(v);
    const count = v.entries.length;
    for (let offset = 1; offset <= count; offset++) {
      const next = (at + step * offset + count) % count;
      if (smart(v.find, v.entries[next][0])) {
        select(v, next);
        return null;
      }
    }
    return `No match for ${v.find}`;
  };
  const open = (v: View) => {
    const entry = current(v);
    if (!entry) return null;
    const path = join(tab(v).dir, entry[0]);
    if (entry[1]) return enter(v, path);
    const editor = api.host.tryCall('terminal.open', { path, editor: true });
    if (editor.ok) return null;
    const system = api.host.tryCall('terminal.open', { path });
    return system.ok ? null : `${editor.error}; set "editor" in host.json to open files in your editor`;
  };

  const ask = (title: string, message: string): string | null => {
    const answer = api.host.tryCall('terminal.prompt', { kind: 'text', title, message });
    return answer.ok && answer.value.status === 'accepted' ? answer.value.value?.trim() ?? '' : null;
  };
  const confirm = (title: string, message: string) => {
    const answer = api.host.tryCall('terminal.prompt', { kind: 'confirm', title, message });
    return answer.ok && answer.value.status === 'accepted';
  };
  const shell = (script: string, args: string[]) => {
    const run = api.host.tryCall('exec.run', { program: 'sh', argv: ['-c', script, 'sh', ...args], write: true, timeout_ms: 30_000 });
    if (!run.ok) return run.error;
    return run.value.exit_code === 0 ? null : run.value.stderr.trim() || 'failed';
  };
  const trash = (path: string) => {
    const absolute = `${root()}/${path}`;
    let last = '';
    for (const [program, argv] of TRASHES) {
      const run = api.host.tryCall('exec.run', { program, argv: [...argv, absolute], sandbox: 'none', timeout_ms: 30_000 });
      if (!run.ok) {
        last = run.error;
        continue;
      }
      if (run.value.exit_code === 0) return null;
      return `${run.value.stderr.trim() || `${program} failed`}; D deletes permanently`;
    }
    return `No Trash command ran (trash or osascript: ${last}); D deletes permanently`;
  };
  const exists = (path: string) => {
    const stat = api.host.tryCall('workspace.stat', { paths: [path] });
    return stat.ok && Boolean(stat.value.files[path]);
  };
  const rename = (from: string, target: string) => {
    const caseOnly = target !== from && target.toLowerCase() === from.toLowerCase();
    if (!caseOnly && exists(target)) return `${target} already exists`;
    return shell(caseOnly ? CASE_RENAME : RENAME, [from, target]);
  };
  const relative = (path: string) => {
    const from = home();
    if (!from) return path;
    return path.startsWith(`${from}/`) ? path.slice(from.length + 1) : `${root()}/${path}`;
  };

  const ranked = (): string[] => {
    try {
      const result = api.services.call('omd.frecency', 'rank', { query: '' }) as { paths?: string[] };
      return (result.paths ?? []).filter(item => typeof item === 'string').slice(0, RECENT);
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      return [];
    }
  };
  const actions = (v: View): Record<string, Action> => {
    const entry = current(v);
    const path = entry ? join(tab(v).dir, entry[0]) : null;
    const everything = entry?.[1] ? ' and everything in it' : '';
    const own: Record<string, Action> = {
      h: ['Parent directory', () => (tab(v).dir ? enter(v, parentOf(tab(v).dir), nameOf(tab(v).dir)) : null)],
      j: ['Next entry', () => { select(v, index(v) + 1); return null; }],
      k: ['Previous entry', () => { select(v, index(v) - 1); return null; }],
      l: ['Enter the directory or open the file', () => open(v)],
      g: ['g g: first entry', () => { if (v.pending) select(v, 0); v.pending = !v.pending; return null; }],
      G: ['Last entry', () => { select(v, v.entries.length - 1); return null; }],
      J: ['Scroll the preview down', () => { v.seek = Math.max(0, Math.min(v.seek + SEEK, depth(v.preview))); return null; }],
      K: ['Scroll the preview up', () => { v.seek = Math.max(0, v.seek - SEEK); return null; }],
      t: ['New tab here', () => {
        if (v.tabs.length >= TABS) return `At most ${TABS} tabs`;
        v.tabs.splice(v.tab + 1, 0, { dir: tab(v).dir, sel: { ...tab(v).sel } });
        v.tab += 1;
        return null;
      }],
      '/': ['Find in this directory', () => {
        const query = ask('Find', 'Part of a name in this directory (lowercase ignores case)');
        if (!query) return null;
        v.find = limit(query, 128);
        return entry && smart(v.find, entry[0]) ? null : find(v, 1);
      }],
      n: ['Next match', () => find(v, 1)],
      N: ['Previous match', () => find(v, -1)],
      z: ['Jump to a frequent file', () => {
        const recent = ranked();
        if (!recent.length) return 'No frequent files yet: turn on omd_frecency and mention files with @';
        const answer = api.host.tryCall('terminal.prompt', {
          kind: 'choice', title: 'Jump', message: 'Files ranked by omd_frecency, or type a path', other: true,
          options: recent.map(value => ({ value, label: cut(value, 120) })),
        });
        if (!answer.ok || answer.value.status !== 'accepted') return null;
        const value = answer.value.values?.[0] ?? answer.value.value ?? '';
        const typed = answer.value.other ? recent.find(item => smart(value, item)) ?? value : value;
        return typed ? jump(v, typed) : null;
      }],
      r: ['Rename or move', () => {
        if (!path || !entry) return null;
        const to = ask('Rename', `New name for ${entry[0]}, or a path from the current directory to move it`);
        if (!to || to === entry[0]) return null;
        const target = join(tab(v).dir, to).replace(/\/+$/, '');
        if (target.split('/').includes('..') || to.startsWith('/')) return 'Stay inside the workspace: no .. or absolute paths';
        return rename(path, target) ?? enter(v, parentOf(target), nameOf(target)) ?? `Moved to ${target}`;
      }],
      d: ['Move to the Trash', () => {
        if (!path || !entry || !confirm('Trash', `Move ${path}${everything} to the Trash?`)) return null;
        return trash(path) ?? enter(v, tab(v).dir) ?? `Moved ${entry[0]} to the Trash`;
      }],
      D: ['Delete permanently', () => {
        if (!path || !entry || !confirm('Delete', `Delete ${path}${everything}? It cannot be undone.`)) return null;
        return shell('rm -rf -- "$1"', [path]) ?? enter(v, tab(v).dir) ?? `Deleted ${entry[0]}`;
      }],
      '@': ['Add to the prompt', () => {
        if (!path) return null;
        const draft = api.host.tryCall('composer.read', null);
        if (!draft.ok) return draft.error;
        const text = `${mention(`${relative(path)}${entry?.[1] ? '/' : ''}`)} `;
        const write = api.host.tryCall('composer.write', { revision: draft.value.revision, edit: { kind: 'insert', text } });
        return write.ok ? 'Added to the prompt' : write.error;
      }],
      '.': [v.hidden ? 'Hide dotfiles' : 'Show dotfiles', () => { v.hidden = !v.hidden; return reach(v, v.tab); }],
    };
    own.Enter = own.l;
    for (let at = 0; at < TABS; at++) {
      const item = v.tabs[at];
      own[String(at + 1)] = item
        ? [`Tab ${at + 1}: ${item.dir || '/'}`, () => reach(v, at)]
        : [`Tab ${at + 1} (t opens one)`, () => `No tab ${at + 1}: t opens one`];
    }
    if (v.tabs.length > 1) {
      own['['] = ['Previous tab', () => reach(v, (v.tab + v.tabs.length - 1) % v.tabs.length)];
      own[']'] = ['Next tab', () => reach(v, (v.tab + 1) % v.tabs.length)];
      own.q = ['Close this tab', () => {
        const closing = v.tab;
        const error = reach(v, closing + 1 < v.tabs.length ? closing + 1 : closing - 1);
        if (error) return error;
        v.tabs.splice(closing, 1);
        if (v.tab > closing) v.tab -= 1;
        return null;
      }];
    }
    return own;
  };

  const span = (text: string, extra: Partial<TerminalSpan> = {}): TerminalSpan => ({ text: cut(text, LINE_BYTES), ...extra });
  const row = ([name, dir]: Entry, selected: string | undefined): TerminalSpan[] => [
    span(name === selected ? '▶ ' : '  ', { tone: 'accent' }),
    span(dir ? `${name}/` : name, dir ? { tone: 'accent', bold: name === selected } : { bold: name === selected }),
  ];
  const rows = (entries: Entry[], selected: string | undefined): TerminalSpan[][] => (entries.length ? entries.map(entry => row(entry, selected)) : [[span('empty', { tone: 'muted' })]]);
  const shown = (v: View) => {
    const at = index(v);
    const from = Math.max(0, Math.min(at - WINDOW / 2, v.entries.length - WINDOW));
    return { entries: v.entries.slice(from, from + WINDOW), at: at - from };
  };
  const filled = (lines: TerminalSpan[][], height: number) => [...lines, ...Array.from({ length: Math.max(0, height - lines.length) }, () => [span(' ')])];
  const previewOf = (v: View, height: number, room: number): TerminalComponent => {
    const view = v.preview;
    if (!view) return { type: 'text', id: PREVIEW, label: 'Preview', text: ' ' };
    const label = cut(view.path, 128);
    if (view.kind === 'image') return { type: 'raster', id: RASTER, label, alt: cut(nameOf(view.path), 200) };
    if (view.kind === 'dir') return { type: 'document', id: PREVIEW, label, lines: filled(rows(view.entries.slice(v.seek), undefined), height), keys: true, height };
    if (view.kind === 'none') return { type: 'text', id: PREVIEW, label, text: `${view.text}${'\n'.repeat(Math.max(0, height - 1))}`, tone: 'muted' };
    const lines = view.text.split('\n');
    const seek = Math.min(v.seek, Math.max(0, lines.length - 1));
    const kept: string[] = [];
    for (const item of lines.slice(seek, seek + height - 1)) {
      room -= bytesOf(item) + 2;
      if (room < 0) break;
      kept.push(cut(item, LINE_BYTES));
    }
    const above: string[] = [];
    for (const item of lines.slice(0, seek).reverse()) {
      room -= bytesOf(item) + 2;
      if (room < 0) break;
      above.unshift(cut(item, LINE_BYTES));
    }
    const padding = Array.from({ length: Math.max(0, height - 1 - kept.length) }, () => ' ');
    const text = [...above, ...kept, ...padding].join('\n') || ' ';
    return { type: 'code', id: PREVIEW, label, text, language: view.language, start: above.length };
  };
  const column = (id: string, title: string, flex: number, active: boolean, child: TerminalComponent): TerminalComponent => ({
    type: 'box', id: `omd_files_${id}_column`, label: id, ...(title ? { title: cut(title, 128) } : {}), flex, style: { border: active ? 'thick' : 'rounded' }, children: [child],
  });
  const tabLine = (v: View): TerminalComponent => {
    const titles = v.tabs.map((item, number) => `${number + 1} ${cut(nameOf(item.dir) || '/', 16)}  `);
    const spans = [
      span(titles.slice(0, v.tab).join(''), { tone: 'muted' }),
      span(titles[v.tab], { tone: 'accent', bold: true }),
      span(titles.slice(v.tab + 1).join(''), { tone: 'muted' }),
    ];
    return { type: 'line', id: 'omd_files_tabs', label: 'Tabs', spans: spans.filter(item => item.text) };
  };
  const site = (v: View, height: number, narrow: boolean): TerminalComponent[] => {
    const { entries, at } = shown(v);
    const name = current(v)?.[0];
    const tabs = v.tabs.length > 1;
    const tall = Math.max(3, height - 3 - (tabs ? 1 : 0));
    const dir = tab(v).dir;
    const up = v.parent.findIndex(([entry]) => entry === nameOf(dir));
    const left: TerminalComponent = { type: 'document', id: PARENT, label: 'Parent', lines: filled(rows(v.parent, nameOf(dir)), tall), keys: true, height: tall, ...(up >= 0 ? { selected: { start: up, end: up } } : {}) };
    const middle: TerminalComponent = { type: 'document', id: CURRENT, label: cut(dir || '/', 128), lines: filled(rows(entries, name), tall), keys: true, height: tall, selected: { start: at, end: at } };
    const count = `${index(v) + 1}/${v.entries.length}${v.truncated ? '+' : ''}`;
    const status = v.notice ?? (v.pending ? 'g…' : v.find ? `/${v.find}  n next  N previous` : count);
    const path = `/${dir}`;
    const columns = [
      ...(narrow ? [] : [column('parent', dir ? `/${parentOf(dir)}` : '', 1, false, left)]),
      column('current', path.length > 60 ? `…${path.slice(-59)}` : path, 4, true, middle),
      column('preview', name ?? 'Preview', 3, false, previewOf(v, tall, BUDGET - bytesOf(narrow ? [middle] : [left, middle]))),
    ];
    return [
      ...(tabs ? [tabLine(v)] : []),
      { type: 'box', id: 'omd_files_columns', label: 'Columns', style: { direction: 'row' }, children: columns },
      { type: 'line', id: 'omd_files_footer', label: 'Status', spans: [span(`${cut(status, 140)}  `, { tone: v.notice ? 'attention' : 'muted' }), span(HINTS, { tone: 'muted' })] },
    ];
  };
  const contexts = (v: View): KeyContext[] => {
    const keys: KeyContext['keys'] = {};
    for (const [key, [label]] of Object.entries(actions(v))) keys[key] = { action: { command: 'files', args: `key ${key}` }, label: cut(label, 64) };
    return [{ when: { focus: SITE }, keys }];
  };
  const guess = (client: TerminalClient | null | undefined) => {
    const rows = client?.rows ?? 40;
    const height = (client?.columns ?? 160) >= 100 ? rows - 3 : Math.floor(rows * 0.4);
    return Math.min(MAX_HEIGHT + 3, Math.max(8, height));
  };

  api.on('terminal', ({ ledger, client }): TerminalPatch | null => {
    const { placed, view: v } = load();
    if (!placed || !v) return null;
    if (ledger && ledger.cwd !== v.root && !ledger.cwd.startsWith(`${v.root}/`)) return null;
    const area = client?.sites?.[SITE];
    const components = site(v, area?.rows ?? guess(client), area ? area.columns < NARROW : false);
    return { sites: { [SITE]: { components } }, key_contexts: contexts(v) };
  });

  const placed = () => {
    try {
      api.services.call('omd.workspace', 'register', { id: 'files', title: 'Files', site: SITE, order: 20 });
      const listed = api.services.call('omd.workspace', 'panels', null) as { panels?: { id: string }[] };
      return Boolean(listed.panels?.some(panel => panel.id === 'files'));
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      return false;
    }
  };
  const refresh = (state: State) => {
    if (!state.placed) return;
    const v = viewOf(state);
    reach(v, v.tab);
  };
  const start = (fresh: boolean) => {
    const watch = api.host.tryCall('workspace.watch', { paths: ['.'], key: 'omd_files', debounce_ms: 300 });
    const id = watch.ok ? watch.value.watch_id : undefined;
    changed(state => {
      const kept = !fresh && state.placed && id !== undefined && state.watch === id;
      state.watch = id;
      state.placed = placed();
      if (!kept) refresh(state);
    });
  };
  const reload = () => changed(state => {
    if (!state.placed) state.placed = placed();
    refresh(state);
  });
  api.on('start', () => start(true));
  api.on('resume', () => start(true));
  api.on('mods_changed', () => start(false));
  api.on('turn_end', reload);
  api.on('thread_settings', ({ cwd }) => {
    if (cwd.before !== cwd.after) reload();
  });
  api.on('workspace_change', ({ changes, status }) => changed(state => {
    const v = state.view;
    if (!state.placed || v?.root !== root()) return;
    const dir = tab(v).dir;
    const watched = new Set([dir, parentOf(dir), v.preview?.path ?? '']);
    const touched = changes.some(change => watched.has(parentOf(change.path)) || change.path === v.preview?.path);
    if (status === 'unavailable' || touched) reach(v, v.tab);
  }));

  const blit = (attempt: number) => {
    const view = load().view?.preview;
    if (view?.kind !== 'image') return;
    const run = api.host.tryCall('exec.run', { program: 'sh', timeout_ms: 10_000, argv: ['-c', THUMBNAIL, 'sh', view.path] });
    if (!run.ok || run.value.exit_code !== 0 || run.value.stdout_preview_truncated) {
      const reason = run.ok ? run.value.stderr.trim() || 'too large' : run.error;
      changed(state => {
        if (state.view) state.view.notice = cut(`No image preview: ${reason}`, 200);
      });
      return;
    }
    const base64 = run.value.stdout.replace(/\s/g, '');
    const drawn = api.host.tryCall('terminal.blit', { key: RASTER, image: { media_type: 'image/jpeg', base64 } });
    if (!drawn.ok && /terminal_blit_unknown/.test(drawn.error) && attempt < BLITS) {
      api.host.tryCall('events.schedule', { key: `blit${attempt + 1}`, delay_ms: 150 });
    }
  };
  api.on('channel', ({ channel }) => {
    if (channel === 'omd_files/blit') api.host.tryCall('events.schedule', { key: 'blit', delay_ms: 60 });
  });
  api.on('timer', ({ key }) => {
    if (key.startsWith('blit')) blit(Number(key.slice(4)) || 0);
  });

  api.command('files', (args): CommandResult => {
    const text = String(args ?? '').trim();
    const [op = '', key = ''] = text.split(/\s+/);
    const display = changed(state => {
      const v = viewOf(state);
      if (op === 'key') {
        const action = actions(v)[key];
        if (!action) return null;
        const pending = v.pending;
        const notice = action[1]();
        v.notice = notice && cut(notice.replace(/\s+/g, ' '), 200);
        if (pending && key !== 'g') v.pending = false;
        return null;
      }
      if (op === 'go') {
        const notice = jump(v, text.slice(2).trim());
        v.notice = notice && cut(notice, 200);
        return null;
      }
      const tabs = `${v.tabs.length} tab${v.tabs.length > 1 ? 's' : ''}`;
      return `Files panel at /${tab(v).dir}, ${tabs}. Open it from the workspace dock (/workspace); ? there lists its keys. Usage: /files go PATH`;
    });
    return display === null ? null : { display };
  }, { description: 'Files panel: status, or go to a path', args_hint: 'go PATH' });
}
