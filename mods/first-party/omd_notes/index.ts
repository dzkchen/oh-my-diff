import type { CommandResult, Json, ModAPI, TerminalComponent } from '../../api.d.ts';

type Vault = 'project' | 'personal';
type Item = { label: string; value: string };
type Note = { vault: Vault; path: string; text: string; sha256: string; partial: boolean; line: number | null; links: Item[]; backlinks: Item[]; tags: string[] };
type State = { note: Note | null; list: { title: string; items: Item[] } | null; shown: boolean; revision: number };
type Hit = { vault: Vault; path: string; line: number; text: string };

const TEXT_LIMIT = 48_000;
const TOO_LARGE = `notes over ${TEXT_LIMIT} characters are shown truncated; edit them in your editor`;
const ITEM_LIMIT = 200;
const POLL_MS = 2_000;
const LINK = /\[\[([^\]|#\n]+)(?:#[^\]|\n]*)?(?:\|[^\]\n]*)?\]\]/g;
const TAG = /(?:^|\s)#([A-Za-z][\w/-]*)/g;
const TASK = /^(\s*[-*+] \[)([ xX])(\].*)$/;
const USAGE = 'usage: /note [open NOTE | new [--personal] [TITLE] | from PATH:START-END | response [N] | search TEXT | tags [TAG] | tasks | task NOTE:LINE | rename NAME | append TEXT | edit | close]';

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const title = (path: string) => path.slice(path.lastIndexOf('/') + 1).replace(/\.md$/i, '');
const parent = (path: string) => path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
const natural = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
const reference = (vault: Vault, path: string, line?: number) => `${vault}:${path}${line ? `:${line}` : ''}`;
const parse = (value: string): { vault: Vault; path: string; line: number | null } | null => {
  const match = /^(project|personal):(.+?\.md)(?::(\d+))?$/i.exec(value.trim());
  return match ? { vault: match[1] as Vault, path: match[2], line: match[3] ? Number(match[3]) : null } : null;
};
const links = (text: string) => [...new Set([...text.matchAll(LINK)].map(match => match[1].trim()))];

export default function activate(api: ModAPI) {
  const project = String(api.settings.vault || '.omd/notes').split('/').filter(part => part && part !== '.' && part !== '..').join('/') || '.omd/notes';
  const personal = /^\/[^\0]*[^/]$/.test(String(api.settings.personal ?? '')) ? String(api.settings.personal) : null;
  const roots: [Vault, string][] = [['project', project], ...(personal ? [['personal', personal] as [Vault, string]] : [])];
  const location = (vault: Vault, path: string) => `${vault === 'project' ? `./${project}` : personal}/${path}`;
  const load = (): State => ({ note: null, list: null, shown: false, revision: 0, ...(api.state.get() as Partial<State> | null) });
  const save = (state: State) => api.state.set({ ...state, revision: state.revision + 1 } as unknown as Json);
  const exec = (program: string, argv: string[], extra: { stdin?: string; write?: boolean; guards?: { program: string; argv: string[]; stdout_sha256: string }[] } = {}) =>
    api.host.tryCall('exec.run', { program, argv, timeout_ms: 10_000, ...extra });

  const read = (vault: Vault, path: string): { text: string; sha256: string; partial: boolean } | null => {
    const run = exec('cat', [location(vault, path)]);
    return run.ok && run.value.exit_code === 0 ? { text: run.value.stdout.slice(0, TEXT_LIMIT), sha256: run.value.stdout_sha256, partial: run.value.stdout_preview_truncated || run.value.stdout.length > TEXT_LIMIT } : null;
  };
  const write = (vault: Vault, path: string, text: string, expected: string | null): string | null => {
    const target = location(vault, path);
    if (expected === null) {
      const made = exec('mkdir', ['-p', '--', parent(target)], { write: true });
      if (!made.ok || made.value.exit_code !== 0) return made.ok ? made.value.stderr.trim() || 'mkdir failed' : made.error;
    }
    if (vault === 'project') {
      const written = api.host.tryCall('workspace.transaction', { expected: { [target.slice(2)]: expected }, writes: { [target.slice(2)]: text } });
      return written.ok ? null : /stale|expected|changed/.test(written.error) ? 'the note changed outside this view; it was reloaded, retry the edit' : written.error;
    }
    const written = exec('tee', [target], { stdin: text, write: true, ...(expected ? { guards: [{ program: 'cat', argv: [target], stdout_sha256: expected }] } : {}) });
    if (written.ok && written.value.exit_code === 0) return null;
    return written.ok ? `${written.value.stderr.trim() || 'write failed'} (the personal vault needs write access in your permission profile)` : /guard/.test(written.error) ? 'the note changed outside this view; it was reloaded, retry the edit' : written.error;
  };
  const notes = (): { vault: Vault; path: string }[] => {
    const found: { vault: Vault; path: string }[] = [];
    const listed = api.host.tryCall('workspace.list', { path: project, recursive: true, include_ignored: true, max_entries: 5_000 });
    if (listed.ok) found.push(...listed.value.entries.filter(entry => entry.kind === 'file' && entry.path.endsWith('.md')).map(entry => ({ vault: 'project' as Vault, path: entry.path.slice(project.length + 1) })));
    const outside = personal ? exec('find', [personal, '-type', 'f', '-name', '*.md']) : null;
    if (outside?.ok && outside.value.exit_code === 0) found.push(...outside.value.stdout.split('\n').filter(Boolean).map(path => ({ vault: 'personal' as Vault, path: path.slice(personal!.length + 1) })));
    return found.sort((a, b) => natural(title(a.path), title(b.path)));
  };
  const grep = (flags: string[], pattern: string): Hit[] => {
    const hits: Hit[] = [];
    for (const [vault, root] of roots) {
      const run = exec('grep', ['-rnI', '--include=*.md', ...flags, '--', pattern, root]);
      if (!run.ok || run.value.exit_code !== 0) continue;
      for (const line of run.value.stdout.split('\n')) {
        const match = /^(.*?\.md):(\d+):(.*)$/.exec(line);
        if (match && hits.length < ITEM_LIMIT) hits.push({ vault, path: match[1].slice(root.length + 1), line: Number(match[2]), text: match[3] });
      }
    }
    return hits;
  };
  const resolve = (name: string) => {
    const wanted = name.trim().toLowerCase();
    const all = notes();
    return all.find(note => note.vault === 'project' && title(note.path).toLowerCase() === wanted) ?? all.find(note => title(note.path).toLowerCase() === wanted) ?? null;
  };

  const open = (state: State, vault: Vault, path: string, line: number | null = null, poll = true): CommandResult => {
    const file = read(vault, path);
    if (!file) return { display: `Cannot read note ${reference(vault, path)}` };
    const all = notes();
    const known = new Map<string, { vault: Vault; path: string }>();
    for (const note of [...all].reverse()) if (!known.has(title(note.path).toLowerCase()) || note.vault === 'project') known.set(title(note.path).toLowerCase(), note);
    const name = title(path).toLowerCase();
    const outgoing = links(file.text).map(link => {
      const target = known.get(link.toLowerCase());
      return target ? { label: `→ ${link}`, value: `open ${reference(target.vault, target.path)}` } : { label: `→ ${link} (missing; Enter creates it)`, value: `new ${link}` };
    });
    const incoming = grep(['-iF'], `[[${title(path)}`)
      .filter(hit => !(hit.vault === vault && hit.path === path) && links(hit.text).some(link => link.toLowerCase() === name))
      .map(hit => ({ label: `← ${title(hit.path)}:${hit.line} ${hit.text.trim().slice(0, 80)}`, value: `open ${reference(hit.vault, hit.path, hit.line)}` }));
    const tags = [...new Set([...file.text.matchAll(TAG)].map(match => match[1]))];
    state.note = { vault, path, text: file.text, sha256: file.sha256, partial: file.partial, line, links: outgoing, backlinks: incoming, tags };
    state.list = null;
    state.shown = true;
    save(state);
    if (poll) api.host.tryCall('events.publish', { channel: 'poll', data: null });
    return null;
  };
  const show = (state: State, heading: string, items: Item[]): CommandResult => {
    state.list = { title: heading, items: items.slice(0, ITEM_LIMIT) };
    state.shown = true;
    save(state);
    return items.length ? null : { display: `${heading}: nothing found` };
  };
  const create = (state: State, vault: Vault, name: string | null, body: string): CommandResult => {
    const heading = (name ?? ask('New note', 'Title for the note') ?? '').replace(/[\\/:]/g, '-').replace(/[\0\n]/g, '').trim();
    if (!heading) return null;
    if (vault === 'personal' && !personal) return { display: 'Set the omd_notes `personal` setting to an absolute directory first' };
    const path = `${heading}.md`;
    if (read(vault, path)) return open(state, vault, path);
    const failed = write(vault, path, `# ${heading}\n\n${body}`, null);
    return failed ? { display: `Could not create ${heading}: ${failed}` } : open(state, vault, path);
  };
  const ask = (heading: string, message: string): string | null => {
    const answer = api.host.tryCall('terminal.prompt', { kind: 'text', title: heading, message });
    return answer.ok && answer.value.status === 'accepted' ? (answer.value.value ?? '').trim() || null : null;
  };
  const confirm = (heading: string, message: string) => {
    const answer = api.host.tryCall('terminal.prompt', { kind: 'confirm', title: heading, message });
    return answer.ok && answer.value.status === 'accepted';
  };
  const responses = (limit: number): string[] => {
    const before = api.host.call('store.get', { key: 'thread' });
    api.host.call('store.put', { key: 'thread', value: null, expected_revision: before?.revision ?? null });
    const threadId = api.host.call('store.get', { key: 'thread' })?.provenance.thread_id ?? null;
    const page = api.host.call('app.request', { method: 'thread/turns/list', params: { threadId, limit, itemsView: 'summary' } }) as { data?: { items?: { type?: string; text?: string }[] }[] };
    return (page.data ?? []).flatMap(turn => (turn.items ?? []).filter(item => item.type === 'agentMessage').slice(-1).map(item => item.text ?? ''));
  };
  const toggle = (state: State, target: string): CommandResult => {
    const found = parse(target);
    const file = found?.line ? read(found.vault, found.path) : null;
    if (!found?.line || !file) return { display: `No task at ${target}` };
    if (file.partial) return { display: TOO_LARGE };
    const lines = file.text.split('\n');
    const match = TASK.exec(lines[found.line - 1] ?? '');
    if (!match) return { display: `Line ${found.line} of ${title(found.path)} is not a task` };
    lines[found.line - 1] = `${match[1]}${match[2] === ' ' ? 'x' : ' '}${match[3]}`;
    const failed = write(found.vault, found.path, lines.join('\n'), file.sha256);
    if (failed) return { display: failed };
    return state.note?.path === found.path && state.note.vault === found.vault ? open(state, found.vault, found.path, found.line) : tasks(state);
  };
  const tasks = (state: State): CommandResult => show(state, 'Tasks', grep(['-E'], '^[[:space:]]*[-*+] \\[[ xX]\\]').map(hit => ({
    label: `${/\[[xX]\]/.test(hit.text) ? '☑' : '☐'} ${title(hit.path)}: ${hit.text.replace(/^\s*[-*+] \[[ xX]\]\s*/, '')}`, value: `task ${reference(hit.vault, hit.path, hit.line)}` })));
  const rename = (state: State, next: string | null): CommandResult => {
    const note = state.note;
    if (!note || note.vault !== 'project') return { display: 'Open a project-vault note to rename it' };
    const name = (next ?? ask('Rename note', `New title for ${title(note.path)}`) ?? '').replace(/[\\/:]/g, '-').trim();
    if (!name) return null;
    const path = parent(note.path) ? `${parent(note.path)}/${name}.md` : `${name}.md`;
    if (read('project', path)) return { display: `${name} already exists` };
    const old = title(note.path);
    const pattern = new RegExp(`\\[\\[${escape(old)}(?=[\\]|#])`, 'gi');
    const writes: Record<string, string> = {};
    const expected: Record<string, string | null> = { [`${project}/${note.path}`]: note.sha256, [`${project}/${path}`]: null };
    for (const other of new Set(grep(['-iF'], `[[${old}`).filter(hit => hit.vault === 'project' && hit.path !== note.path).map(hit => hit.path))) {
      const file = read('project', other);
      if (!file || file.partial || Object.keys(writes).length >= 64) return { display: `Cannot update links in ${other}${file?.partial ? `: ${TOO_LARGE}` : ''}` };
      expected[`${project}/${other}`] = file.sha256;
      writes[`${project}/${other}`] = file.text.replace(pattern, `[[${name}`);
    }
    if (!confirm('Rename note', `${old} → ${name}${Object.keys(writes).length ? `\nUpdates links in ${Object.keys(writes).length} notes` : ''}`)) return null;
    const moved = api.host.tryCall('workspace.transaction', { expected, writes, renames: [{ old: `${project}/${note.path}`, new: `${project}/${path}` }] });
    return moved.ok ? open(state, 'project', path) : { display: `Rename failed: ${moved.error}` };
  };

  api.command('note', value => {
    try {
      const text = String(value ?? '').trim();
      const op = text.split(' ')[0];
      const argument = text.slice(op.length).trim();
      const state = load();
      switch (op) {
        case '':
        case 'home':
          return show(state, 'Notes', notes().map(note => ({ label: `${note.vault === 'personal' ? '◆' : '◇'} ${title(note.path)}${parent(note.path) ? ` · ${parent(note.path)}` : ''}`, value: `open ${reference(note.vault, note.path)}` })));
        case 'open': {
          const found = parse(argument) ?? resolve(argument);
          return found ? open(state, found.vault, found.path, 'line' in found ? found.line as number | null : null) : create(state, 'project', argument || null, '');
        }
        case 'new':
          return argument.startsWith('--personal') ? create(state, 'personal', argument.slice(10).trim() || null, '') : create(state, 'project', argument || null, '');
        case 'from': {
          const match = /^(.+?):(\d+)(?:-(\d+))?$/.exec(argument);
          if (!match) return { display: USAGE };
          const [start, end] = [Number(match[2]), Number(match[3] ?? match[2])];
          const lines = exec('awk', ['-v', `s=${start}`, '-v', `e=${end}`, 'NR>=s && NR<=e', `./${match[1]}`]);
          if (!lines.ok || lines.value.exit_code !== 0) return { display: `Cannot read ${match[1]}` };
          return create(state, 'project', null, `Source: \`${match[1]}:${start}${end !== start ? `-${end}` : ''}\`\n\n\`\`\`\n${lines.value.stdout.slice(0, 16_000)}\`\`\`\n`);
        }
        case 'response': {
          const index = Math.max(1, Number(argument || 1));
          const response = responses(Math.min(index, 20))[index - 1];
          return response === undefined ? { display: `No response ${index} in this session` } : create(state, 'project', null, `${response.slice(0, 32_000)}\n`);
        }
        case 'search': {
          if (!argument) return { display: USAGE };
          const named = notes().filter(note => title(note.path).toLowerCase().includes(argument.toLowerCase())).map(note => ({ label: `◇ ${title(note.path)}`, value: `open ${reference(note.vault, note.path)}` }));
          const hits = grep(['-iF'], argument).map(hit => ({ label: `${title(hit.path)}:${hit.line} ${hit.text.trim().slice(0, 100)}`, value: `open ${reference(hit.vault, hit.path, hit.line)}` }));
          return show(state, `Search: ${argument}`, [...named, ...hits]);
        }
        case 'tags': {
          if (argument) {
            const tag = argument.replace(/^#/, '');
            return show(state, `#${tag}`, grep(['-E'], `(^|[[:space:]])#${escape(tag)}([^A-Za-z0-9_/-]|$)`).map(hit => ({ label: `${title(hit.path)}:${hit.line} ${hit.text.trim().slice(0, 100)}`, value: `open ${reference(hit.vault, hit.path, hit.line)}` })));
          }
          const counts = new Map<string, number>();
          for (const hit of grep(['-E'], '(^|[[:space:]])#[A-Za-z]')) for (const match of hit.text.matchAll(TAG)) counts.set(match[1], (counts.get(match[1]) ?? 0) + 1);
          return show(state, 'Tags', [...counts].sort((a, b) => b[1] - a[1] || natural(a[0], b[0])).map(([tag, count]) => ({ label: `#${tag} (${count})`, value: `tags ${tag}` })));
        }
        case 'tasks':
          return tasks(state);
        case 'task':
          return toggle(state, argument);
        case 'rename':
          return rename(state, argument || null);
        case 'append': {
          const note = state.note;
          if (!note || !argument) return { display: note ? USAGE : 'Open a note first' };
          if (note.partial) return { display: TOO_LARGE };
          const failed = write(note.vault, note.path, `${note.text.replace(/\n*$/, '\n')}${argument}\n`, note.sha256);
          const reopened = open(state, note.vault, note.path, note.line);
          return failed ? { display: failed } : reopened;
        }
        case 'edit': {
          const note = state.note;
          const root = note?.vault === 'project' ? exec('pwd', []) : null;
          const opened = root?.ok ? api.host.tryCall('terminal.open', { path: `${root.value.stdout.trim()}/${project}/${note!.path}`, line: note!.line ?? 1, editor: true }) : null;
          return opened?.ok ? null : { display: opened ? opened.error : 'Open a project-vault note to edit it' };
        }
        case 'close':
          state.shown = false;
          save(state);
          return null;
        default:
          return { display: USAGE };
      }
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      return { display: `notes: ${error.message}` };
    }
  }, { description: 'Markdown notes vault: wiki links, backlinks, tags, tasks and search (Alt+n)' });

  api.on('completion', event => {
    if (event.kind !== 'argument') return null;
    const query = event.query.toLowerCase();
    const items = event.line.trim().includes(' ') || event.line.endsWith(' ')
      ? notes().map(note => title(note.path)).filter(name => name.toLowerCase().includes(query))
      : ['open', 'new', 'search', 'tags', 'tasks', 'rename', 'append', 'edit', 'response', 'close'].filter(name => name.startsWith(query));
    return { items: [...new Set(items)].slice(0, 50).map(insert => ({ insert })) };
  });

  const poll = () => {
    const state = load();
    const note = state.shown && !state.list ? state.note : null;
    if (!note) return;
    const file = read(note.vault, note.path);
    if (file && file.sha256 !== note.sha256) open(state, note.vault, note.path, note.line, false);
    api.host.tryCall('events.schedule', { key: 'poll', delay_ms: POLL_MS });
  };
  api.on('channel', poll);
  api.on('timer', poll);
  api.on('resume', poll);

  if (api.settings.agent === true) {
    const describe = (hit: Hit) => `${title(hit.path)} (${hit.vault}) line ${hit.line}: ${hit.text.trim().slice(0, 200)}`;
    api.tool({ name: 'search', description: 'Search the Markdown notes vaults (project and personal) for text; results are note excerpts written by the user.', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false } },
      input => grep(['-iF'], String((input as { query?: string }).query ?? '')).slice(0, 50).map(describe).join('\n') || 'No matching notes');
    api.tool({ name: 'read', description: 'Read one Markdown note from the notes vaults by title.', parameters: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'], additionalProperties: false } }, input => {
      const found = resolve(String((input as { title?: string }).title ?? ''));
      return (found && read(found.vault, found.path)?.text) ?? 'No such note';
    });
    api.tool({ name: 'write', description: 'Create, replace or append to a project-vault note. The user approves every write; a declined write changes nothing.',
      parameters: { type: 'object', properties: { title: { type: 'string' }, content: { type: 'string' }, mode: { type: 'string', enum: ['create', 'replace', 'append'] } }, required: ['title', 'content', 'mode'], additionalProperties: false } }, input => {
      const { title: name = '', content = '', mode = 'append' } = input as { title?: string; content?: string; mode?: string };
      const path = `${name.replace(/[\\/:]/g, '-').trim()}.md`;
      const current = read('project', path);
      if (!name.trim() || (mode === 'create') === Boolean(current)) return mode === 'create' ? `Note ${name} already exists` : `No project note ${name}`;
      if (mode === 'append' && current?.partial) return `Note ${name}: ${TOO_LARGE}`;
      const text = mode === 'append' && current ? `${current.text.replace(/\n*$/, '\n')}${content}\n` : content;
      if (!confirm(`Agent wants to ${mode} note ${name}`, content.slice(0, 1_500))) return 'The user declined the note write';
      return write('project', path, text, current?.sha256 ?? null) ?? `Saved ${name}`;
    });
  }

  api.on('terminal', () => {
    const state = load();
    const keybindings = { 'Alt+n': { command: 'omd_notes:note' } } as const;
    if (!state.shown) return { keybindings };
    const id = (name: string) => `omd_notes_${name}_${state.revision}`;
    const note = state.list ? null : state.note;
    const search: TerminalComponent = { type: 'input', id: 'omd_notes_search', label: 'Search notes', placeholder: 'text, then Enter', action: { command: 'omd_notes:note', args: 'search' } };
    const actions = (options: string[]): TerminalComponent => ({ type: 'select', id: id('actions'), label: 'Notes', value: options[0], options: options.map(option => ({ value: option, label: option })), action: { command: 'omd_notes:note' } });
    const components: TerminalComponent[] = note ? [
      { type: 'line', id: id('title'), label: title(note.path), spans: [{ text: `${note.vault === 'personal' ? '◆' : '◇'} ${title(note.path)}`, bold: true }, ...note.tags.map(tag => ({ text: ` #${tag}`, tone: 'accent' as const }))] },
      { type: 'pane', id: id('body'), label: 'Note, scroll with arrows', children: [{ type: 'markdown', id: id('markdown'), label: title(note.path), text: note.text }] },
      ...(note.links.length || note.backlinks.length ? [{ type: 'list' as const, id: id('links'), label: 'Links and backlinks', height: 6, rows: [...note.links, ...note.backlinks].map(item => ({ value: item.value, label: item.label, spans: [{ text: item.label }] })), action: { command: 'omd_notes:note' } }] : []),
      ...(note.vault === 'project' ? [{ type: 'button' as const, id: id('preview'), label: 'Live preview in the browser', text: 'Preview', action: { command: 'omd_preview:preview', args: `${project}/${note.path} --watch` } }] : []),
      actions([...(note.vault === 'project' ? ['edit', 'rename'] : []), 'tasks', 'tags', 'home', 'close']),
      search,
    ] : [
      { type: 'line', id: id('title'), label: state.list?.title ?? 'Notes', spans: [{ text: state.list?.title ?? 'Notes', bold: true }] },
      search,
      { type: 'list', id: id('items'), label: state.list?.title ?? 'Notes', rows: (state.list?.items ?? []).map(item => ({ value: item.value, label: item.label, spans: [{ text: item.label }] })), action: { command: 'omd_notes:note' } },
      actions(['new', ...(personal ? ['new --personal'] : []), 'tasks', 'tags', 'home', 'close']),
    ];
    return { sites: { 'omd_notes/notes': { mode: 'replace', components } }, keybindings };
  });
}
