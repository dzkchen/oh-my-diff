import type { CommandResult, ComposerEdit, Json, KeyAction, KeyName, ModAPI, TerminalComponent, TerminalListRow, TerminalRenderSite, TerminalSpan, TerminalTone } from '../../api.d.ts';

type Status = 'working' | 'waiting' | 'done' | 'error';
type Thread = { id: string; name: string; cwd: string; branch: string | null; project: string; model: string | null; status: Status; updated: number; loaded: boolean };
type Shared = { status: Status; note: string | null; context: number | null; ports: number[]; brief: string | null; at: number };
type Row = { value: string; label: string; detail: string; page: string };
type Search = { query: string; regex: boolean; case: boolean };
type Picker = { kind: 'palette' | 'jump' | 'open' | 'find'; page: string; query: string; rows: Row[]; note: string | null };
type Activity = { note?: string; context?: number; ports?: number[]; brief?: string };
type Brief = { current: string; next: string; remaining: string[]; questions: string[]; estimate: string | null; at: number; thread: string | null; turn: number; objective: string | null; resumed: string | null };
type Worktree = { path: string; branch: string | null; task: string | null; issue: string | null };
type State = {
  threads: Thread[]; error: string | null; search: string; selected: string | null; current: string | null; seen: Record<string, number>;
  activity: Record<string, Activity>; worktrees: Worktree[]; picker: Picker | null; restore: string | null; drafts: Record<string, string>;
  find: Search; transcript: string[]; open: boolean; revisions: Record<string, number>;
  brief: Brief | null; cleared: string | null; hidden: boolean; turns: number; workflow: { objective: string; remaining: string[] } | null;
};

const KEYS = { palette: 'Ctrl+Alt+p', jump: 'Ctrl+Alt+g', quick_open: 'Ctrl+Alt+o', find: 'Ctrl+Alt+f', sessions: 'Ctrl+Alt+s' };
const LIST_BYTES = { picker: 32_768, dialog: 12_288, sidebar: 6_144, site: 6_144 };
const KEY = /^(Ctrl\+)?(Alt\+)?(Shift\+)?([a-z0-9]|F([2-9]|1[0-2])|Up|Down|Left|Right|Home|End|PageUp|PageDown|Delete|Insert|Enter|Backspace|Space)$/;
const PAGES: Record<string, string> = { models: 'Models', sessions: 'Sessions', actions: 'Mod actions', commands: 'Commands', skills: 'Skills', templates: 'Templates' };
const BUILTINS: [string, string, string][] = [['builtin:new', 'Session: New', 'Start a new session'], ['builtin:compact', 'Session: Compact', 'Summarize the conversation to free context'],
  ['builtin:fork', 'Session: Fork', 'Fork this session'], ['builtin:resume', 'Session: Resume…', 'Open the native session picker'], ['clear', 'Composer: Clear', 'Clear the composer; Restore brings it back'],
  ['cockpit', 'Layout: Cockpit', 'Sessions, conversation and Status/Files/Diff tabs (omd_panes)'], ['newtask', 'Worktree: New task…', 'Create a task worktree (omd_worktree)']];
const fit = (text: string, limit: number, lines = false) => {
  let out = '';
  let bytes = 0;
  for (const char of text.replace(lines ? /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g : /[\u0000-\u001f\u007f-\u009f]/g, lines ? '' : ' ')) {
    const code = char.codePointAt(0) ?? 0;
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
    if (bytes > limit) break;
    out += char;
  }
  return out;
};
const bytes = (value: unknown) => [...JSON.stringify(value)].reduce((total, char) => {
  const code = char.codePointAt(0) ?? 0;
  return total + (code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4);
}, 0);
const within = <T>(rows: T[], limit: number) => {
  let total = 0;
  return rows.filter(row => (total += bytes(row)) <= limit);
};
const FRESH_MS = 15 * 60_000;
const EXPIRED_MS = 7 * 24 * 60 * 60_000;

export default function activate(api: ModAPI) {
  const ascii = api.settings.icons === 'ascii';
  const glyph: Record<Status | 'unread' | 'group', string> = ascii ? { working: '*', waiting: '!', done: '+', error: 'x', unread: '>', group: '-' } : { working: '●', waiting: '◆', done: '✓', error: '✗', unread: '•', group: '▾' };
  const tones: Record<Status, TerminalTone> = { working: 'accent', waiting: 'attention', done: 'success', error: 'failure' };
  const empty = (): State => ({ threads: [], error: null, search: '', selected: null, current: null, seen: {}, activity: {}, worktrees: [], picker: null, restore: null, drafts: {},
    find: { query: '', regex: false, case: false }, transcript: [], open: false, revisions: {}, brief: null, cleared: null, hidden: false, turns: 0, workflow: null });
  const load = (): State => ({ ...empty(), ...(api.state.get() as Partial<State> | null) });
  const save = (state: State) => api.state.set(state as unknown as Json);
  const words = (value: Json) => String(value ?? '').trim();
  const service = <T extends Json>(call: () => Json): T | null => {
    try {
      return call() as T;
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      return null;
    }
  };
  const app = <T>(method: string, params: Json): T | null => {
    const result = api.host.tryCall('app.request', { method, params });
    return result.ok && !(result.value && typeof result.value === 'object' && 'status' in result.value && result.value.status === 'declined') ? result.value as T : null;
  };
  const base = (path: string) => path.replace(/\/+$/, '').split('/').at(-1)?.replace(/\.git$/, '') || path;
  const fuzzy = (text: string, query: string): number | null => {
    const haystack = text.toLowerCase();
    let score = 0;
    let at = -1;
    for (const char of query.toLowerCase().replace(/\s+/g, '')) {
      const next = haystack.indexOf(char, at + 1);
      if (next < 0) return null;
      score += next === at + 1 ? 2 : 0;
      at = next;
    }
    return score - at / 1000;
  };
  const rank = <T>(items: T[], query: string, text: (item: T) => string) => !query ? items
    : items.flatMap(item => {
      const score = fuzzy(text(item), query);
      return score === null ? [] : [[score, item] as const];
    }).sort((a, b) => b[0] - a[0]).map(([, item]) => item);
  const statusOf = (status: { type?: string; activeFlags?: string[] } | undefined): Status => status?.type === 'active'
    ? status.activeFlags?.length ? 'waiting' : 'working' : status?.type === 'systemError' ? 'error' : 'done';
  const keep = (next: Status, failed: boolean): Status => failed && next === 'done' ? 'error' : next;

  const flag = (state: State, brief: Brief) => state.current && brief.thread && brief.thread !== state.current ? 'forked, not revalidated'
    : brief.resumed ?? (brief.turn < state.turns ? 'stale' : null);
  const summary = (state: State) => {
    const brief = state.brief;
    if (!brief) return null;
    const mark = flag(state, brief);
    const asks = brief.questions.length;
    return fit(`${brief.current}${asks ? ` · ${asks} question${asks > 1 ? 's' : ''}` : ''}${mark ? ` (${mark})` : ''}`, 256);
  };
  const workflow = (state: State) => {
    const status = service<{ objective?: string; remaining_work?: string[] }>(() => api.services.call('omd.workflow', 'status', null));
    state.workflow = typeof status?.objective === 'string' ? { objective: fit(status.objective, 512), remaining: (status.remaining_work ?? []).slice(0, 32).map(item => fit(item, 256)) } : null;
    if (!state.brief || !state.workflow) return;
    if (state.brief.objective === null) state.brief.objective = state.workflow.objective;
    else if (state.brief.objective !== state.workflow.objective) {
      state.brief = null;
      state.cleared = 'Brief cleared: the workflow task changed';
    }
  };

  // Sessions in other OMD processes read each other's live status, ports, notes and brief summaries from the shared user-scope store.
  const share = (state: State) => {
    const thread = state.threads.find(item => item.id === state.current);
    if (!thread) return;
    const activity = state.activity[thread.id] ?? {};
    const value: Shared = { status: thread.status, note: activity.note ?? null, context: activity.context ?? null, ports: activity.ports ?? [], brief: summary(state), at: Date.now() };
    const put = api.host.tryCall('store.put', { scope: 'user', key: `s:${thread.id}`, value, expected_revision: state.revisions[thread.id] ?? null });
    if (put.ok) state.revisions[thread.id] = put.value.revision;
    if (thread.status === 'working' || thread.status === 'waiting') api.host.tryCall('events.schedule', { key: 'share', delay_ms: FRESH_MS / 3 });
  };
  const refresh = (state: State, full = true) => {
    const listed = app<{ data?: { id: string; name?: string | null; preview?: string; cwd: string; model?: string | null; status?: { type?: string; activeFlags?: string[] }; updatedAt?: number; gitInfo?: { branch?: string | null; originUrl?: string | null } | null }[] }>(
      'thread/list', { limit: 30, sortKey: 'updated_at', ...(state.search ? { searchTerm: state.search } : {}) });
    state.error = listed ? null : 'sessions are unavailable';
    if (full) state.worktrees = (service<{ worktrees: Worktree[] }>(() => api.services.call('omd.worktrees', 'list', null))?.worktrees ?? []).map(({ path, branch, task, issue }) => ({ path, branch, task, issue }));
    const failed = new Set(state.threads.filter(thread => thread.status === 'error').map(thread => `${thread.id}:${thread.updated}`));
    if (listed) state.threads = (listed.data ?? []).map(thread => ({ id: thread.id, name: fit((thread.name || thread.preview || 'untitled').replace(/\s+/g, ' '), 100), cwd: thread.cwd,
      branch: state.worktrees.find(tree => tree.path === thread.cwd)?.branch ?? thread.gitInfo?.branch ?? null,
      project: base(thread.gitInfo?.originUrl || thread.cwd), model: thread.model ?? null, status: keep(statusOf(thread.status), failed.has(`${thread.id}:${thread.updatedAt ?? 0}`)), updated: thread.updatedAt ?? 0, loaded: thread.status?.type !== 'notLoaded' }));
    for (const thread of state.threads) state.seen[thread.id] ??= thread.updated;
    if (state.current) state.seen[state.current] = Math.max(state.seen[state.current] ?? 0, state.threads.find(thread => thread.id === state.current)?.updated ?? 0);
    if (state.current && full) {
      const ports = api.host.tryCall('sessions.ports', null);
      (state.activity[state.current] ??= {}).ports = ports.ok ? ports.value.ports.map(item => item.port) : [];
    }
    const shared = api.host.tryCall('store.export', { scope: 'user' });
    const now = Date.now();
    let expired = 0;
    for (const [key, entry] of Object.entries(shared.ok ? shared.value.entries : {})) {
      const id = key.slice(2);
      const value = entry.value as Shared;
      if (!key.startsWith('s:')) continue;
      if (now - value.at > EXPIRED_MS) {
        if (expired++ < 4) api.host.tryCall('store.delete', { scope: 'user', key, expected_revision: entry.revision });
        continue;
      }
      if (id === state.current) state.revisions[id] = entry.revision;
      const thread = state.threads.find(item => item.id === id);
      if (!thread || id === state.current) continue;
      if (thread.loaded) {
        (state.activity[id] ??= {}).brief = value.brief ?? undefined;
        continue;
      }
      const fresh = now - value.at < FRESH_MS;
      if (fresh || value.status === 'done' || value.status === 'error') thread.status = value.status;
      state.activity[id] = { note: value.note ?? undefined, context: value.context ?? undefined, ports: fresh ? value.ports : [], brief: value.brief ?? undefined };
    }
    share(state);
    const ids = new Set(state.threads.map(thread => thread.id));
    for (const id of Object.keys(state.seen)) if (!ids.has(id) && id !== state.current) delete state.seen[id];
    for (const id of Object.keys(state.activity)) if (!ids.has(id) && id !== state.current) delete state.activity[id];
    for (const id of Object.keys(state.revisions)) if (!ids.has(id) && id !== state.current) delete state.revisions[id];
    return state;
  };

  const self = () => {
    const before = api.host.tryCall('store.get', { key: 'self', scope: 'thread' });
    const put = before.ok ? api.host.tryCall('store.put', { key: 'self', scope: 'thread', value: true, expected_revision: before.value?.revision ?? null }) : null;
    const read = put?.ok ? api.host.tryCall('store.get', { key: 'self', scope: 'thread' }) : null;
    return read?.ok ? read.value?.provenance.thread_id ?? null : null;
  };
  const composerText = () => {
    const read = api.host.tryCall('composer.read', null);
    return read.ok ? read.value.text : '';
  };
  const writeDraft = (edit: ComposerEdit) => {
    const read = api.host.tryCall('composer.read', null);
    if (read.ok) api.host.tryCall('composer.write', { revision: read.value.revision, edit });
  };
  const fill = (state: State, text: string) => {
    const draft = composerText();
    if (draft.trim()) state.restore = draft;
    writeDraft({ kind: 'fill', text });
  };
  const resume = (state: State, id: string): string | null => {
    if (id === state.current) return 'Already in this session';
    const draft = composerText();
    if (state.current && draft.trim()) state.drafts[state.current] = fit(draft, 4_000, true);
    const keys = Object.keys(state.drafts);
    for (const key of keys.slice(0, Math.max(0, keys.length - 16))) delete state.drafts[key];
    const invoked = api.host.tryCall('commands.invoke', { command: 'resume', args: id });
    return invoked.ok ? null : invoked.error;
  };
  const enter = (state: State, path: string): string | null => {
    const thread = state.threads.find(item => item.cwd === path);
    if (thread) return resume(state, thread.id);
    const started = app<{ thread?: { id?: string } }>('thread/start', { cwd: path });
    if (!started?.thread?.id) return `could not start a session in ${path}`;
    api.host.tryCall('terminal.show_thread', { thread_id: started.thread.id });
    return null;
  };

  const paletteRows = (state: State): Row[] => {
    const rows: Row[] = [...(state.restore ? [{ value: 'restore', label: 'Restore: Previous composer text', detail: fit(state.restore.replace(/\n/g, '⏎'), 40), page: 'root' }] : []),
      ...Object.entries(PAGES).map(([page, label]) => ({ value: `page:${page}`, label, detail: 'open', page: 'root' })),
      ...BUILTINS.map(([value, label, detail]) => ({ value, label, detail, page: 'root' }))];
    const inventory = api.host.tryCall('commands.list', null);
    const commands = inventory.ok ? inventory.value.commands.filter(item => !item.hidden) : [];
    for (const item of commands) rows.push(item.owner ? { value: `mod:${item.command}`, label: `/${item.command}`, detail: item.description, page: 'actions' } : { value: `cmd:${item.command}`, label: `/${item.command}`, detail: item.description, page: 'commands' });
    const skills = app<{ data?: { skills?: { name: string; description?: string; shortDescription?: string | null }[] }[] }>('skills/list', {});
    for (const skill of (skills?.data ?? []).flatMap(entry => entry.skills ?? [])) rows.push({ value: `skill:${skill.name}`, label: `$${skill.name}`, detail: skill.shortDescription || skill.description || '', page: 'skills' });
    if (commands.some(item => item.command === 'omd_project_pi_prompts:pi')) {
      const templates = api.host.tryCall('workspace.list', { path: '.pi/prompts', max_entries: 200 });
      for (const entry of templates.ok ? templates.value.entries : []) if (entry.kind === 'file' && entry.path.endsWith('.md')) rows.push({ value: `template:${base(entry.path).slice(0, -3)}`, label: base(entry.path).slice(0, -3), detail: entry.path, page: 'templates' });
    }
    const models = app<{ data?: { model: string; displayName?: string; description?: string; hidden?: boolean }[] }>('model/list', { limit: 100 });
    for (const model of (models?.data ?? []).filter(item => !item.hidden)) rows.push({ value: `model:${model.model}`, label: model.displayName || model.model, detail: model.description ?? '', page: 'models' });
    for (const thread of state.threads) rows.push({ value: `session:${thread.id}`, label: thread.name, detail: `${thread.project}${thread.branch ? ` · ${thread.branch}` : ''}${thread.id === state.current ? ' · current' : ''}`, page: 'sessions' });
    return rows;
  };
  const jumpRows = (state: State): Row[] => {
    const tabs = service<{ titles: string[]; active: number | null }>(() => api.services.call('omd.panes', 'tabs', null));
    return [...state.threads.map(thread => ({ value: `session:${thread.id}`, label: thread.name, detail: `session · ${thread.project}${thread.branch ? ` · ${thread.branch}` : ''}`, page: 'root' })),
      ...state.worktrees.map(tree => ({ value: `worktree:${tree.path}`, label: tree.task ?? tree.branch ?? base(tree.path), detail: `worktree · ${tree.path}`, page: 'root' })),
      ...(tabs?.titles ?? []).map((title, index) => ({ value: `tab:${index}`, label: title, detail: `tab ${index + 1}${index === tabs?.active ? ' · active' : ''}`, page: 'root' }))];
  };
  const fileRows = (query: string): Row[] => {
    const pattern = `:(icase)*${[...query.replace(/\s+/g, '')].map(char => char.replace(/[*?[\]\\]/g, '\\$&')).join('*')}*`;
    const list = (ignored: boolean) => {
      const run = api.host.tryCall('exec.run', { program: 'git', argv: ['-c', 'core.quotepath=false', 'ls-files', '-z', '--others', '--exclude-standard', ...(ignored ? ['--ignored'] : ['--cached']), '--', pattern], timeout_ms: 10_000 });
      if (!run.ok || run.value.exit_code !== 0) return [];
      const paths = run.value.stdout.split('\0');
      return [...new Set(paths.slice(0, run.value.stdout_preview_truncated ? -1 : undefined).filter(Boolean))].slice(0, 2_000);
    };
    const tracked = list(false);
    const ranked = service<{ paths: string[] }>(() => api.services.call('omd.frecency', 'rank', { query, paths: tracked.slice(0, 500) }))?.paths ?? rank(tracked, query, path => `${base(path)} ${path}`);
    const short = (path: string) => fit(path, 240) === path;
    return [...ranked.filter(short).slice(0, 150).map(path => ({ value: `file:${path}`, label: path, detail: '', page: 'root' })),
      ...rank(list(true).filter(short), query, path => `${base(path)} ${path}`).slice(0, 50).map(path => ({ value: `file:${path}`, label: path, detail: 'ignored', page: 'root' }))];
  };
  const transcript = (state: State) => {
    const read = (view: string) => state.current ? app<{ data?: { items?: { type: string; text?: string; content?: { type: string; text?: string }[]; command?: string; aggregatedOutput?: string | null }[] }[] }>('thread/turns/list', { threadId: state.current, limit: 20, itemsView: view }) : null;
    const turns = read('full') ?? read('summary');
    state.transcript = (turns?.data ?? []).slice().reverse().flatMap(turn => (turn.items ?? []).flatMap(item => {
      const text = item.type === 'userMessage' ? `› ${(item.content ?? []).map(part => part.text ?? '').join(' ')}` : item.type === 'agentMessage' ? item.text ?? ''
        : item.type === 'commandExecution' ? `$ ${item.command ?? ''}\n${(item.aggregatedOutput ?? '').slice(-2_000)}` : '';
      return text ? text.split('\n') : [];
    })).map(line => fit(line, 300)).slice(-2_000);
    let bytes = 0;
    state.transcript = state.transcript.reverse().filter(line => (bytes += line.length * 3) <= 40_000).reverse();
  };
  const count = (lines: string[], search: Search): number | string => {
    try {
      const pattern = new RegExp(search.regex ? search.query : search.query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), search.case ? 'g' : 'gi');
      return lines.reduce((total, line) => total + [...line.matchAll(pattern)].filter(match => match[0]).length, 0);
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      return 'invalid pattern';
    }
  };
  const findNote = (state: State) => {
    const panes = service<{ views: { path: string; matches: number | string }[] }>(() => api.services.call('omd.panes', 'find', state.find as unknown as Json));
    return state.find.query ? `transcript ${count(state.transcript, state.find)}${(panes?.views ?? []).map(view => ` · ${view.path} ${view.matches}`).join('')}` : null;
  };

  const open = (kind: Picker['kind']): CommandResult => {
    const state = load();
    if (state.picker?.kind === kind) {
      state.picker = null;
      save(state);
      return null;
    }
    if (kind !== 'open') refresh(state);
    if (kind === 'find') transcript(state);
    state.picker = { kind, page: 'root', query: kind === 'find' ? state.find.query : '', rows: kind === 'palette' ? paletteRows(state) : kind === 'jump' ? jumpRows(state) : [], note: kind === 'find' ? findNote(state) : null };
    save(state);
    return null;
  };
  api.command('palette', () => open('palette'), { description: 'Command palette: commands, mod actions, skills, templates, models and sessions (Ctrl+Alt+P)' });
  api.command('jump', () => open('jump'), { description: 'Jump to a session, worktree or tab (Ctrl+Alt+G)' });
  api.command('quick_open', value => {
    const query = words(value);
    if (!query) return open('open');
    const state = load();
    state.picker = { kind: 'open', page: 'root', query: fit(query, 256), rows: fileRows(query), note: null };
    save(state);
    return null;
  }, { description: 'Quick open a file: tracked first, ignored second (Ctrl+Alt+O)' });
  api.command('find', value => {
    const query = words(value);
    if (!query) return open('find');
    const state = load();
    state.find = { ...state.find, query: fit(query, 256) };
    transcript(state);
    state.picker = { kind: 'find', page: 'root', query: state.find.query, rows: [], note: findNote(state) };
    save(state);
    return null;
  }, { description: 'Find in the transcript and open panes, with case and regex options (Ctrl+Alt+F)' });

  const visible = (picker: Picker): Row[] => {
    if (picker.kind === 'open') return picker.rows;
    const own = picker.rows.filter(row => row.page === picker.page);
    const pool = picker.page === 'root' && picker.query ? picker.rows : own;
    return [...(picker.page === 'root' ? [] : [{ value: 'back', label: '‹ Back', detail: 'Command palette', page: picker.page }]),
      ...rank(pool, picker.query, row => `${row.label} ${row.detail}`).map(row => picker.page === 'root' && picker.query && row.page !== 'root' ? { ...row, detail: `${PAGES[row.page]} › ${row.detail}` } : row)];
  };
  const run = (state: State, value: string): string | null => {
    const picker = state.picker;
    const [kind, ...rest] = value.split(':');
    const target = rest.join(':');
    if (!picker) return null;
    if (kind === 'page') {
      picker.page = target;
      picker.query = '';
      return null;
    }
    if (value === 'back') {
      picker.page = 'root';
      picker.query = '';
      return null;
    }
    state.picker = null;
    if (value === 'restore') {
      writeDraft({ kind: 'fill', text: state.restore ?? '' });
      state.restore = null;
      return null;
    }
    if (value === 'clear') {
      fill(state, '');
      return null;
    }
    if (value === 'cockpit') return service(() => api.services.call('omd.panes', 'cockpit', null)) ? null : 'Enable omd_panes for the cockpit layout';
    if (value === 'newtask') {
      fill(state, '/omd_worktree:task ');
      return null;
    }
    if (kind === 'builtin' || kind === 'cmd') {
      const invoked = api.host.tryCall('commands.invoke', { command: target });
      if (!invoked.ok || 'status' in invoked.value) fill(state, `/${target} `);
      return null;
    }
    if (kind === 'mod') { const invoked = api.host.tryCall('commands.invoke', { command: target }); if (invoked.ok && !('status' in invoked.value)) return null; }
    const text = kind === 'mod' ? `/${target} ` : kind === 'skill' ? `$${target} ` : kind === 'template' ? `/omd_project_pi_prompts:pi ${target} ` : null;
    if (text) {
      fill(state, text);
      return null;
    }
    if (kind === 'model') {
      if (state.current && app('thread/settings/update', { threadId: state.current, model: target })) return `Model: ${target}`;
      api.host.tryCall('commands.invoke', { command: 'model' });
      return `${target} is not a configured route here; choose it in /model`;
    }
    if (kind === 'session') return resume(state, target);
    if (kind === 'worktree') return enter(state, target);
    if (kind === 'tab') return (service<{ display: string | null }>(() => api.services.call('omd.panes', 'show_tab', { index: Number(target) })))?.display ?? null;
    if (kind === 'file') {
      const shown = service<{ display: string | null }>(() => api.services.call('omd.panes', 'open', { path: target }));
      if (!shown) writeDraft({ kind: 'insert', text: `@${target} ` });
      return shown?.display ?? null;
    }
    return null;
  };
  api.command('pick', value => {
    const text = words(value);
    const state = load();
    const picker = state.picker;
    if (!picker || text === 'close') {
      state.picker = null;
      save(state);
      return null;
    }
    const [op, ...rest] = text.split(' ');
    const argument = rest.join(' ');
    let message: string | null = null;
    if (op === 'query') {
      const rows = visible(picker);
      if (picker.kind === 'find') {
        state.find.query = fit(argument, 256);
        picker.query = state.find.query;
        picker.note = findNote(state);
      } else if (argument === picker.query && argument && rows.some(row => row.value !== 'back')) message = run(state, rows.find(row => row.value !== 'back')!.value);
      else if (picker.kind === 'open') {
        picker.query = fit(argument, 256);
        picker.rows = argument ? fileRows(argument) : [];
      } else picker.query = fit(argument, 256);
    } else if (op === 'run') message = run(state, argument);
    else if (op === 'mode' || op === 'case') {
      state.find = { ...state.find, ...(op === 'mode' ? { regex: argument === 'regex' } : { case: argument === 'match' }) };
      picker.note = findNote(state);
    }
    save(state);
    return message ? { display: message } : null;
  }, { description: 'Drive the open picker' });

  api.command('sessions', value => {
    const text = words(value);
    const state = load();
    const [op, ...rest] = text.split(' ');
    const argument = rest.join(' ');
    let message: string | null = null;
    if (op === 'search') state.search = argument;
    if (op === 'select') state.selected = argument;
    if (op === 'act') {
      const [action, id] = argument.split(' ');
      const thread = state.threads.find(item => item.id === id);
      if (action === 'switch' && thread) message = resume(state, thread.id);
      else if (action === 'fork') api.host.tryCall('commands.invoke', { command: 'fork' });
      else if (action === 'new') api.host.tryCall('commands.invoke', { command: 'new' });
      else if (action === 'here' && thread) message = enter({ ...state, threads: [] }, thread.cwd);
    }
    if (op === '' || op === 'toggle') state.open = !state.open;
    if (op !== 'select' && op !== 'act') refresh(state);
    save(state);
    if (op === 'list') return { display: state.threads.map(thread => {
      const brief = briefOf(state, thread);
      return `${glyph[thread.status]} ${thread.name}  ${thread.project}${thread.branch ? `/${thread.branch}` : ''}  ${thread.id}${brief ? `  “${brief}”` : ''}`;
    }).join('\n') || state.error || 'no sessions' };
    return message ? { display: message } : null;
  }, { description: 'Toggle the session list, or search|select|act|list|refresh it (Ctrl+Alt+S)' });

  const briefOf = (state: State, thread: Thread) => thread.id === state.current ? summary(state) : state.activity[thread.id]?.brief ?? null;
  const unread = (state: State, thread: Thread) => thread.id !== state.current && thread.updated > (state.seen[thread.id] ?? 0);
  const sessionRows = (state: State): TerminalListRow[] => {
    const groups = new Map<string, Thread[]>();
    for (const thread of state.threads) groups.set(thread.project, [...groups.get(thread.project) ?? [], thread]);
    return [...groups].flatMap(([project, threads]) => [{ value: `group:${project}`, label: `Project ${project}`, spans: [{ text: `${glyph.group} ${project} (${threads.length})`, tone: 'muted' as const, bold: true }] },
      ...threads.map(thread => {
        const activity = state.activity[thread.id] ?? {};
        const tree = state.worktrees.find(item => item.path === thread.cwd);
        const brief = briefOf(state, thread);
        const detail = [base(thread.cwd), thread.model, activity.context !== undefined ? `ctx ${activity.context}%` : null, activity.ports?.length ? activity.ports.map(port => `:${port}`).join(' ') : null, activity.note].filter(Boolean).join(' · ');
        const spans: TerminalSpan[] = [
          { text: `${unread(state, thread) ? glyph.unread : ' '}${glyph[thread.status]} `, tone: tones[thread.status] },
          { text: fit(thread.name, 60), bold: thread.id === state.current || unread(state, thread) },
          ...(thread.branch ? [{ text: fit(` ${thread.branch}`, 40), tone: 'accent' as const }] : []),
          ...(tree?.issue ? [{ text: fit(` #${tree.issue}`, 20), tone: 'accent' as const }] : [])];
        const room = () => 256 - spans.reduce((total, span) => total + [...span.text].length, 0);
        if (brief) spans.push({ text: fit(`  “${brief}”`, Math.min(100, room() - 30)) });
        spans.push({ text: fit(`  ${detail}`, Math.min(120, room())), tone: 'muted' });
        return { value: thread.id, label: `${thread.status}${unread(state, thread) ? ' unread' : ''} ${thread.name}`, spans };
      })]);
  };
  const sessionList = (state: State, height: number, site: keyof typeof LIST_BYTES): TerminalComponent[] => {
    const selected = state.threads.find(thread => thread.id === state.selected);
    return [
      { type: 'input', id: `omd_layout_${site}_session_search`, label: 'Search sessions', value: state.search, placeholder: 'search titles; Enter applies', action: { command: 'omd_layout:sessions', args: 'search' } },
      state.error ? { type: 'text', id: `omd_layout_${site}_sessions_error`, label: 'Sessions unavailable', text: state.error, tone: 'muted' }
        : { type: 'list', id: `omd_layout_${site}_sessions`, label: 'Sessions', rows: within(sessionRows(state).slice(0, 200), LIST_BYTES[site]), ...(height ? { height } : {}), ...(selected ? { selected: selected.id } : {}), action: { command: 'omd_layout:sessions', args: 'select' } },
      ...(selected ? [{ type: 'select' as const, id: `omd_layout_${site}_session_actions`, label: fit(selected.name, 128), value: `act switch ${selected.id}`,
        options: [['switch', 'switch to it'], ...(selected.id === state.current ? [['fork', 'fork it']] : []), ['here', 'new session in its folder'], ['new', 'new session']].map(([action, label]) => ({ value: `act ${action} ${selected.id}`, label })),
        action: { command: 'omd_layout:sessions' } }] : []),
    ];
  };
  const pickerSite = (state: State, picker: Picker): TerminalRenderSite => {
    const titles = { palette: 'Command palette', jump: 'Jump', open: 'Quick open', find: 'Find' };
    const title = [titles[picker.kind], ...(picker.page === 'root' ? [] : [PAGES[picker.page]])].join(' › ');
    const rows = visible(picker).slice(0, 200);
    const listed = within(rows.map(row => ({ value: row.value, label: fit(`${row.label} ${row.detail}`, 256), spans: [{ text: fit(row.label, 120), bold: row.value.startsWith('page:') }, ...(row.detail ? [{ text: fit(`  ${row.detail}`, 120), tone: 'muted' as const }] : [])] })), LIST_BYTES.picker);
    const children: TerminalComponent[] = picker.kind === 'find' ? [
      { type: 'input', id: 'omd_layout_query', label: 'Find', value: picker.query, placeholder: 'text or pattern; Enter searches', action: { command: 'omd_layout:pick', args: 'query' } },
      { type: 'select', id: 'omd_layout_find_mode', label: 'Match', value: `mode ${state.find.regex ? 'regex' : 'plain'}`, options: [{ value: 'mode plain', label: 'plain text' }, { value: 'mode regex', label: 'regular expression' }], action: { command: 'omd_layout:pick' } },
      { type: 'select', id: 'omd_layout_find_case', label: 'Case', value: `case ${state.find.case ? 'match' : 'ignore'}`, options: [{ value: 'case ignore', label: 'ignore case' }, { value: 'case match', label: 'match case' }], action: { command: 'omd_layout:pick' } },
      ...(picker.note ? [{ type: 'text' as const, id: 'omd_layout_find_counts', label: 'Matches', text: picker.note, tone: 'accent' as const }] : []),
      { type: 'document', id: `omd_layout_transcript_${state.transcript.length}`, label: 'Transcript', lines: state.transcript.map(text => [{ text }]), height: 14,
        ...(state.find.query ? { find: state.find } : {}) },
    ] : [
      { type: 'input', id: 'omd_layout_query', label: 'Search', value: picker.query, placeholder: 'type and Enter to filter; Enter again runs the first match; Tab reaches the list', action: { command: 'omd_layout:pick', args: 'query' } },
      { type: 'list', id: 'omd_layout_rows', label: title, height: 14, rows: listed,
        action: { command: 'omd_layout:pick', args: 'run' } },
      ...(picker.note ? [{ type: 'text' as const, id: 'omd_layout_note', label: 'Note', text: picker.note, tone: 'muted' as const }] : []),
    ];
    return { mode: 'replace', components: [{ type: 'dialog', id: 'omd_layout_picker', label: title, title, children: [...children,
      { type: 'button', id: 'omd_layout_close', label: `Close the ${titles[picker.kind].toLowerCase()}`, text: 'Close', action: { command: 'omd_layout:pick', args: 'close' } }] }] };
  };

  const STATES: Record<Status, string> = { working: 'Working', waiting: 'Waiting for you', done: 'Idle', error: 'Last turn failed' };
  const age = (at: number) => {
    const minutes = Math.floor((Date.now() - at) / 60_000);
    return minutes < 1 ? 'just now' : minutes < 60 ? `${minutes}m ago` : minutes < 2_880 ? `${Math.floor(minutes / 60)}h ago` : `${Math.floor(minutes / 1_440)}d ago`;
  };
  const briefLines = (state: State) => {
    const line = (id: string, label: string, text: string, tone: TerminalTone = 'normal') => ({ type: 'text' as const, id: `omd_layout_brief_${id}`, label, text: fit(text, 512), tone });
    const lines = (id: string, label: string, items: string[], tone: TerminalTone = 'normal') => ({ ...line(id, label, '', tone), text: fit(items.join('\n'), 4096, true) });
    const thread = state.threads.find(item => item.id === state.current);
    const brief = state.brief;
    const mark = brief && flag(state, brief);
    return [
      ...(thread ? [line('state', 'Session state', `Session: ${STATES[thread.status]}`, tones[thread.status])] : []),
      ...(state.workflow ? [line('task', 'Workflow objective', `Workflow task: ${state.workflow.objective}`, 'accent'),
        line('workflow', 'Workflow remaining work', `Workflow: ${state.workflow.remaining.length} remaining`, 'accent')] : []),
      ...(!brief ? [line('none', 'Agent brief', state.cleared ?? 'No agent brief yet', 'muted')] : [
        line('age', 'Agent brief age', `Agent brief · ${age(brief.at)}${mark ? ` · ${mark}` : ''}`, mark ? 'attention' : 'muted'),
        line('current', 'Current work', `Now: ${brief.current}`),
        line('next', 'Next step', `Next: ${brief.next}`),
        ...(brief.remaining.length ? [lines('remaining', 'Remaining tasks', brief.remaining.map(item => `- ${item}`))] : []),
        ...(brief.questions.length ? [lines('questions', 'Open questions', brief.questions.map(item => `? ${item}`), 'attention')] : []),
        line('estimate', 'Completion estimate', brief.estimate ? `Estimate (declared): ${brief.estimate}` : 'Estimate: unknown', 'muted')]),
    ];
  };
  api.command('brief', value => {
    const op = words(value);
    const state = load();
    if (op === 'hide') state.hidden = true;
    else if (op === 'clear') {
      state.brief = null;
      state.cleared = 'Brief cleared';
      share(state);
    } else if (op === '' || op === 'show') state.hidden = false;
    else return { display: 'usage: /omd_layout:brief [show|hide|clear]' };
    save(state);
    return { display: op === 'hide' ? 'Brief panel hidden; /omd_layout:brief shows it' : op === 'clear' ? 'Brief cleared' : briefLines(state).map(item => item.text).join('\n') };
  }, { description: 'Show, hide or clear this session\'s agent brief' });

  const text = (value: Json | undefined, limit: number, name: string) => {
    if (typeof value !== 'string' || !value.trim() || [...value].length > limit) throw new Error(`brief_field_invalid: ${name} must be a non-empty string of at most ${limit} characters`);
    return fit(value.trim(), limit * 4);
  };
  const texts = (value: Json | undefined, count: number, limit: number, name: string) => {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.length > count) throw new Error(`brief_field_invalid: ${name} takes at most ${count} items`);
    return value.map(item => text(item, limit, name));
  };
  api.tool({ name: 'brief', description: 'Replace this session\'s brief, shown to the user beside the conversation and as its session-list summary: current work, next step, remaining tasks and questions or decisions that need the user. Update it when the plan or task changes; it records your own account and grants nothing. Give an estimate only when you can declare one.',
    parameters: { type: 'object', properties: {
      current: { type: 'string', description: 'What you are working on now, one line of at most 200 characters' },
      next: { type: 'string', description: 'The next step, at most 200 characters' },
      remaining: { type: 'array', items: { type: 'string' }, description: 'Remaining tasks, at most 12 of 160 characters' },
      questions: { type: 'array', items: { type: 'string' }, description: 'Questions or decisions that need the user, at most 6 of 200 characters' },
      estimate: { type: 'string', description: 'An explicitly declared completion estimate of at most 40 characters; omit when unknown' },
    }, required: ['current', 'next'], additionalProperties: false } }, input => {
    const args = (input && typeof input === 'object' && !Array.isArray(input) ? input : {}) as Record<string, Json>;
    const fields = { current: text(args.current, 200, 'current'), next: text(args.next, 200, 'next'), remaining: texts(args.remaining, 12, 160, 'remaining'),
      questions: texts(args.questions, 6, 200, 'questions'), estimate: args.estimate === undefined ? null : text(args.estimate, 40, 'estimate') };
    const state = load();
    state.current = self() ?? state.current;
    workflow(state);
    state.brief = { ...fields, at: Date.now(), thread: state.current, turn: state.turns, objective: state.workflow?.objective ?? null, resumed: null };
    state.cleared = null;
    share(state);
    save(state);
    return { updated: true };
  });

  const keys = (): Partial<Record<KeyName, KeyAction>> => {
    const configured = (api.settings.keys && typeof api.settings.keys === 'object' && !Array.isArray(api.settings.keys) ? api.settings.keys : {}) as Record<string, Json>;
    const bindings: Partial<Record<KeyName, KeyAction>> = {};
    for (const [action, fallback] of Object.entries(KEYS)) {
      const key = typeof configured[action] === 'string' ? configured[action] as string : fallback;
      const match = KEY.exec(key);
      if (match && (match[1] || match[2] || match[5]) && !['Ctrl+c', 'Ctrl+d', 'Ctrl+z', 'Ctrl+h', 'Ctrl+i', 'Ctrl+j', 'Ctrl+m'].includes(key)) bindings[key as KeyName] = { command: `omd_layout:${action}` };
    }
    return bindings;
  };
  api.on('terminal', ({ ledger }) => {
    const state = load();
    if (ledger?.thread_id && ledger.thread_id !== state.current) {
      state.current = ledger.thread_id;
      state.seen[state.current] = Math.max(state.seen[state.current] ?? 0, state.threads.find(thread => thread.id === state.current)?.updated ?? 0);
      save(state);
    }
    const sites: Record<string, TerminalRenderSite> = { 'omd_layout/sessions': { mode: 'replace', components: sessionList(state, 0, 'site') } };
    if (api.settings.sidebar !== false) sites.sidebar = { mode: 'wrap', components: [{ type: 'pane', id: 'omd_layout_sidebar', label: 'Sessions panel', title: 'Sessions', children: sessionList(state, 10, 'sidebar') },
      ...(state.hidden ? [] : [{ type: 'pane' as const, id: 'omd_layout_brief', label: 'Brief panel', title: 'Brief', children: briefLines(state) }]), { type: 'slot' }] };
    if (state.picker) sites.dialog = pickerSite(state, state.picker);
    else if (state.open) sites.dialog = { mode: 'replace', components: [{ type: 'dialog', id: 'omd_layout_sessions_dialog', label: 'Sessions', title: 'Sessions', children: [...sessionList(state, 16, 'dialog'),
      { type: 'button', id: 'omd_layout_sessions_close', label: 'Close the session list', text: 'Close', action: { command: 'omd_layout:sessions', args: 'toggle' } }] }] };
    const working = state.threads.filter(thread => thread.status === 'working').length;
    const waiting = state.threads.filter(thread => thread.status === 'waiting').length;
    const fresh = state.threads.filter(thread => unread(state, thread)).length;
    const status = [working ? `${working} working` : '', waiting ? `${waiting} waiting` : '', fresh ? `${fresh} unread` : ''].filter(Boolean).join(' · ');
    return { sites, keybindings: keys(), ...(status ? { status: [fit(status, 40)] } : {}) };
  });

  api.on('start', () => save(refresh(load())));
  api.on('resume', ({ thread_id, last_turn, restarted }) => {
    const state = load();
    state.current = thread_id;
    if (state.brief && restarted) state.brief.resumed = last_turn?.status === 'in_progress' ? 'resumed after an unfinished turn' : 'resumed, not revalidated';
    refresh(state);
    const draft = state.drafts[thread_id];
    if (draft) {
      delete state.drafts[thread_id];
      if (!composerText().trim()) writeDraft({ kind: 'fill', text: draft });
    }
    save(state);
  });
  api.on('idle', () => {
    const state = load();
    workflow(state);
    save(refresh(state, false));
  });
  api.on('turn_start', () => {
    const state = load();
    state.turns += 1;
    workflow(state);
    const thread = state.threads.find(item => item.id === state.current);
    if (thread) thread.status = 'working';
    share(state);
    save(state);
  });
  api.on('timer', () => {
    const state = load();
    share(state);
    save(state);
  });
  api.on('app_notification', ({ method, params, thread_id }) => {
    const state = load();
    const data = (params ?? {}) as { threadId?: string; status?: { type?: string; activeFlags?: string[] }; turn?: { status?: string }; tokenUsage?: { last?: { totalTokens?: number }; modelContextWindow?: number | null }; delta?: string; name?: string | null; error?: { message?: string } };
    const id = data.threadId ?? thread_id;
    if (!id) return;
    const activity = state.activity[id] ??= {};
    const thread = state.threads.find(item => item.id === id);
    if (method === 'thread/status/changed' && thread) {
      thread.status = keep(statusOf(data.status), thread.status === 'error');
      if (thread.status === 'waiting') activity.note = data.status?.activeFlags?.includes('waitingOnApproval') ? 'needs approval' : 'needs input';
    }
    if (method === 'turn/completed') {
      activity.note = `turn ${data.turn?.status ?? 'completed'}`;
      if (thread) {
        thread.status = data.turn?.status === 'failed' ? 'error' : 'done';
        thread.updated = Math.max(thread.updated, (state.seen[id] ?? 0) + 1);
      }
    }
    if (method === 'thread/name/updated' && thread && data.name) thread.name = fit(data.name, 80);
    if (method === 'error') activity.note = fit(data.error?.message ?? 'error', 80);
    if (method === 'thread/tokenUsage/updated' && data.tokenUsage?.modelContextWindow) activity.context = Math.round(100 * (data.tokenUsage.last?.totalTokens ?? 0) / data.tokenUsage.modelContextWindow);
    if (id === state.current && thread) {
      state.seen[id] = thread.updated;
      if (method === 'thread/status/changed' || method === 'turn/completed') share(state);
    }
    save(state);
  });
}
