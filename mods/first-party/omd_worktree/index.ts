import type { CommandResult, ExecGuard, Json, ModAPI, TerminalComponent, TerminalRenderSite } from '../../api.d.ts';

type Tree = { path: string; head: string | null; branch: string | null; locked: string | null; prunable: string | null; main: boolean; current: boolean };
type Meta = { task: string; issue: string | null; base: string };
type Integration = { path: string; branch: string; summary: string; diff: string; guards: ExecGuard[]; commit: { message: string; guards: ExecGuard[] } | null };
type State = { trees: Tree[]; error: string | null; meta: Record<string, Meta>; open: boolean; query: string; selected: string | null; preview: Integration | null; notice: string | null };
type Git = { ok: boolean; out: string; err: string; sha: string; truncated: boolean };
type Setup = { path: string; mode: 'symlink' | 'clone' };

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
const GIT = ['--no-pager', '-c', 'core.fsmonitor=false', '-c', 'core.quotepath=false'];
const SAFE = /^(?!\/)(?!.*(^|\/)\.\.?(\/|$))(?!\.git(\/|$))[^\u0000-\u001f]{1,200}$/;

export default function activate(api: ModAPI) {
  const empty = (): State => ({ trees: [], error: null, meta: {}, open: false, query: '', selected: null, preview: null, notice: null });
  const load = (): State => ({ ...empty(), ...(api.state.get() as Partial<State> | null) });
  const save = (state: State) => api.state.set(state as unknown as Json);
  const words = (value: Json) => String(value ?? '').trim();
  const git = (argv: string[], options: { write?: boolean; timeout?: number; guards?: ExecGuard[] } = {}): Git => {
    const run = api.host.tryCall('exec.run', { program: 'git', argv: [...GIT, ...argv], timeout_ms: options.timeout ?? 10_000, network: 'none',
      ...(options.write ? { write: true } : {}), ...(options.guards ? { guards: options.guards } : {}) });
    if (!run.ok) return { ok: false, out: '', err: run.error, sha: '', truncated: false };
    return { ok: run.value.exit_code === 0, out: run.value.stdout, err: run.value.stderr.trim(), sha: run.value.stdout_sha256, truncated: run.value.stdout_preview_truncated };
  };
  const guardOf = (argv: string[], run: Git): ExecGuard => ({ program: 'git', argv: [...GIT, ...argv], stdout_sha256: run.sha });
  const ask = (title: string, message: string) => {
    const answer = api.host.tryCall('terminal.prompt', { kind: 'text', title, message });
    return answer.ok && answer.value.status === 'accepted' ? (answer.value.value ?? '').trim() : null;
  };
  const confirm = (title: string, message: string) => {
    const answer = api.host.tryCall('terminal.prompt', { kind: 'confirm', title, message });
    return answer.ok && answer.value.status === 'accepted';
  };
  const guard = (run: () => CommandResult): CommandResult => {
    try {
      return run();
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      return { display: `worktree: ${error.message}` };
    }
  };

  const refresh = (state: State) => {
    const listed = git(['worktree', 'list', '--porcelain', '-z']);
    const top = git(['rev-parse', '--show-toplevel']);
    state.error = listed.ok && top.ok ? null : listed.err || top.err || 'not a Git repository';
    state.trees = [];
    if (state.error) return state;
    for (const field of listed.out.split('\0')) {
      const [key, ...rest] = field.split(' ');
      const value = rest.join(' ');
      if (key === 'worktree') state.trees.push({ path: value, head: null, branch: null, locked: null, prunable: null, main: !state.trees.length, current: value === top.out.trim() });
      const tree = state.trees.at(-1);
      if (!tree) continue;
      if (key === 'HEAD') tree.head = value;
      if (key === 'branch') tree.branch = value.replace(/^refs\/heads\//, '');
      if (key === 'locked') tree.locked = value || 'locked';
      if (key === 'prunable') tree.prunable = value || 'missing';
    }
    return state;
  };
  const find = (state: State, target: string) => state.trees.find(tree => tree.path === target || tree.branch === target)
    ?? (state.selected ? state.trees.find(tree => tree.path === state.selected) : undefined);
  const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'task';
  const option = (text: string, name: string) => new RegExp(`(?:^|\\s)--${name}\\s+(\\S+)`).exec(text)?.[1] ?? null;
  const strip = (text: string) => text.replace(/(?:^|\s)--(?:base|branch|issue)\s+\S+/g, '').replace(/(?:^|\s)--reuse\b/g, '').trim();
  const setups = (): { shared: Setup[]; copy: string[] } => {
    const shared = (Array.isArray(api.settings.shared) ? api.settings.shared : []).flatMap(item => {
      const entry = item as Partial<Setup> | null;
      return entry && typeof entry.path === 'string' && SAFE.test(entry.path) && (entry.mode === 'symlink' || entry.mode === 'clone') ? [{ path: entry.path, mode: entry.mode }] : [];
    });
    const copy = (Array.isArray(api.settings.copy) ? api.settings.copy : []).filter((path): path is string => typeof path === 'string' && SAFE.test(path));
    return { shared: shared.slice(0, 8), copy: copy.slice(0, 8) };
  };
  const rootFor = (main: string) => {
    const configured = typeof api.settings.root === 'string' ? api.settings.root.trim().replace(/\/+$/, '') : '';
    return configured || `${main}.worktrees`;
  };
  const denied = (error: string, root: string) => /permission|not permitted|read-only|denied|unable to create|could not create/i.test(error)
    ? `${error}\nWorktrees need write access to Git metadata and ${root}. Add to your Codex config and select the profile:\n[permissions.worktrees]\nextends = ":workspace"\n[permissions.worktrees.filesystem.":workspace_roots"]\n".git" = "write"\n[permissions.worktrees.filesystem]\n"${root}" = "write"\nUpstream /worktree remains available.`
    : error;
  const run = (program: string, argv: string[]) => {
    const done = api.host.tryCall('exec.run', { program, argv, write: true, timeout_ms: 60_000, network: 'none' });
    return done.ok && done.value.exit_code === 0 ? null : `${program} ${argv.at(-1)}: ${done.ok ? done.value.stderr.trim() : done.error}`;
  };
  const prepare = (main: string, path: string, shared: Setup[], copy: string[]) => [...shared.map(item => {
    const parent = item.path.includes('/') ? item.path.slice(0, item.path.lastIndexOf('/')) : '';
    return (parent ? run('mkdir', ['-p', `${path}/${parent}`]) : null)
      ?? (item.mode === 'symlink' ? run('ln', ['-s', `${main}/${item.path}`, `${path}/${item.path}`]) : run('cp', ['-cR', `${main}/${item.path}`, `${path}/${item.path}`]) && run('cp', ['-R', `${main}/${item.path}`, `${path}/${item.path}`]));
  }), ...copy.map(file => {
    const parent = file.includes('/') ? file.slice(0, file.lastIndexOf('/')) : '';
    return (parent ? run('mkdir', ['-p', `${path}/${parent}`]) : null) ?? run('cp', ['-p', `${main}/${file}`, `${path}/${file}`]);
  })].filter((failure): failure is string => failure !== null);
  const launch = (path: string, name: string): string | null => {
    const started = api.host.tryCall('app.request', { method: 'thread/start', params: { cwd: path } });
    const id = started.ok ? (started.value as { thread?: { id?: string } }).thread?.id : undefined;
    if (!id) return started.ok ? 'session start declined' : started.error;
    api.host.tryCall('app.request', { method: 'thread/name/set', params: { threadId: id, name: name.slice(0, 80) } });
    api.host.tryCall('terminal.show_thread', { thread_id: id });
    return null;
  };
  const switchTo = (state: State, tree: Tree): CommandResult => {
    if (tree.current) return { display: `Already in ${tree.path}` };
    if (tree.prunable) return { display: `${tree.path} no longer exists; /omd_worktree:prune removes its record` };
    const listed = api.host.tryCall('app.request', { method: 'thread/list', params: { cwd: tree.path, limit: 1, sortKey: 'updated_at' } });
    const thread = listed.ok ? (listed.value as { data?: { id?: string }[] }).data?.[0]?.id : undefined;
    if (thread) {
      api.host.tryCall('builtins.invoke', { command: 'resume', args: thread });
      return null;
    }
    const failed = launch(tree.path, state.meta[tree.path]?.task ?? tree.branch ?? tree.path);
    return failed ? { display: failed } : null;
  };

  api.command('new', value => guard(() => {
    const text = words(value);
    const state = refresh(load());
    if (state.error) return { display: state.error };
    const task = strip(text) || ask('New task worktree', 'Describe the task; it names the branch.');
    if (!task) return null;
    const issue = option(text, 'issue');
    const head = git(['rev-parse', '--abbrev-ref', 'HEAD']).out.trim();
    const base = option(text, 'base') ?? head;
    const commit = git(['rev-parse', '--verify', '--quiet', `${base}^{commit}`]);
    if (!commit.ok) return { display: `Unknown base ${base}; use a branch, remote branch or commit` };
    const branch = option(text, 'branch') ?? `${typeof api.settings.branch_prefix === 'string' ? api.settings.branch_prefix : 'omd/'}${issue ? `${slug(issue)}-` : ''}${slug(task)}`;
    if (!git(['check-ref-format', '--branch', branch]).ok) return { display: `Invalid branch name ${branch}` };
    const existing = state.trees.find(tree => tree.branch === branch);
    if (existing) return /(?:^|\s)--reuse\b/.test(text) ? switchTo(state, existing) : { display: `${branch} is already checked out at ${existing.path}; add --reuse to switch to it` };
    const known = git(['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]).ok;
    const main = state.trees[0].path;
    const root = rootFor(main);
    const path = `${root}/${branch.replace(/\//g, '-')}`;
    const { shared, copy } = setups();
    const plan = [`Create ${path}`, known ? `on the existing branch ${branch}` : `on a new branch ${branch} from ${base} (${commit.out.trim().slice(0, 12)})`,
      ...shared.map(item => `${item.mode} ${item.path} from the main checkout`), ...(copy.length ? [`copy ${copy.join(', ')} (asked separately)`] : []), 'Then start a session there.'].join('\n');
    if (!confirm('Create task worktree', plan)) return null;
    const copied = copy.length && confirm('Copy files into the worktree', `Copy ${copy.join(', ')} from ${main} into ${path}? These files may hold secrets.`) ? copy : [];
    const added = git(['worktree', 'add', ...(known ? [path, branch] : ['-b', branch, path, commit.out.trim()])], { write: true, timeout: 120_000 });
    if (!added.ok) return { display: denied(added.err, root) };
    state.meta[path] = { task: task.slice(0, 200), issue, base };
    const failures = prepare(main, path, shared, copied);
    refresh(state);
    state.selected = path;
    save(state);
    const failed = launch(path, task);
    return { display: [`Created ${path} on ${branch}`, ...failures.map(failure => `setup failed: ${failure}`), ...(failures.length ? ['The worktree was kept; fix the setup there or remove it with /omd_worktree:remove.'] : []),
      ...(failed ? [`session: ${failed}`] : [])].join('\n') };
  }), { description: 'Create a task worktree: /omd_worktree:new TASK [--base REF] [--branch NAME] [--issue ID] [--reuse]' });

  const jump = (target: string): CommandResult => guard(() => {
    const state = refresh(load());
    const tree = find(state, target);
    save(state);
    return tree ? switchTo(state, tree) : { display: 'usage: /omd_worktree:switch PATH|BRANCH' };
  });
  api.command('switch', value => jump(words(value)), { description: 'Resume the latest session in a worktree, or start one' });

  api.command('import', value => guard(() => {
    const state = refresh(load());
    const [target, ...task] = words(value).split(/\s+/);
    const tree = state.trees.find(item => item.path === target || item.branch === target);
    if (!tree || tree.main) return { display: 'usage: /omd_worktree:import PATH|BRANCH [TASK] for an existing linked worktree' };
    state.meta[tree.path] = { task: task.join(' ') || tree.branch || tree.path, issue: null, base: tree.head ?? '' };
    save(state);
    return { display: `Imported ${tree.path}` };
  }), { description: 'Adopt an externally created worktree into the task roster' });

  const integrate = (target: string): CommandResult => guard(() => {
    const state = refresh(load());
    const tree = find(state, target);
    if (!tree?.branch) return { display: 'usage: /omd_worktree:integrate PATH|BRANCH (a worktree on a branch)' };
    if (tree.current) return { display: 'Run this from the destination checkout, not from the task worktree' };
    const status = ['status', '--porcelain=v1', '-z', '--untracked-files=no'];
    const destination = git(status);
    if (!destination.ok || destination.out) return { display: destination.ok ? 'The destination checkout has uncommitted changes; commit or stash them yourself first' : destination.err };
    const pending = ['-C', tree.path, 'status', '--porcelain=v1', '-z'];
    const source = git(pending);
    if (!source.ok) return { display: source.err };
    if (!source.out && git(['merge-base', '--is-ancestor', `refs/heads/${tree.branch}`, 'HEAD']).ok) return { display: `${tree.branch} is already integrated` };
    const range = `HEAD...refs/heads/${tree.branch}`;
    const log = git(['log', '--oneline', '--max-count=50', `HEAD..refs/heads/${tree.branch}`]);
    const stat = git(['diff', '--no-ext-diff', '--stat', range]);
    const diff = git(['diff', '--no-ext-diff', '--no-color', range]);
    const message = state.meta[tree.path]?.task ?? `Task ${tree.branch}`;
    const content = ['-C', tree.path, 'diff', '--no-ext-diff', '--no-color', '--binary', 'HEAD'];
    const local = source.out ? git(content) : null;
    const untracked = source.out ? git(['-C', tree.path, 'ls-files', '--others', '--exclude-standard']).out.trim() : '';
    const full = `${diff.out}${local?.out ?? ''}${untracked ? `\nNew untracked files:\n${untracked}\n` : ''}`;
    const shown = fit(full, 48_000, true);
    const head = ['rev-parse', 'HEAD'];
    const tip = ['rev-parse', `refs/heads/${tree.branch}`];
    state.preview = { path: tree.path, branch: tree.branch,
      summary: fit(`${source.out ? `Uncommitted changes in the task worktree (${source.out.split('\0').filter(Boolean).length} paths) are committed as "${message}" first.\n` : ''}${log.out}${stat.out}`, 4_000, true),
      diff: diff.truncated || shown !== full ? `${fit(shown, 47_900, true)}\n… diff truncated; review the full change in the worktree` : shown,
      guards: [guardOf(head, git(head)), ...(source.out ? [] : [guardOf(tip, git(tip))]), guardOf(status, destination)],
      commit: local ? { message, guards: [guardOf(pending, source), guardOf(content, local)] } : null };
    state.open = true;
    save(state);
    return null;
  });
  api.command('integrate', value => integrate(words(value)), { description: 'Preview merging a task branch into this checkout' });

  api.command('confirm', () => guard(() => {
    const state = load();
    const preview = state.preview;
    if (!preview) return { display: 'Open an integration preview first' };
    state.preview = null;
    if (preview.commit) {
      const added = git(['-C', preview.path, 'add', '-A'], { write: true, guards: preview.commit.guards });
      const committed = added.ok ? git(['-C', preview.path, 'commit', '--quiet', '-m', preview.commit.message], { write: true, timeout: 120_000 }) : added;
      if (!committed.ok) {
        state.notice = /exec_guard/.test(committed.err) ? 'The task worktree changed since the preview; integrate again to review the current state' : `Committing the task worktree failed: ${committed.err.split('\n').slice(0, 4).join(' ')}`;
        save(refresh(state));
        return { display: state.notice };
      }
    }
    const merged = git(['merge', '--no-edit', `refs/heads/${preview.branch}`], { write: true, timeout: 120_000, guards: preview.guards });
    if (!merged.ok && git(['rev-parse', '--verify', '--quiet', 'MERGE_HEAD']).ok) git(['merge', '--abort'], { write: true });
    state.notice = merged.ok ? `Integrated ${preview.branch}` : /exec_guard/.test(merged.err) ? 'The checkout or branch changed since the preview; integrate again to review the current state'
      : `Integration failed and the checkout was restored: ${merged.err.split('\n').slice(0, 4).join(' ')}`;
    save(refresh(state));
    return { display: state.notice };
  }), { description: 'Merge the previewed task branch after rechecking it' });

  api.command('cancel', () => {
    save({ ...load(), preview: null, open: false });
    return null;
  }, { description: 'Close the worktree dialog' });

  const remove = (value: Json, branch: boolean): CommandResult => guard(() => {
    const state = refresh(load());
    const tree = find(state, words(value));
    if (!tree || tree.main) return { display: 'Choose a linked task worktree' };
    if (tree.current) return { display: 'Switch to another checkout before removing this one' };
    if (tree.locked) return { display: `${tree.path} is locked (${tree.locked}); unlock it with git worktree unlock first` };
    if (tree.prunable) return { display: `${tree.path} was already deleted outside OMD; /omd_worktree:prune removes its record` };
    const listed = api.host.tryCall('app.request', { method: 'thread/list', params: { cwd: tree.path, limit: 20 } });
    const busy = listed.ok && ((listed.value as { data?: { status?: { type?: string } }[] }).data ?? []).some(thread => thread.status?.type === 'active');
    if (busy) return { display: `A session is working in ${tree.path}; wait for it to finish` };
    const status = git(['-C', tree.path, 'status', '--porcelain=v1', '-z']);
    if (!status.ok || status.out) return { display: status.ok ? `${tree.path} has uncommitted or untracked changes; they are kept` : status.err };
    const merged = tree.branch ? git(['merge-base', '--is-ancestor', `refs/heads/${tree.branch}`, `${state.trees[0].head}`]).ok : false;
    const preview = [`Remove the checkout ${tree.path}.`, tree.branch ? `Branch ${tree.branch} is ${merged ? 'merged into the main checkout' : 'NOT merged'} and is kept unless you confirm its deletion next.` : '', 'Session history is kept.'].join('\n');
    if (!confirm(branch ? 'Delete task worktree' : 'Archive task worktree', preview)) return null;
    const removed = git(['worktree', 'remove', tree.path], { write: true, timeout: 60_000 });
    if (!removed.ok) return { display: denied(removed.err, rootFor(state.trees[0].path)) };
    delete state.meta[tree.path];
    let note = `Removed ${tree.path}`;
    if (branch && tree.branch) {
      if (!merged) note += `; ${tree.branch} has unmerged commits and was kept`;
      else if (confirm('Delete branch', `Delete the merged branch ${tree.branch}?`)) {
        const deleted = git(['branch', '-d', tree.branch], { write: true });
        note += deleted.ok ? `; deleted ${tree.branch}` : `; ${tree.branch} kept: ${deleted.err}`;
      }
    }
    state.selected = null;
    save(refresh(state));
    return { display: note };
  });
  api.command('archive', value => remove(value, false), { description: 'Remove a clean task checkout and keep its branch' });
  api.command('remove', value => remove(value, true), { description: 'Remove a clean task checkout, then optionally delete its merged branch' });

  api.command('prune', () => guard(() => {
    const state = refresh(load());
    const gone = state.trees.filter(tree => tree.prunable);
    if (!gone.length) return { display: 'No deleted worktrees to prune' };
    if (!confirm('Prune worktree records', gone.map(tree => `${tree.path}: ${tree.prunable}`).join('\n'))) return null;
    const pruned = git(['worktree', 'prune'], { write: true });
    for (const tree of gone) delete state.meta[tree.path];
    save(refresh(state));
    return { display: pruned.ok ? `Pruned ${gone.length} records` : pruned.err };
  }), { description: 'Remove Git records of worktrees deleted outside OMD' });

  api.command('list', value => guard(() => {
    const text = words(value);
    const state = refresh(load());
    if (text.startsWith('select ')) state.selected = text.slice(7);
    else if (text.startsWith('search')) state.query = text.slice(6).trim();
    else state.open = !state.open;
    save(state);
    return state.error ? { display: state.error } : null;
  }), { description: 'Toggle the searchable task worktree roster' });

  api.command('act', value => {
    const action = words(value);
    const path = load().selected ?? '';
    return action === 'new' ? { insert: '/omd_worktree:new ' } : action === 'switch' ? jump(path) : action === 'integrate' ? integrate(path)
      : action === 'archive' || action === 'remove' ? remove(path, action === 'remove') : null;
  }, { description: 'Run a roster action' });

  api.provide({ name: 'omd.worktrees', version: '1.0.0', methods: { list: { input: 'null', output: 'object' } } }, {
    list: () => {
      const state = refresh(load());
      save(state);
      return { worktrees: state.trees.map(tree => ({ ...tree, task: state.meta[tree.path]?.task ?? null, issue: state.meta[tree.path]?.issue ?? null })) };
    },
  });

  for (const event of ['start', 'resume', 'idle'] as const) api.on(event, () => { save(refresh(load())); });

  const label = (state: State, tree: Tree) => {
    const meta = state.meta[tree.path];
    const flags = [tree.main ? 'main' : '', tree.current ? 'here' : '', tree.locked ? 'locked' : '', tree.prunable ? 'deleted' : ''].filter(Boolean).join(', ');
    return `${tree.branch ?? `detached ${tree.head?.slice(0, 8) ?? ''}`}${meta ? ` · ${meta.task}` : ''}${meta?.issue ? ` (#${meta.issue})` : ''}${flags ? ` [${flags}]` : ''}`;
  };
  const roster = (state: State): TerminalComponent[] => {
    const needle = state.query.toLowerCase();
    const trees = state.trees.filter(tree => !needle || `${tree.path} ${label(state, tree)}`.toLowerCase().includes(needle));
    const selected = trees.find(tree => tree.path === state.selected);
    return [
      { type: 'input', id: 'omd_worktree_search', label: 'Search worktrees', value: state.query, placeholder: 'branch, task or path; Enter filters', action: { command: 'omd_worktree:list', args: 'search' } },
      { type: 'list', id: 'omd_worktree_roster', label: 'Task worktrees', rows: trees.filter(tree => fit(tree.path, 256) === tree.path).slice(0, 200).map(tree => ({ value: tree.path, label: fit(label(state, tree), 256),
        spans: [{ text: fit(label(state, tree), 140), tone: tree.prunable ? 'failure' : tree.current ? 'accent' : 'normal' }, { text: fit(`  ${tree.path}`, 110), tone: 'muted' }] })),
        ...(selected ? { selected: selected.path } : {}), action: { command: 'omd_worktree:list', args: 'select' } },
      ...(selected && !selected.main ? [{ type: 'select' as const, id: 'omd_worktree_actions', label: fit(`Act on ${selected.branch ?? selected.path}`, 128), value: 'switch',
        options: ['switch', 'integrate', 'archive', 'remove'].map(action => ({ value: action, label: action })), action: { command: 'omd_worktree:act' } }] : []),
      { type: 'button', id: 'omd_worktree_new', label: 'Create a task worktree', text: 'New task…', action: { command: 'omd_worktree:act', args: 'new' } },
    ];
  };
  api.on('terminal', () => {
    const state = load();
    const sites: Record<string, TerminalRenderSite> = { 'omd_worktree/roster': { mode: 'replace', components: state.error ? [{ type: 'text', id: 'omd_worktree_error', label: 'Worktrees unavailable', text: state.error, tone: 'muted' }] : roster(state) } };
    const preview = state.preview;
    if (preview) sites.dialog = { mode: 'replace', components: [{ type: 'dialog', id: 'omd_worktree_dialog', label: 'Integrate task branch', title: fit(`Merge ${preview.branch} into this checkout?`, 128), children: [
      { type: 'code', id: 'omd_worktree_summary', label: 'Commits and changed files', text: preview.summary || 'no commits' },
      { type: 'diff', id: 'omd_worktree_diff', label: `Diff of ${preview.branch}`, unified: preview.diff, height: 16 },
      { type: 'button', id: 'omd_worktree_confirm', label: 'Merge after rechecking HEAD, the branch and a clean checkout', text: preview.commit ? 'Commit and merge' : 'Merge', action: { command: 'omd_worktree:confirm' } },
      { type: 'button', id: 'omd_worktree_cancel', label: 'Close without merging', text: 'Cancel', action: { command: 'omd_worktree:cancel' } },
    ] }] };
    else if (state.open) sites.dialog = { mode: 'replace', components: [{ type: 'dialog', id: 'omd_worktree_dialog', label: 'Task worktrees', title: 'Task worktrees', children: [...roster(state),
      ...(state.notice ? [{ type: 'text' as const, id: 'omd_worktree_notice', label: 'Last result', text: state.notice, tone: 'muted' as const }] : []),
      { type: 'button', id: 'omd_worktree_close', label: 'Close the roster', text: 'Close', action: { command: 'omd_worktree:cancel' } }] }] };
    return { sites };
  });
}
