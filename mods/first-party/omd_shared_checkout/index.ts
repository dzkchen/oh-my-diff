import type { Json, ModAPI, TerminalComponent, TerminalRenderSite } from '../../api.d.ts';

type Entry = {
  task: string; write: boolean; paths: string[]; at: number; since: number; warnings: string[]; open: boolean; prefix: string; watches: string[]; arm?: string;
  patched: { path: string; at: number; call: string }[]; running: { call: string; at: number }[]; pending: { path: string; at: number }[];
};
type Handoff = { from: string; to: string; paths: string[]; note: string; at: number };
type State = { root: string | null; sessions: Record<string, Entry>; handoffs: Handoff[]; git: { thread: string; call: string; command: string; at: number } | null };

const STALE = 10 * 60_000;
const BEAT = 4 * 60_000;
const EXPIRE = 24 * 60 * 60_000;
const LEASE = 2 * 60_000;
const OWN = 2 * 60_000;
const SETTLE = 3_000;
const SESSIONS = 16;
const PATHS = 16;
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'fish']);
const WRAPPERS: Record<string, string[]> = { command: [], nohup: [], env: ['-u', '-C', '-S'], time: ['-f', '-o'], exec: ['-a'], nice: ['-n'],
  sudo: ['-u', '-g', '-h', '-p', '-C', '-D', '-r', '-t', '-U'], xargs: ['-I', '-n', '-P', '-L', '-s', '-d', '-E', '-a'] };
const WRITES: Record<string, 'all' | 'last' | 'sed'> = { rm: 'all', rmdir: 'all', unlink: 'all', shred: 'all', touch: 'all', mkdir: 'all', truncate: 'all', tee: 'all', mv: 'all', cp: 'last', ln: 'last', install: 'last', sed: 'sed' };
const GIT_WRITES = new Set(['add', 'am', 'apply', 'checkout', 'cherry-pick', 'clean', 'commit', 'merge', 'mv', 'pull', 'rebase', 'reset', 'restore', 'revert', 'rm', 'switch', 'update-index', 'update-ref']);
const ADVISORY = 'Agent patches, Git commands and recognizable shell writes in sessions running this mod are checked; other writes and programs outside OMD are not blocked, but a writer is warned when anything outside its session changes its paths.';
const OUTSIDE = 'changed outside this session';
const COORDINATE = 'Approve only after coordinating; a worktree avoids overlapping edits.';

const fit = (text: string, bytes: number) => {
  let out = '';
  let total = 0;
  for (const char of text) {
    const code = char.codePointAt(0)!;
    total += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
    if (total > bytes - 3) return `${out}…`;
    out += char;
  }
  return out;
};
const clean = (path: string) => path === '.' ? '.' : /^\/|(^|\/)\.\.?(\/|$)|(^|\/)\.git(\/|$)/.test(path) ? null : path.split('/').filter(Boolean).join('/') || null;
const covers = (reserved: string, path: string) => reserved === '.' || path === reserved || path.startsWith(`${reserved}/`);
const overlap = (mine: string[], theirs: string[]) => mine.filter(path => theirs.some(other => covers(other, path) || covers(path, other)));
const live = (entry: Entry) => Date.now() - entry.at < STALE;
const ago = (at: number) => {
  const minutes = Math.floor((Date.now() - at) / 60_000);
  return minutes < 1 ? 'now' : minutes < 120 ? `${minutes}m ago` : `${Math.floor(minutes / 60)}h ago`;
};
const label = (thread: string, entry: Entry | undefined) => `${entry?.task || 'read-only session'} (${thread.slice(0, 8)})`;
const local = (uri: string) => {
  try {
    return decodeURIComponent(uri.replace(/^file:\/\//, ''));
  } catch {
    return uri;
  }
};
const base = (word: string) => word.slice(word.lastIndexOf('/') + 1);
const commands = (script: string) => {
  const out: string[][] = [[]];
  for (const match of script.matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'|(\d*>&\d*-?)|(\d*>>?|<)|(&&|\|\||[;|&\n()])|([^\s"';|&()<>]+)/g)) {
    if (match[5]) out.push([]);
    else if (!match[3]) out.at(-1)!.push((match[1] ?? match[2] ?? match[4] ?? match[6]).replace(/\\(.)/g, '$1'));
  }
  return out.filter(words => words.length);
};
const simple = (argv: string[], depth = 0): string[][] => {
  let words = argv;
  while (words.length && (/^\w+=/.test(words[0]) || WRAPPERS[base(words[0])])) {
    const values = WRAPPERS[base(words[0])] ?? [];
    words = words.slice(1);
    while (values.length && words[0]?.startsWith('-')) words = words.slice(values.includes(words[0]) ? 2 : 1);
  }
  const flag = SHELLS.has(base(words[0] ?? '')) && depth < 3 ? words.findIndex(word => /^-\w*c\w*$/.test(word)) : -1;
  return flag > 0 && words[flag + 1] ? commands(words[flag + 1]).flatMap(nested => simple(nested, depth + 1)) : words.length ? [words] : [];
};
const parse = (command: string[] | string) => (typeof command === 'string' ? commands(command) : [command]).flatMap(words => simple(words));
const targets = (words: string[]) => {
  const out: string[] = [];
  const args: string[] = [];
  for (let index = 0; index < words.length; index++) {
    if (/^\d*>>?$/.test(words[index])) out.push(words[++index] ?? '');
    else if (words[index] === '<') index++;
    else args.push(words[index]);
  }
  const mode = WRITES[base(args[0] ?? '')];
  const scripted = mode === 'sed' && args.some(word => ['-e', '-f', '--expression', '--file'].includes(word));
  const operands = args.slice(1).filter((word, index, rest) => !word.startsWith('-') && !(scripted && ['-e', '-f', '--expression', '--file'].includes(rest[index - 1])));
  if (mode === 'all') out.push(...operands);
  else if (mode === 'last') out.push(...operands.slice(-1));
  else if (mode === 'sed' && args.some(word => /^-[a-zA-Z]*i|^--in-place/.test(word))) out.push(...operands.slice(scripted ? 0 : 1));
  return out.filter(path => path && !path.startsWith('/dev/'));
};
const resolve = (cwd: string, path: string) => {
  const parts: string[] = [];
  for (const part of (path.startsWith('/') ? path : `${cwd}/${path}`).split('/')) {
    if (part === '..') parts.pop();
    else if (part && part !== '.') parts.push(part);
  }
  return `/${parts.join('/')}`;
};
const gitWrite = (words: string[]) => {
  if (base(words[0] ?? '') !== 'git') return null;
  let index = 1;
  while (words[index]?.startsWith('-')) index += ['-C', '-c', '--git-dir', '--work-tree', '--namespace'].includes(words[index]) ? 2 : 1;
  const command = words[index] ?? '';
  const rest = words.slice(index + 1);
  const listing = rest.includes('--list') || rest.includes('-l');
  return GIT_WRITES.has(command) || command === 'stash' && !['list', 'show'].includes(rest[0]) || command === 'worktree' && rest[0] !== 'list'
    || (command === 'branch' || command === 'tag') && !listing && rest.some(word => !word.startsWith('-') || /^-[dDmMcCf]$|^--(delete|move|copy|force)$/.test(word)) ? `git ${command}` : null;
};

export default function activate(api: ModAPI) {
  const load = (): State => ({ root: null, sessions: {}, handoffs: [], git: null, ...(api.state.get() as Partial<State> | null) });
  const save = (state: State) => api.state.set(state as unknown as Json);
  const output = (program: string, argv: string[]) => {
    const run = api.host.tryCall('exec.run', { program, argv, timeout_ms: 5_000 });
    return run.ok && run.value.exit_code === 0 && run.value.stdout.trim() ? run.value.stdout.trim() : null;
  };
  const locate = () => {
    const cwd = output('pwd', []);
    const root = output('git', ['rev-parse', '--show-toplevel']) ?? cwd;
    return { root, prefix: root && cwd?.startsWith(`${root}/`) ? cwd.slice(root.length + 1) : '' };
  };
  const me = () => {
    const current = api.host.tryCall('store.get', { key: 'self', scope: 'thread' });
    const put = current.ok ? api.host.tryCall('store.put', { key: 'self', scope: 'thread', value: true, expected_revision: current.value?.revision ?? null }) : null;
    const read = put?.ok ? api.host.tryCall('store.get', { key: 'self', scope: 'thread' }) : null;
    return read?.ok ? read.value?.provenance.thread_id ?? null : null;
  };
  const touch = (state: State, thread: string) => {
    const now = Date.now();
    state.sessions[thread] ??= { task: '', write: false, paths: [], at: now, since: now, warnings: [], open: false, prefix: '', watches: [], patched: [], running: [], pending: [] };
    state.sessions[thread].at = now;
    for (const [id, entry] of Object.entries(state.sessions)) if (now - entry.at > EXPIRE) delete state.sessions[id];
    const ids = Object.keys(state.sessions).sort((a, b) => state.sessions[a].at - state.sessions[b].at);
    while (ids.length > SESSIONS) delete state.sessions[ids.shift()!];
    state.handoffs = state.handoffs.filter(handoff => state.sessions[handoff.from] && state.sessions[handoff.to]).slice(-8);
    if (state.git && now - state.git.at > LEASE) state.git = null;
    return state.sessions[thread];
  };
  const warn = (entry: Entry | undefined, text: string) => {
    if (entry && !entry.warnings.includes(text)) entry.warnings = [...entry.warnings, text].slice(-6);
  };
  const confirm = (title: string, message: string) => {
    const answer = api.host.tryCall('terminal.prompt', { kind: 'confirm', title, message: message.slice(0, 2_000) });
    return answer.ok && answer.value.status === 'accepted';
  };
  const arm = (entry: Entry) => {
    for (const watch of entry.watches) api.host.tryCall('workspace.unwatch', { watch_id: watch });
    const local = (path: string) => path === '.' || entry.prefix && path === entry.prefix ? '.' : !entry.prefix ? path : path.startsWith(`${entry.prefix}/`) ? path.slice(entry.prefix.length + 1) : null;
    const reserved = entry.write ? entry.paths.map(local).filter((path): path is string => path !== null) : [];
    const listed = reserved.includes('.') ? api.host.tryCall('workspace.list', { recursive: false, include_ignored: true, max_entries: 128 }) : null;
    const paths = reserved.includes('.') ? listed?.ok ? listed.value.entries.map(item => item.path) : [] : reserved;
    entry.watches = [];
    for (let index = 0; index < paths.length; index += 32) {
      const watched = api.host.tryCall('workspace.watch', { paths: paths.slice(index, index + 32), recursive: true, debounce_ms: 500, include_ignored: true });
      if (watched.ok) entry.watches.push(watched.value.watch_id);
    }
  };
  const register = (thread: string | null, watch: boolean) => {
    const state = load();
    const where = thread ? locate() : null;
    state.root ??= where?.root ?? null;
    if (!thread || !where || !state.root) return;
    const entry = touch(state, thread);
    entry.prefix = where.root === state.root ? where.prefix : '';
    if (watch) arm(entry);
    save(state);
    api.host.tryCall('events.schedule', { key: 'beat', delay_ms: BEAT });
  };
  const settle = () => {
    const state = load();
    const now = Date.now();
    let waiting = false;
    for (const entry of Object.values(state.sessions)) {
      entry.running = entry.running.filter(item => now - item.at < STALE);
      if (entry.running.length || !entry.pending.length) continue;
      for (const { path } of entry.pending.filter(item => now - item.at >= SETTLE)) {
        if (!entry.patched.some(item => item.path === path && now - item.at < OWN)) warn(entry, `${path} ${OUTSIDE}`);
      }
      entry.pending = entry.pending.filter(item => now - item.at < SETTLE);
      waiting ||= entry.pending.length > 0;
    }
    save(state);
    if (waiting) api.host.tryCall('events.schedule', { key: 'settle', delay_ms: SETTLE });
  };
  const claim = (thread: string, entry: Entry, files: string[], others: [string, Entry][], call: string, verb: string) => {
    const now = Date.now();
    entry.patched = [...entry.patched.filter(item => now - item.at < OWN), ...files.map(path => ({ path, at: now, call }))].slice(-32);
    const foreign = others.flatMap(([id, other]) => overlap(files, other.paths).map(file => ({ id, other, file })));
    const outside = files.filter(file => !entry.paths.some(path => covers(path, file)));
    for (const { other, file } of foreign) warn(other, `${label(thread, entry)} asked to ${verb} ${file}`);
    return [...foreign.map(({ id, other, file }) => `${file} is reserved by ${label(id, other)}${live(other) ? '' : `, stale since ${ago(other.at)}`}`),
      ...outside.length ? [`${outside.join(', ')} is outside this session's assignment (${entry.paths.join(', ')})`] : []];
  };
  const inside = (root: string, path: string) => path === root || path.startsWith(`${root}/`);

  api.on('start', () => register(me(), true));
  api.on('resume', ({ thread_id }) => register(thread_id, true));
  // Watches belong to the process that armed them; a hop can arrive before the command that asked for it saves, so a timer retries.
  const rearm = (retry: boolean) => {
    const lead = me();
    const state = load();
    const pending = Object.values(state.sessions).filter(entry => lead && entry.arm === lead);
    if (retry && pending.length) api.host.tryCall('events.schedule', { key: 'arm', delay_ms: 1_000 });
    for (const entry of pending) {
      delete entry.arm;
      arm(entry);
    }
    if (pending.length) save(state);
  };
  api.on('timer', ({ key }) => {
    if (key === 'beat') register(me(), false);
    if (key === 'settle') settle();
    if (key === 'arm' || key === 'beat') rearm(key === 'arm');
  });
  api.on('channel', ({ channel }) => {
    if (!channel.endsWith('/watch')) return;
    api.host.tryCall('events.schedule', { key: 'arm', delay_ms: 1_000 });
    rearm(false);
  });
  api.on('workspace_change', event => {
    if (event.status !== 'observed') return;
    const state = load();
    if (event.source !== 'external') {
      if (!Object.values(state.sessions).some(entry => entry.write)) return;
      const thread = me();
      const entry = thread ? state.sessions[thread] : undefined;
      if (!entry?.write) return;
      const now = Date.now();
      const paths = event.changes.map(change => entry.prefix ? `${entry.prefix}/${change.path}` : change.path);
      entry.patched = [...entry.patched.filter(item => now - item.at < OWN), ...paths.map(path => ({ path, at: now, call: event.call_id ?? event.source }))].slice(-32);
      entry.pending = entry.pending.filter(item => !paths.includes(item.path));
      entry.warnings = entry.warnings.filter(text => !paths.some(path => text === `${path} ${OUTSIDE}`));
      save(state);
      return;
    }
    if (!event.watch_id) return;
    const sessions = Object.entries(state.sessions).filter(([, entry]) => entry.watches.includes(event.watch_id!));
    const thread = sessions.length > 1 ? me() : sessions[0]?.[0];
    const entry = sessions.find(([id]) => id === thread)?.[1];
    if (!entry?.write) return;
    const now = Date.now();
    const paths = event.changes.map(change => entry.prefix ? `${entry.prefix}/${change.path}` : change.path).filter(path => entry.paths.some(reserved => covers(reserved, path)));
    if (!paths.length) return;
    entry.pending = [...entry.pending, ...paths.map(path => ({ path, at: now }))].slice(-32);
    save(state);
    api.host.tryCall('events.schedule', { key: 'settle', delay_ms: SETTLE });
  });
  api.on('stop', () => {
    const thread = me();
    const state = load();
    const entry = thread ? state.sessions[thread] : undefined;
    if (!thread || !entry) return;
    for (const watch of entry.watches) api.host.tryCall('workspace.unwatch', { watch_id: watch });
    if (state.git?.thread === thread) state.git = null;
    delete state.sessions[thread];
    save(state);
  });
  api.on('approval_result', ({ id, decision }) => {
    if (decision.startsWith('approved') || decision === 'amended') return;
    const state = load();
    const entries = Object.values(state.sessions).filter(entry => entry.patched.some(item => item.call === id));
    if (!entries.length) return;
    for (const entry of entries) entry.patched = entry.patched.filter(item => item.call !== id);
    save(state);
  });
  api.on('tool_result', ({ call_id, thread_id }) => {
    const state = load();
    const entry = thread_id ? state.sessions[thread_id] : undefined;
    const running = entry?.running.some(item => item.call === call_id);
    if (state.git?.call !== call_id && !running) return;
    if (state.git?.call === call_id) state.git = null;
    if (entry && running) entry.running = entry.running.filter(item => item.call !== call_id);
    save(state);
    if (entry?.pending.length) api.host.tryCall('events.schedule', { key: 'settle', delay_ms: SETTLE });
  });

  api.middleware('approval', event => {
    if (!['patch', 'exec', 'execve'].includes(event.kind)) return null;
    const details = (event.details ?? {}) as { cwd?: string; files?: string[]; command?: string[] | string };
    const state = load();
    const root = state.root;
    if (!root || !Object.keys(state.sessions).length || event.kind !== 'patch' && !inside(root, local(details.cwd ?? ''))) return null;
    const entry = state.sessions[event.thread_id];
    const readOnly = `${event.agent_id ? `Agent thread ${event.thread_id}` : 'This session'} is a read-only participant in the shared checkout ${root}. `
      + `Ask the user to assign it paths with /share write PATH... -- TASK${event.agent_id ? ` @${event.thread_id}` : ''}, or to run the task in a worktree (/share worktree).`;
    const others = Object.entries(state.sessions).filter(([id, other]) => id !== event.thread_id && other.write);
    if (event.kind === 'patch') {
      const files = (details.files ?? []).map(local).filter(file => file.startsWith(`${root}/`)).map(file => file.slice(root.length + 1));
      if (!files.length) return null;
      if (!entry?.write) return { deny: readOnly };
      const reasons = claim(event.thread_id, entry, files, others, event.id, 'edit');
      save(state);
      return reasons.length ? { ask: `${reasons.join('; ')}. ${COORDINATE}` } : null;
    }
    if (entry?.write && entry.watches.length) {
      entry.running = [...entry.running.filter(item => Date.now() - item.at < STALE), { call: event.id, at: Date.now() }].slice(-16);
      save(state);
    }
    const scripts = details.command ? parse(details.command) : [];
    const command = scripts.map(gitWrite).find(Boolean) ?? null;
    const cwd = local(details.cwd ?? '');
    const written = [...new Set(scripts.flatMap(targets).map(path => resolve(cwd, path)).filter(path => path.startsWith(`${root}/`)).map(path => path.slice(root.length + 1)))];
    if (!command && !written.length) return null;
    if (command && !entry?.write) return { deny: `${readOnly} ${command} changes the shared index, refs or working tree.` };
    const reasons: string[] = [];
    const holder = command && state.git && state.git.thread !== event.thread_id && Date.now() - state.git.at < LEASE ? state.git : null;
    if (holder) reasons.push(`${holder.command} by ${label(holder.thread, state.sessions[holder.thread])} may still be running in this checkout; approve only once it has finished`);
    else if (command) {
      state.git = { thread: event.thread_id, call: event.id, command, at: Date.now() };
      const writers = others.filter(([, other]) => live(other));
      if (writers.length) reasons.push(`${command} affects the whole checkout while ${writers.map(([id, other]) => label(id, other)).join(', ')} also write here; approve only if it leaves their changes alone`);
    }
    const files = !written.length ? [] : entry?.write ? claim(event.thread_id, entry, written, others, event.id, 'write')
      : [`this read-only session's command writes ${written.join(', ')}; /share write PATH... -- TASK assigns paths`];
    save(state);
    return reasons.length || files.length ? { ask: `${[...reasons, ...files].join('; ')}.${files.length ? ` ${COORDINATE}` : ''}` } : null;
  });

  const USAGE = 'usage: /share [write PATH... -- TASK | read | handoff SESSION [PATH...] [-- NOTE] | accept N | decline N | release SESSION | dismiss | worktree]';
  api.command('share', value => {
    const words = String(value ?? '').trim().split(/\s+/).filter(Boolean);
    const named = words.find(word => word.startsWith('@'))?.slice(1);
    const [op = '', ...rest] = words.filter(word => !word.startsWith('@'));
    const thread = named || me();
    const state = load();
    const where = locate();
    state.root ??= where.root;
    if (!thread || !state.root) return { display: 'share: the current session or checkout is unavailable' };
    const entry = touch(state, thread);
    if (where.root === state.root) entry.prefix = where.prefix;
    const rewatch = () => {
      const lead = named ? me() : thread;
      if (lead) entry.arm = lead;
      api.host.tryCall('events.publish', { channel: 'watch', data: thread });
    };
    const find = (prefix: string | undefined) => prefix && prefix.length >= 6 ? Object.keys(state.sessions).find(id => id.startsWith(prefix)) : undefined;
    const split = (items: string[]) => {
      const index = items.indexOf('--');
      return { paths: (index < 0 ? items : items.slice(0, index)).map(clean), note: index < 0 ? '' : items.slice(index + 1).join(' ').slice(0, 80) };
    };
    const done = (message: string | null = null) => {
      save(state);
      return message ? { display: message } : null;
    };
    switch (op) {
      case '':
      case 'toggle':
        entry.open = !entry.open;
        return done();
      case 'write': {
        const { paths, note } = split(rest);
        if (!paths.length || paths.length > PATHS || paths.some(path => !path)) return { display: USAGE };
        const wanted = paths as string[];
        const conflicts = Object.entries(state.sessions).filter(([id, other]) => id !== thread && other.write && overlap(wanted, other.paths).length);
        if (conflicts.length && !confirm('Overlapping reservation', `${conflicts.map(([id, other]) => `${overlap(wanted, other.paths).join(', ')} is reserved by ${label(id, other)}${live(other) ? `, active ${ago(other.at)}` : `, stale since ${ago(other.at)}`}`).join('\n')}\n\n`
          + 'Reserve anyway? Both sessions are asked before editing the overlap. A worktree (/share worktree) avoids it.')) return done('Not reserved. Run the task in a worktree with /share worktree (or /omd_worktree:new TASK with omd_worktree), or ask the other session for a handoff.');
        for (const [, other] of conflicts) warn(other, `${label(thread, { ...entry, task: note || entry.task })} also reserved ${overlap(wanted, other.paths).join(', ')}`);
        Object.assign(entry, { write: true, paths: [...new Set([...entry.paths, ...wanted])].slice(0, PATHS), task: note || entry.task || wanted.join(' ').slice(0, 80) });
        rewatch();
        return done(`Writing ${entry.paths.join(', ')} for ${entry.task}. ${ADVISORY}`);
      }
      case 'read':
        Object.assign(entry, { write: false, paths: [], task: '' });
        state.handoffs = state.handoffs.filter(handoff => handoff.from !== thread);
        rewatch();
        return done('This session is read-only in the shared checkout again');
      case 'handoff': {
        const target = find(rest[0]);
        const { paths, note } = split(rest.slice(1));
        const offered = (paths.length ? paths : entry.paths) as string[];
        if (!target || target === thread || paths.some(path => !path) || !offered.length) return { display: USAGE };
        if (!entry.write || offered.some(path => !entry.paths.includes(path))) return { display: `Hand off only paths this session reserved: ${entry.paths.join(', ') || 'none'}` };
        state.handoffs = [...state.handoffs, { from: thread, to: target, paths: offered, note, at: Date.now() }].slice(-8);
        warn(state.sessions[target], `${label(thread, entry)} offers ${offered.join(', ')}${note ? `: ${note}` : ''}`);
        return done(`Offered ${offered.join(', ')} to ${label(target, state.sessions[target])}; it keeps waiting until they accept`);
      }
      case 'accept':
      case 'decline': {
        const mine = state.handoffs.filter(handoff => handoff.to === thread);
        const handoff = mine[Number(rest[0] ?? 0)];
        if (!handoff) return { display: 'No such pending handoff' };
        state.handoffs = state.handoffs.filter(item => item !== handoff);
        const giver = state.sessions[handoff.from];
        if (op === 'decline') {
          warn(giver, `${label(thread, entry)} declined ${handoff.paths.join(', ')}`);
          return done();
        }
        Object.assign(entry, { write: true, paths: [...new Set([...entry.paths, ...handoff.paths])].slice(0, PATHS), task: entry.task || handoff.note || handoff.paths.join(' ').slice(0, 80) });
        if (giver) {
          giver.paths = giver.paths.filter(path => !handoff.paths.includes(path));
          if (!giver.paths.length) Object.assign(giver, { write: false, task: '' });
          warn(giver, `${label(thread, entry)} accepted ${handoff.paths.join(', ')}`);
        }
        rewatch();
        return done(`Accepted ${handoff.paths.join(', ')}`);
      }
      case 'release': {
        const target = find(rest[0]);
        const other = target ? state.sessions[target] : undefined;
        if (!target || !other || target === thread) return { display: USAGE };
        if (!confirm('Release a registration', `${label(target, other)} was last seen ${ago(other.at)}${live(other) ? ' and looks active' : ' and looks abandoned'}. `
          + `Remove it and its reservations (${other.paths.join(', ') || 'none'})? Its files are not touched.`)) return null;
        delete state.sessions[target];
        if (state.git?.thread === target) state.git = null;
        return done(`Released ${label(target, other)}`);
      }
      case 'dismiss':
        entry.warnings = [];
        return done();
      case 'worktree': {
        const invoked = api.host.tryCall('builtins.invoke', { command: 'worktree' });
        return done(invoked.ok && invoked.value.invoked ? null : 'Start a worktree with /worktree; parallel write tasks are safest in their own worktree');
      }
    }
    return { display: USAGE };
  }, { description: 'Coordinate sessions sharing this checkout: read-only by default, /share write PATH... -- TASK, handoffs and worktrees' });

  api.on('terminal', ({ ledger }) => {
    const state = load();
    const thread = ledger?.thread_id;
    if (!thread || !Object.keys(state.sessions).length) return null;
    const entry = state.sessions[thread] as Entry | undefined;
    const sessions = Object.entries(state.sessions).sort(([a], [b]) => Number(b === thread) - Number(a === thread));
    const writers = sessions.filter(([, other]) => other.write);
    const id = (name: string) => `omd_shared_checkout_${name}`;
    const act = (args: string) => ({ command: 'omd_shared_checkout:share', args: `@${thread} ${args}`.trim() });
    const role = !entry ? 'not registered yet' : entry.write ? `writer: ${entry.paths.join(', ')}` : 'read-only';
    const conflicts = writers.flatMap(([a, first], index) => writers.slice(index + 1).filter(([, second]) => overlap(first.paths, second.paths).length)
      .map(([b, second]) => `${label(a, first)} and ${label(b, second)} overlap on ${overlap(first.paths, second.paths).join(', ')}`));
    const rows = sessions.map(([other, item]) => ({ value: other, label: fit(label(other, item), 256),
      spans: [{ text: fit(`${other === thread ? '● ' : '  '}${label(other, item)} · ${item.write ? item.paths.join(', ') : 'read-only'} · ${live(item) ? `seen ${ago(item.at)}` : `stale since ${ago(item.at)}`}`, 250),
        tone: !live(item) ? 'attention' as const : item.write ? 'accent' as const : 'muted' as const }] }));
    const pending = state.handoffs.filter(handoff => handoff.to === thread);
    const notes = [...entry?.warnings ?? [], ...conflicts, ...state.git && Date.now() - state.git.at < LEASE ? [`${state.git.command} running for ${label(state.git.thread, state.sessions[state.git.thread])}`] : []];
    const panel: TerminalComponent[] = [
      { type: 'text', id: id('role'), label: 'This session', text: `This session: ${role}. Parallel write tasks are safest in their own worktree.`, tone: entry?.write ? 'accent' : 'muted' },
      { type: 'text', id: id('advisory'), label: 'Enforcement', text: `Reservations are advisory. ${ADVISORY} Edits are never conflict-free and nothing is isolated.`, tone: 'muted' },
      { type: 'list', id: id('sessions'), label: 'Sessions in this checkout', rows, height: Math.min(8, rows.length), action: act('release') },
      ...notes.map((text, index): TerminalComponent => ({ type: 'text', id: id(`note_${index}`), label: 'Warning', text: text.slice(0, 250), tone: 'attention' })),
      ...pending.length ? [{ type: 'select' as const, id: id('handoffs'), label: 'Pending handoffs to this session', value: 'accept 0', action: act(''),
        options: pending.flatMap((handoff, index) => ['accept', 'decline'].map(choice => ({ value: `${choice} ${index}`, label: fit(`${choice} ${handoff.paths.join(', ')} from ${label(handoff.from, state.sessions[handoff.from])}`, 128) }))) }] : [],
      { type: 'input', id: id('write'), label: 'Reserve paths for this session', placeholder: 'src/parser/ src/lexer.ts -- fix the parser', action: act('write') },
      ...entry?.write && sessions.length > 1 ? [{ type: 'select' as const, id: id('handoff'), label: 'Hand off all reserved paths to', value: sessions.find(([other]) => other !== thread)![0], action: act('handoff'),
        options: sessions.filter(([other]) => other !== thread).slice(0, 16).map(([other, item]) => ({ value: other, label: fit(label(other, item), 128) })) }] : [],
      { type: 'select', id: id('actions'), label: 'Shared checkout actions', value: 'worktree', action: act(''),
        options: [{ value: 'worktree', label: 'move this task to a worktree' }, ...entry?.write ? [{ value: 'read', label: 'return to read-only' }] : [], ...entry?.warnings.length ? [{ value: 'dismiss', label: 'dismiss warnings' }] : [], { value: 'toggle', label: 'close' }] },
    ];
    const summary = `${sessions.length} session${sessions.length === 1 ? '' : 's'} · ${writers.length} writing · you: ${entry?.write ? 'writer' : 'read-only'}${notes.length ? ` · ${notes.length} warning${notes.length === 1 ? '' : 's'}` : ''}`;
    const sites: Partial<Record<string, TerminalRenderSite>> = {
      'omd_shared_checkout/checkout': { mode: 'replace', components: panel },
      sidebar: { mode: 'wrap', components: [{ type: 'pane', id: id('sidebar'), label: 'Shared checkout', title: 'Shared checkout', children: [
        { type: 'text', id: id('summary'), label: 'Shared checkout summary', text: summary, tone: notes.length ? 'attention' : 'muted' },
        ...rows.slice(0, 6).map((row, index): TerminalComponent => ({ type: 'line', id: id(`row_${index}`), label: 'Session', spans: row.spans })),
      ] }, { type: 'slot' }] },
      ...entry?.open ? { dialog: { mode: 'wrap' as const, components: [{ type: 'dialog' as const, id: id('dialog'), label: 'Shared checkout', title: 'Shared checkout', children: panel }, { type: 'slot' as const }] } } : {},
    };
    return { sites, status: [`shared: ${entry?.write ? 'writer' : 'read-only'}${notes.length ? ' !' : ''}`] };
  });
}
