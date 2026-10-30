import type { CommandResult, Json, KeyContext, ModAPI, TerminalComponent, TerminalPatch, TerminalSpan } from '../../api.d.ts';

type Entry = [string, boolean];
type Tab = { dir: string; sel: Record<string, string> };
type Preview =
  | { kind: 'dir'; path: string; entries: Entry[] }
  | { kind: 'text'; path: string; text: string; language: string }
  | { kind: 'image'; path: string }
  | { kind: 'none'; path: string; text: string };
type Place = {
  tabs: Tab[]; tab: number; hidden: boolean; find: string | null; pending: boolean; seek: number; notice: string | null;
  parent: Entry[]; entries: Entry[]; truncated: boolean; preview: Preview | null; recent: string[]; blits: number;
};
type State = { placed: boolean; places: Record<string, Place> };

const SITE = 'omd_files/main';
const PARENT = 'omd_files_parent';
const CURRENT = 'omd_files_current';
const PREVIEW = 'omd_files_preview';
const RASTER = 'omd_files_image';
const MAX_HEIGHT = 40;
const HINTS = 'Open: l | Parent: h | Find: / | Jump: z | Tab: t | Rename: r | Delete: d | Add to prompt: @ | Keybindings: ?';
const PLACES = 2;
const TABS = 9;
const ENTRIES = 1_000;
const WINDOW = 150;
const SIDE = 100;
const READ_BYTES = 256 * 1024;
const PREVIEW_BYTES = 24_000;
const PREVIEW_LINES = 300;
const SEEK = 5;
const RECENT = 32;
const LINE_BYTES = 200;
const BUDGET = 56_000;
const IMAGES = /\.(png|jpe?g|gif|webp|heic|bmp|tiff?)$/i;
const encoder = new TextEncoder();
const size = (value: unknown) => encoder.encode(JSON.stringify(value)).length;

const limit = (text: string, bytes: number) => (encoder.encode(text).length <= bytes ? text : text.slice(0, encoder.encodeInto(text, new Uint8Array(bytes)).read));
const cut = (text: string, bytes: number) => limit(text.replace(/\t/g, '    ').replace(/[\u0000-\u001f\u007f-\u009f]/g, '?'), bytes);
const join = (dir: string, name: string) => (dir ? `${dir}/${name}` : name);
const parentOf = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf('/')));
const nameOf = (path: string) => path.slice(path.lastIndexOf('/') + 1);
const smart = (query: string, text: string) => (query === query.toLowerCase() ? text.toLowerCase() : text).includes(query);
const language = (path: string) => {
  const name = nameOf(path);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1) : name;
};

export default function activate(api: ModAPI) {
  const load = (): State => ({ placed: false, places: {}, ...(api.state.get() as Partial<State> | null) });
  const changed = <T>(change: (state: State) => T): T => {
    const state = load();
    const before = JSON.stringify(state);
    const result = change(state);
    if (JSON.stringify(state) !== before) api.state.set(state as unknown as Json);
    return result;
  };
  const root = () => api.session().root;
  const home = () => {
    const { cwd, root: top } = api.session();
    return cwd.startsWith(`${top}/`) ? cwd.slice(top.length + 1) : '';
  };

  const list = (place: Place, dir: string, limit: number): { entries: Entry[]; truncated: boolean } | string => {
    const listed = api.host.tryCall('workspace.list', { path: dir || '.', include_ignored: true, max_entries: limit });
    if (!listed.ok) return listed.error;
    const entries = listed.value.entries
      .map((entry): Entry => [nameOf(entry.path), entry.kind === 'dir'])
      .filter(([name]) => name && (place.hidden || !name.startsWith('.')))
      .sort((a, b) => Number(b[1]) - Number(a[1]) || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    return { entries, truncated: listed.value.truncated };
  };
  const tab = (place: Place) => place.tabs[place.tab];
  const index = (place: Place) => Math.max(0, place.entries.findIndex(([name]) => name === tab(place).sel[tab(place).dir]));
  const current = (place: Place) => place.entries[index(place)];

  const preview = (place: Place) => {
    place.seek = 0;
    place.blits = 0;
    const entry = current(place);
    if (!entry) {
      place.preview = null;
      return;
    }
    const path = join(tab(place).dir, entry[0]);
    if (entry[1]) {
      const listed = list(place, path, SIDE);
      place.preview = typeof listed === 'string' ? { kind: 'none', path, text: listed } : { kind: 'dir', path, entries: listed.entries };
      return;
    }
    if (IMAGES.test(path)) {
      place.preview = { kind: 'image', path };
      api.host.tryCall('events.publish', { channel: 'blit', data: path });
      return;
    }
    const stat = api.host.tryCall('workspace.stat', { paths: [path] });
    const size = stat.ok ? stat.value.files[path]?.size ?? 0 : 0;
    let text: string | null = null;
    if (size <= READ_BYTES) {
      const read = api.host.tryCall('workspace.read', { paths: [path] });
      text = read.ok ? read.value.files[path]?.text ?? null : null;
    } else {
      const head = api.host.tryCall('exec.run', { program: 'head', argv: ['-c', String(PREVIEW_BYTES), '--', path], timeout_ms: 5_000 });
      text = head.ok && head.value.exit_code === 0 ? head.value.stdout : null;
    }
    place.preview = text === null || text.includes('\u0000')
      ? { kind: 'none', path, text: `Binary file, ${size} bytes` }
      : { kind: 'text', path, text: limit(text.split('\n').slice(0, PREVIEW_LINES).join('\n'), PREVIEW_BYTES), language: language(path) };
  };
  const enter = (place: Place, dir: string, select?: string) => {
    const listed = list(place, dir, ENTRIES);
    if (typeof listed === 'string') return listed;
    const now = tab(place);
    now.dir = dir;
    if (select !== undefined) now.sel[dir] = select;
    place.entries = listed.entries;
    place.truncated = listed.truncated;
    const above = dir ? list(place, parentOf(dir), ENTRIES) : null;
    const name = nameOf(dir);
    const at = above && typeof above !== 'string' ? above.entries.findIndex(([entry]) => entry === name) : -1;
    place.parent = above && typeof above !== 'string' ? above.entries.slice(Math.max(0, at - SIDE / 2), Math.max(0, at - SIDE / 2) + SIDE) : [];
    for (const key of Object.keys(now.sel)) if (key !== dir && !dir.startsWith(`${key}/`) && Object.keys(now.sel).length > 32) delete now.sel[key];
    preview(place);
    return null;
  };
  const place = (state: State, top: string): Place => {
    const known = state.places[top];
    if (known) {
      delete state.places[top];
      state.places[top] = known;
      return known;
    }
    const fresh: Place = {
      tabs: [{ dir: home(), sel: {} }], tab: 0, hidden: false, find: null, pending: false, seek: 0, notice: null,
      parent: [], entries: [], truncated: false, preview: null, recent: [], blits: 0,
    };
    state.places[top] = fresh;
    for (const old of Object.keys(state.places).slice(0, -PLACES)) delete state.places[old];
    enter(fresh, fresh.tabs[0].dir);
    return fresh;
  };
  const select = (p: Place, at: number) => {
    const entry = p.entries[Math.max(0, Math.min(p.entries.length - 1, at))];
    if (entry) tab(p).sel[tab(p).dir] = entry[0];
    preview(p);
  };
  const jump = (p: Place, path: string) => {
    const clean = path.replace(/^\.\//, '').replace(/\/+$/, '');
    const stat = api.host.tryCall('workspace.stat', { paths: [clean] });
    if (!stat.ok || !stat.value.files[clean]) return `${clean} not found`;
    return stat.value.files[clean]?.kind === 'dir' ? enter(p, clean) : enter(p, parentOf(clean), nameOf(clean));
  };
  const find = (p: Place, step: number) => {
    if (!p.find) return 'Find first with /';
    const at = index(p);
    for (let offset = 1; offset <= p.entries.length; offset++) {
      const next = (at + step * offset + p.entries.length * offset) % p.entries.length;
      if (smart(p.find, p.entries[next][0])) {
        select(p, next);
        return null;
      }
    }
    return `No match for ${p.find}`;
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
    return !run.ok ? run.error : run.value.exit_code === 0 ? null : run.value.stderr.trim() || 'failed';
  };
  const relative = (path: string) => {
    const from = home();
    return !from ? path : path.startsWith(`${from}/`) ? path.slice(from.length + 1) : `${root()}/${path}`;
  };

  const actions = (p: Place): Record<string, [string, () => string | null]> => {
    const entry = current(p);
    const path = entry ? join(tab(p).dir, entry[0]) : null;
    const tabs = p.tabs.length > 1;
    const own: Record<string, [string, () => string | null]> = {
      h: ['Parent directory', () => (tab(p).dir ? enter(p, parentOf(tab(p).dir), nameOf(tab(p).dir)) : null)],
      j: ['Next entry', () => { select(p, index(p) + 1); return null; }],
      k: ['Previous entry', () => { select(p, index(p) - 1); return null; }],
      l: ['Enter the directory or open the file', () => open(p)],
      Enter: ['Enter the directory or open the file', () => open(p)],
      g: ['g g: first entry', () => { if (p.pending) select(p, 0); p.pending = !p.pending; return null; }],
      G: ['Last entry', () => { select(p, p.entries.length - 1); return null; }],
      J: ['Scroll the preview down', () => { p.seek = Math.min(p.seek + SEEK, p.preview?.kind === 'text' ? Math.max(0, p.preview.text.split('\n').length - 1) : p.preview?.kind === 'dir' ? Math.max(0, p.preview.entries.length - 1) : 0); return null; }],
      K: ['Scroll the preview up', () => { p.seek = Math.max(0, p.seek - SEEK); return null; }],
      t: ['New tab here', () => {
        if (p.tabs.length >= TABS) return `At most ${TABS} tabs`;
        p.tabs.splice(p.tab + 1, 0, { dir: tab(p).dir, sel: { ...tab(p).sel } });
        p.tab += 1;
        return null;
      }],
      '/': ['Find in this directory', () => {
        const query = ask('Find', 'Part of a name in this directory (lowercase ignores case)');
        if (!query) return null;
        p.find = query;
        return entry && smart(query, entry[0]) ? null : find(p, 1);
      }],
      n: ['Next match', () => find(p, 1)],
      N: ['Previous match', () => find(p, -1)],
      z: ['Jump to a frequent file', () => {
        if (!p.recent.length) return 'No frequent files yet: turn on omd_frecency and mention files with @';
        const answer = api.host.tryCall('terminal.prompt', {
          kind: 'choice', title: 'Jump', message: 'Files ranked by omd_frecency, or type a path', other: true,
          options: p.recent.map(value => ({ value, label: cut(value, 120) })),
        });
        if (!answer.ok || answer.value.status !== 'accepted') return null;
        const value = answer.value.values?.[0] ?? answer.value.value ?? '';
        const typed = answer.value.other ? p.recent.find(item => smart(value, item)) ?? value : value;
        return typed ? jump(p, typed) : null;
      }],
      r: ['Rename or move', () => {
        if (!path || !entry) return null;
        const to = ask('Rename', `New name for ${entry[0]}, or a path from the current directory to move it`);
        if (!to || to === entry[0]) return null;
        const target = join(tab(p).dir, to).replace(/\/+$/, '');
        if (target.split('/').includes('..') || to.startsWith('/')) return 'Stay inside the workspace: no .. or absolute paths';
        const error = shell('mkdir -p -- "$(dirname -- "$2")" && mv -n -- "$1" "$2" && test ! -e "$1"', [path, target]);
        return error ?? jump(p, target) ?? `Moved to ${target}`;
      }],
      d: ['Delete', () => {
        if (!path || !entry || !confirm('Delete', `Delete ${path}${entry[1] ? ' and everything in it' : ''}? It cannot be undone.`)) return null;
        return shell('rm -rf -- "$1"', [path]) ?? enter(p, tab(p).dir) ?? `Deleted ${entry[0]}`;
      }],
      '@': ['Add to the prompt', () => {
        if (!path) return null;
        const draft = api.host.tryCall('composer.read', null);
        if (!draft.ok) return draft.error;
        const write = api.host.tryCall('composer.write', { revision: draft.value.revision, edit: { kind: 'insert', text: `@${relative(path)}${entry?.[1] ? '/' : ''} ` } });
        return write.ok ? 'Added to the prompt' : write.error;
      }],
      '.': [p.hidden ? 'Hide dotfiles' : 'Show dotfiles', () => { p.hidden = !p.hidden; return enter(p, tab(p).dir); }],
    };
    if (tabs) {
      p.tabs.forEach((item, at) => { own[String(at + 1)] = [`Tab ${at + 1}: ${item.dir || '/'}`, () => switchTab(p, at)]; });
      own['['] = ['Previous tab', () => switchTab(p, (p.tab + p.tabs.length - 1) % p.tabs.length)];
      own[']'] = ['Next tab', () => switchTab(p, (p.tab + 1) % p.tabs.length)];
      own.q = ['Close this tab', () => {
        p.tabs.splice(p.tab, 1);
        return switchTab(p, Math.min(p.tab, p.tabs.length - 1));
      }];
    }
    return own;
  };
  const switchTab = (p: Place, at: number) => {
    p.tab = at;
    return enter(p, tab(p).dir);
  };
  const open = (p: Place) => {
    const entry = current(p);
    if (!entry) return null;
    const path = join(tab(p).dir, entry[0]);
    if (entry[1]) return enter(p, path);
    const editor = api.host.tryCall('terminal.open', { path, editor: true });
    if (editor.ok) return null;
    const system = api.host.tryCall('terminal.open', { path });
    return system.ok ? null : `${editor.error}; set "editor" in host.json to open files in your editor`;
  };

  const span = (text: string, extra: Partial<TerminalSpan> = {}): TerminalSpan => ({ text: cut(text, LINE_BYTES), ...extra });
  const rows = (entries: Entry[], selected: string | undefined): TerminalSpan[][] => entries.length
    ? entries.map(([name, dir]) => [span(name === selected ? '▶ ' : '  ', { tone: 'accent' }), span(dir ? `${name}/` : name, dir ? { tone: 'accent', bold: name === selected } : { bold: name === selected })])
    : [[span('empty', { tone: 'muted' })]];
  const shown = (p: Place) => {
    const at = index(p);
    const from = Math.max(0, Math.min(at - WINDOW / 2, p.entries.length - WINDOW));
    return { entries: p.entries.slice(from, from + WINDOW), at: at - from };
  };
  const filled = (lines: TerminalSpan[][], height: number) => [...lines, ...Array.from({ length: Math.max(0, height - lines.length) }, () => [span(' ')])];
  const previewOf = (p: Place, height: number, room: number): TerminalComponent => {
    const view = p.preview;
    if (!view) return { type: 'text', id: PREVIEW, label: 'Preview', text: ' ' };
    if (view.kind === 'image') return { type: 'raster', id: RASTER, label: cut(view.path, 128), alt: cut(nameOf(view.path), 200) };
    if (view.kind === 'dir') return { type: 'document', id: PREVIEW, label: cut(view.path, 128), lines: filled(rows(view.entries.slice(p.seek), undefined), height), keys: true, height };
    if (view.kind === 'none') return { type: 'text', id: PREVIEW, label: cut(view.path, 128), text: `${view.text}${'\n'.repeat(Math.max(0, height - 1))}`, tone: 'muted' };
    const lines = view.text.split('\n');
    const seek = Math.min(p.seek, Math.max(0, lines.length - 1));
    const kept: string[] = [];
    for (const item of lines.slice(seek, seek + height - 1)) {
      room -= size(item) + 2;
      if (room < 0) break;
      kept.push(cut(item, LINE_BYTES));
    }
    const above: string[] = [];
    for (const item of lines.slice(0, seek).reverse()) {
      room -= size(item) + 2;
      if (room < 0) break;
      above.unshift(cut(item, LINE_BYTES));
    }
    return { type: 'code', id: PREVIEW, label: cut(view.path, 128), text: [...above, ...kept, ...Array.from({ length: Math.max(0, height - 1 - kept.length) }, () => ' ')].join('\n') || ' ', language: view.language, start: above.length };
  };
  const column = (id: string, title: string, flex: number, active: boolean, child: TerminalComponent): TerminalComponent => ({
    type: 'box', id: `omd_files_${id}_column`, label: id, ...(title ? { title: cut(title, 128) } : {}), flex, style: { border: active ? 'thick' : 'rounded' }, children: [child],
  });
  const site = (p: Place, height: number): TerminalComponent[] => {
    const { entries, at } = shown(p);
    const name = current(p)?.[0];
    const titles = p.tabs.map((item, number) => `${number + 1} ${cut(nameOf(item.dir) || '/', 16)}  `);
    const tabs = p.tabs.length > 1;
    const tall = Math.min(MAX_HEIGHT, Math.max(3, height - 3 - (tabs ? 1 : 0)));
    const up = p.parent.findIndex(([entry]) => entry === nameOf(tab(p).dir));
    const left: TerminalComponent = { type: 'document', id: PARENT, label: 'Parent', lines: filled(rows(p.parent, nameOf(tab(p).dir)), tall), keys: true, height: tall, ...(up >= 0 ? { selected: { start: up, end: up } } : {}) };
    const middle: TerminalComponent = { type: 'document', id: CURRENT, label: cut(tab(p).dir || '/', 128), lines: filled(rows(entries, name), tall), keys: true, height: tall, selected: { start: at, end: at } };
    const status = p.notice ?? (p.pending ? 'g…' : p.find ? `/${p.find}  n next  N previous` : `${index(p) + 1}/${p.entries.length}${p.truncated ? '+' : ''}`);
    const dir = `/${tab(p).dir}`;
    const parent = tab(p).dir ? `/${tab(p).dir.split('/').slice(0, -1).join('/')}` : '';
    return [
      ...(tabs ? [{ type: 'line', id: 'omd_files_tabs', label: 'Tabs', spans: [span(titles.slice(0, p.tab).join(''), { tone: 'muted' }), span(titles[p.tab], { tone: 'accent', bold: true }), span(titles.slice(p.tab + 1).join(''), { tone: 'muted' })].filter(item => item.text) } as TerminalComponent] : []),
      {
        type: 'box', id: 'omd_files_columns', label: 'Columns', style: { direction: 'row' }, children: [
          column('parent', parent, 1, false, left),
          column('current', dir.length > 60 ? `…${dir.slice(-59)}` : dir, 4, true, middle),
          column('preview', name ?? 'Preview', 3, false, previewOf(p, tall, BUDGET - size([left, middle]))),
        ],
      },
      { type: 'line', id: 'omd_files_footer', label: 'Status', spans: [span(`${cut(status, 140)}  `, { tone: p.notice ? 'attention' : 'muted' }), span(HINTS, { tone: 'muted' })] },
    ];
  };
  const contexts = (p: Place): KeyContext[] => {
    const keys: KeyContext['keys'] = {};
    for (const [key, [label]] of Object.entries(actions(p))) keys[key] = { action: { command: 'files', args: `key ${key}` }, label: cut(label, 64) };
    return [{ when: { focus: SITE }, keys }];
  };

  api.on('terminal', ({ client }): TerminalPatch | null => {
    const state = load();
    if (!state.placed) return null;
    const p = Object.values(state.places).at(-1);
    if (!p) return null;
    return { sites: { [SITE]: { components: site(p, (client?.columns ?? 160) >= 100 ? Math.max(8, (client?.rows ?? 40) - 3) : Math.max(8, Math.floor((client?.rows ?? 40) * 0.4))) } }, key_contexts: contexts(p) };
  });

  const placed = () => {
    try {
      api.services.call('omd.workspace', 'register', { id: 'files', title: 'Files', site: SITE, order: 20 });
      const shown = api.services.call('omd.workspace', 'panels', null) as { panels?: { id: string }[] };
      return Boolean(shown.panels?.some(panel => panel.id === 'files'));
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      return false;
    }
  };
  const ranked = (p: Place) => {
    try {
      const result = api.services.call('omd.frecency', 'rank', { query: '' }) as { paths?: string[] };
      p.recent = (result.paths ?? []).filter(item => typeof item === 'string').slice(0, RECENT);
    } catch (error) {
      if (!(error instanceof Error)) throw error;
    }
  };
  const start = () => {
    api.host.tryCall('workspace.watch', { paths: ['.'], key: 'omd_files', debounce_ms: 300 });
    changed(state => {
      state.placed = placed();
      ranked(place(state, root()));
    });
  };
  api.on('start', start);
  api.on('mods_changed', start);
  api.on('turn_end', () => changed(state => ranked(place(state, root()))));
  api.on('workspace_change', ({ changes, status }) => changed(state => {
    const p = state.places[root()];
    if (!p) return;
    const dirs = new Set([tab(p).dir, parentOf(tab(p).dir), p.preview?.path ?? '']);
    if (status === 'unavailable' || changes.some(change => dirs.has(parentOf(change.path)) || change.path === p.preview?.path)) enter(p, tab(p).dir);
  }));

  const blit = () => {
    const p = load().places[root()];
    const view = p?.preview;
    if (view?.kind !== 'image') return;
    const run = api.host.tryCall('exec.run', {
      program: 'sh', timeout_ms: 10_000,
      argv: ['-c', 'out="$TMPDIR/omd-files-preview.jpg" && sips -s format jpeg -s formatOptions 50 -Z 480 "./$1" --out "$out" >/dev/null && base64 -i "$out"', 'sh', view.path],
    });
    if (!run.ok || run.value.exit_code !== 0 || run.value.stdout_preview_truncated) {
      changed(state => {
        const place = state.places[root()];
        if (place) place.notice = cut(`No image preview: ${run.ok ? run.value.stderr.trim() || 'too large' : run.error}`, 200);
      });
      return;
    }
    const shown = api.host.tryCall('terminal.blit', { key: RASTER, image: { media_type: 'image/jpeg', base64: run.value.stdout.replace(/\s/g, '') } });
    if (!shown.ok && /terminal_blit_unknown/.test(shown.error) && p.blits < 3) {
      changed(state => {
        const place = state.places[root()];
        if (place) place.blits += 1;
      });
      api.host.tryCall('events.schedule', { key: 'blit', delay_ms: 150 });
    }
  };
  api.on('channel', ({ channel }) => {
    if (channel === 'omd_files/blit') api.host.tryCall('events.schedule', { key: 'blit', delay_ms: 60 });
  });
  api.on('timer', ({ key }) => {
    if (key === 'blit') blit();
  });

  api.command('files', (args): CommandResult => {
    const [op = '', key = ''] = String(args ?? '').trim().split(/\s+/);
    const display = changed(state => {
      const p = place(state, root());
      if (op === 'key') {
        const action = actions(p)[key];
        if (!action) return null;
        const pending = p.pending;
        const notice = action[1]();
        p.notice = notice && cut(notice.replace(/\s+/g, ' '), 200);
        if (pending && key !== 'g') p.pending = false;
        return null;
      }
      if (op === 'go') {
        const notice = jump(p, String(args).trim().slice(2).trim() || '.');
        p.notice = notice && cut(notice, 200);
        return null;
      }
      return `Files panel at /${tab(p).dir}, ${p.tabs.length} tab${p.tabs.length > 1 ? 's' : ''}. Open it from the workspace dock (/workspace); ? there lists its keys. Usage: /files go PATH`;
    });
    return display === null ? null : { display };
  }, { description: 'Files panel: status, or go to a path', args_hint: 'go PATH' });
}
