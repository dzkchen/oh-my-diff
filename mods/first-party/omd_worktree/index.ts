import type { CommandResult, ExecGuard, Json, ModAPI, TerminalComponent, TerminalRenderSite } from '../../api.d.ts';

type Tree = { path: string; head: string | null; branch: string | null; locked: string | null; prunable: string | null; main: boolean; current: boolean };
type Meta = { task: string; issue: string | null; base: string };
type Integration = { path: string; branch: string; tip: string; summary: string; diff: string; guards: ExecGuard[]; commit: { message: string; tree: string; index: string; paths: string[] } | null };
type State = { trees: Tree[]; tasks: Record<string, Meta>; error: string | null; open: boolean; query: string; selected: string | null; preview: Integration | null; notice: string | null };
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
const NEW_FILES = 8;
const SNAPSHOT = `!f() {
  set -eu
  omd_base=$1
  shift
  test "$(git rev-parse HEAD)" = "$omd_base"
  omd_index=$(git rev-parse --path-format=absolute --git-path index)
  omd_digest=$(git hash-object "$omd_index")
  omd_temp=$(mktemp -d)
  trap 'rm -rf "$omd_temp"' EXIT
  export GIT_INDEX_FILE="$omd_temp/index"
  git read-tree "$omd_base"
  git add -A -- . "$@"
  git write-tree
  printf '%s\\n' "$omd_digest"
}; f`;
const COMMIT = `!f() {
  set -eu
  omd_expected=$1
  omd_base=$2
  omd_tree=$3
  omd_branch=$4
  omd_message=$5
  shift 5
  omd_index=$(git rev-parse --path-format=absolute --git-path index)
  omd_lock="$omd_index.lock"
  if ! (set -C; : > "$omd_lock") 2>/dev/null; then
    echo 'exec_guard_changed: task index is locked' >&2
    exit 1
  fi
  omd_temp=
  omd_advanced=false
  omd_cleanup() {
    if [ "$omd_advanced" = true ]; then
      printf 'Commit created; prepared index retained at %s; original index at %s\\n' "$omd_lock" "$omd_index" >&2
    else
      rm -f "$omd_lock"
    fi
    if [ -n "$omd_temp" ]; then rm -rf "$omd_temp"; fi
  }
  trap omd_cleanup EXIT
  if [ "$(git hash-object "$omd_index")" != "$omd_expected" ] ||
     [ "$(git rev-parse HEAD)" != "$omd_base" ] ||
     [ "$(git symbolic-ref HEAD)" != "refs/heads/$omd_branch" ]; then
    echo 'exec_guard_changed: task branch or index changed' >&2
    exit 1
  fi
  omd_temp=$(mktemp -d)
  export GIT_INDEX_FILE="$omd_temp/index"
  git read-tree "$omd_base"
  git add -A -- . "$@"
  if [ "$(git write-tree)" != "$omd_tree" ]; then
    echo 'exec_guard_changed: task files changed' >&2
    exit 1
  fi
  cp "$omd_index" "$GIT_INDEX_FILE"
  git restore --staged --source="$omd_tree" -- . "$@"
  cp "$GIT_INDEX_FILE" "$omd_lock"
  omd_commit=$(git commit-tree "$omd_tree" -p "$omd_base" -m "$omd_message")
  git update-ref -m "$omd_message" "refs/heads/$omd_branch" "$omd_commit" "$omd_base"
  omd_advanced=true
  mv "$omd_lock" "$omd_index"
  omd_advanced=false
  printf '%s\\n' "$omd_commit"
}; f`;
const ROWS_BYTES = 8_192;
const bytes = (value: unknown) => [...JSON.stringify(value)].reduce((total, char) => {
  const code = char.codePointAt(0) ?? 0;
  return total + (code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4);
}, 0);
const SAFE = /^(?!\/)(?!.*(^|\/)\.\.?(\/|$))(?!\.git(\/|$))[^\u0000-\u001f]{1,200}$/;

export default function activate(api: ModAPI) {
  const empty = (): State => ({ trees: [], tasks: {}, error: null, open: false, query: '', selected: null, preview: null, notice: null });
  const load = (): State => ({ ...empty(), ...(api.state.get() as Partial<State> | null) });
  const save = (state: State) => api.state.set(state as unknown as Json);
  const words = (value: Json) => String(value ?? '').trim();
  const git = (argv: string[], options: { write?: boolean; timeout?: number; guards?: ExecGuard[]; limit?: number; exclusive?: string } = {}): Git => {
    const run = api.host.tryCall('exec.run', { program: 'git', argv: [...GIT, ...argv], timeout_ms: options.timeout ?? 10_000, network: 'none',
      ...(options.write ? { write: true } : {}), ...(options.guards ? { guards: options.guards } : {}), ...(options.limit ? { max_output_bytes: options.limit } : {}), ...(options.exclusive ? { exclusive_workspace: options.exclusive } : {}) });
    if (!run.ok) return { ok: false, out: '', err: run.error, sha: '', truncated: false };
    return { ok: run.value.exit_code === 0, out: run.value.stdout, err: run.value.stderr.trim(), sha: run.value.stdout_sha256, truncated: run.value.stdout_preview_truncated || run.value.stdout_truncated };
  };
  // Task names live in the user-scope store so every session and checkout sees them.
  const tasks = (): { value: Record<string, Meta>; revision: number | null } => {
    const read = api.host.tryCall('store.get', { scope: 'user', key: 'tasks' });
    return read.ok && read.value ? { value: read.value.value as unknown as Record<string, Meta>, revision: read.value.revision } : { value: {}, revision: null };
  };
  const updateTasks = (change: (value: Record<string, Meta>) => void) => {
    for (let attempt = 0; attempt < 2; attempt++) {
      const current = tasks();
      change(current.value);
      const keys = Object.keys(current.value);
      for (const key of keys.slice(0, Math.max(0, keys.length - 100))) delete current.value[key];
      if (api.host.tryCall('store.put', { scope: 'user', key: 'tasks', value: current.value as unknown as Json, expected_revision: current.revision }).ok) return;
    }
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
    state.tasks = tasks().value;
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
  const find = (state: State, target: string) => target ? state.trees.find(tree => tree.path === target || tree.branch === target)
    : state.selected ? state.trees.find(tree => tree.path === state.selected) : undefined;
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
      ?? (item.mode === 'symlink' ? run('ln', ['-s', `${main}/${item.path}`, `${path}/${item.path}`]) : run('cp', ['-cR', `${main}/${item.path}`, `${path}/${parent}`]) && run('cp', ['-R', `${main}/${item.path}`, `${path}/${parent}`]));
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
      api.host.tryCall('commands.invoke', { command: 'resume', args: thread });
      return null;
    }
    const failed = launch(tree.path, tasks().value[tree.path]?.task ?? tree.branch ?? tree.path);
    return failed ? { display: failed } : null;
  };

  api.command('task', value => guard(() => {
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
    updateTasks(value => { value[path] = { task: fit(task, 200), issue, base }; });
    const failures = prepare(main, path, shared, copied);
    refresh(state);
    state.selected = path;
    save(state);
    const failed = launch(path, task);
    return { display: [`Created ${path} on ${branch}`, ...failures.map(failure => `setup failed: ${failure}`), ...(failures.length ? ['The worktree was kept; fix the setup there or remove it with /omd_worktree:remove.'] : []),
      ...(failed ? [`session: ${failed}`] : [])].join('\n') };
  }), { description: 'Create a task worktree: /omd_worktree:task TASK [--base REF] [--branch NAME] [--issue ID] [--reuse]' });

  const jump = (target: string): CommandResult => guard(() => {
    const state = refresh(load());
    const tree = find(state, target);
    save(state);
    return tree ? switchTo(state, tree) : { display: 'usage: /omd_worktree:enter PATH|BRANCH' };
  });
  api.command('enter', value => jump(words(value)), { description: 'Resume the latest session in a worktree, or start one' });

  api.command('adopt', value => guard(() => {
    const state = refresh(load());
    const [target, ...task] = words(value).split(/\s+/);
    const tree = state.trees.find(item => item.path === target || item.branch === target);
    if (!tree || tree.main) return { display: 'usage: /omd_worktree:adopt PATH|BRANCH [TASK] for an existing linked worktree' };
    updateTasks(value => { value[tree.path] = { task: fit(task.join(' ') || tree.branch || tree.path, 200), issue: null, base: tree.head ?? '' }; });
    save(refresh(state));
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
    const excluded = setups().shared.map(item => `:(exclude,literal)${item.path}`);
    const pending = ['-C', tree.path, 'status', '--porcelain=v1', '-z', '--', '.', ...excluded];
    const source = git(pending);
    if (!source.ok) return { display: source.err };
    const dirty = source.out.split('\0').filter(Boolean).length;
    if (!dirty && git(['merge-base', '--is-ancestor', `refs/heads/${tree.branch}`, 'HEAD']).ok) return { display: `${tree.branch} is already integrated` };
    const head = ['rev-parse', 'HEAD'];
    const headed = git(head);
    const tip = ['rev-parse', `refs/heads/${tree.branch}`];
    const tipped = git(tip);
    if (!tipped.ok || !headed.ok) return { display: tipped.err || headed.err };
    const range = `${headed.out.trim()}...${tipped.out.trim()}`;
    const log = git(['log', '--oneline', '--max-count=50', `${headed.out.trim()}..${tipped.out.trim()}`]);
    const stat = git(['diff', '--no-ext-diff', '--stat', range]);
    const diff = git(['diff', '--no-ext-diff', '--no-color', range], { limit: 32_768 });
    if (!log.ok || !stat.ok || !diff.ok) return { display: log.err || stat.err || diff.err || 'Could not preview the task changes' };
    const message = tasks().value[tree.path]?.task ?? `Task ${tree.branch}`;
    const fresh = ['-C', tree.path, 'ls-files', '-z', '--others', '--exclude-standard', '--', '.', ...excluded];
    const listed = dirty ? git(fresh) : null;
    if (listed && (!listed.ok || listed.truncated)) return { display: listed.err || 'The task file inventory is too large to review here' };
    const added = listed?.out.split('\0').filter(Boolean) ?? [];
    if (added.length > NEW_FILES) return { display: `The task worktree has ${added.length} new files; commit them there (or keep at most ${NEW_FILES}) before integrating` };
    const captured = dirty ? git(['-C', tree.path, '-c', `alias.omd-snapshot=${SNAPSHOT}`, 'omd-snapshot', tipped.out.trim(), ...excluded], { write: true }) : null;
    if (captured && (!captured.ok || captured.truncated)) return { display: captured.err || 'Could not capture the task tree' };
    const [capturedTree, capturedIndex] = captured?.out.trim().split('\n') ?? [];
    if (captured && (!/^[a-f0-9]{40,64}$/.test(capturedTree ?? '') || !/^[a-f0-9]{40,64}$/.test(capturedIndex ?? ''))) return { display: 'Could not capture the task tree' };
    const local = captured ? git(['diff', '--no-ext-diff', '--no-color', '--binary', tipped.out.trim(), capturedTree]) : null;
    if (local && (!local.ok || local.truncated)) return { display: local.ok ? 'The task changes are too large to review here; commit them there first' : local.err };
    const full = `${diff.out}${local?.out ?? ''}`;
    const shown = fit(full, 40_000, true);
    state.preview = { path: tree.path, branch: tree.branch, tip: tipped.out.trim(),
      summary: fit(`${dirty ? `Uncommitted changes in the task worktree (${dirty} paths${added.length ? `, ${added.length} new` : ''}) are committed as "${message}" first.\n` : ''}${log.out}${stat.out}`, 4_000, true),
      diff: diff.truncated || shown !== full ? `${fit(shown, 39_900, true)}\n… diff truncated; review the full change in the worktree` : shown,
      guards: [guardOf(head, headed), guardOf(tip, tipped), guardOf(status, destination)],
      commit: local ? { message, tree: capturedTree, index: capturedIndex, paths: excluded } : null };
    state.open = true;
    save(state);
    return null;
  });
  api.command('integrate', value => integrate(words(value)), { description: 'Preview merging a task branch into this checkout' });

  api.command('merge', () => guard(() => {
    const state = load();
    const preview = state.preview;
    if (!preview) return { display: 'Open an integration preview first' };
    state.preview = null;
    let mergeTip = preview.tip;
    if (preview.commit) {
      const committed = git(['-C', preview.path, '-c', `alias.omd-reviewed-commit=${COMMIT}`, 'omd-reviewed-commit', preview.commit.index,
        preview.tip, preview.commit.tree, preview.branch, preview.commit.message, ...preview.commit.paths], { write: true, timeout: 120_000 });
      if (!committed.ok) {
        state.notice = /exec_guard/.test(committed.err) ? 'The task worktree changed since the preview; integrate again to review the current state' : `Committing the task worktree failed: ${committed.err.split('\n').slice(0, 4).join(' ')}`;
        save(refresh(state));
        return { display: state.notice };
      }
      mergeTip = committed.out.trim();
      if (!/^[a-f0-9]{40,64}$/.test(mergeTip)) {
        state.notice = 'The task branch moved while committing; integrate again to review the current state';
        save(refresh(state));
        return { display: state.notice };
      }
    }
    const tip = ['rev-parse', `refs/heads/${preview.branch}`];
    const guards = preview.commit ? preview.guards.filter(item => item.argv?.join(' ') !== [...GIT, ...tip].join(' ')) : preview.guards;
    const merged = git(['merge', '--no-edit', mergeTip], { write: true, timeout: 120_000, guards });
    const aborted = !merged.ok && git(['rev-parse', '--verify', '--quiet', 'MERGE_HEAD']).ok ? git(['merge', '--abort'], { write: true }).ok : true;
    state.notice = merged.ok ? `Integrated ${preview.branch}` : /exec_guard/.test(merged.err) ? 'The checkout or branch changed since the preview; integrate again to review the current state'
      : `Integration failed${aborted ? ' and the checkout was restored' : '; merge recovery is required'}: ${merged.err.split('\n').slice(0, 4).join(' ')}`;
    save(refresh(state));
    return { display: state.notice };
  }), { description: 'Merge the previewed task branch after rechecking it' });

  api.command('hide', () => {
    save({ ...load(), preview: null, open: false });
    return null;
  }, { description: 'Close the worktree dialog' });

  const sessionCheck = (path: string): string | null => {
    let cursor: string | undefined;
    for (let page = 0; page < 4; page++) {
      const listed = api.host.tryCall('app.request', { method: 'thread/list', params: { cwd: path, limit: 100, ...(cursor ? { cursor } : {}) } });
      if (!listed.ok) return 'Session inventory is unavailable; the worktree is kept';
      const result = listed.value as { data?: { status?: { type?: string } }[]; nextCursor?: string | null };
      if (!result || !Array.isArray(result.data) || result.data.some(thread => !thread || !['notLoaded', 'idle', 'systemError', 'active'].includes(thread.status?.type ?? ''))) return 'Session inventory is incomplete; the worktree is kept';
      if (result.data.some(thread => thread.status?.type === 'active')) return `A session is working in ${path}; wait for it to finish`;
      if (result.nextCursor === null) return null;
      if (typeof result.nextCursor !== 'string' || !result.nextCursor || result.nextCursor === cursor) break;
      cursor = result.nextCursor;
    }
    return 'Session inventory is incomplete; the worktree is kept';
  };
  const remove = (value: Json, branch: boolean): CommandResult => guard(() => {
    const state = refresh(load());
    const tree = find(state, words(value));
    if (!tree || tree.main) return { display: 'Choose a linked task worktree' };
    if (tree.current) return { display: 'Switch to another checkout before removing this one' };
    if (tree.locked) return { display: `${tree.path} is locked (${tree.locked}); unlock it with git worktree unlock first` };
    if (tree.prunable) return { display: `${tree.path} was already deleted outside OMD; /omd_worktree:prune removes its record` };
    const busy = sessionCheck(tree.path);
    if (busy) return { display: busy };
    const listing = ['-C', tree.path, 'status', '--porcelain=v1', '-z', '--', '.', ...setups().shared.map(item => `:(exclude,literal)${item.path}`)];
    const status = git(listing);
    if (!status.ok || status.out) return { display: status.ok ? `${tree.path} has uncommitted or untracked changes; they are kept` : status.err };
    const merged = tree.branch ? git(['merge-base', '--is-ancestor', `refs/heads/${tree.branch}`, `${state.trees[0].head}`]).ok : false;
    const preview = [`Remove the checkout ${tree.path}.`, tree.branch ? `Branch ${tree.branch} is ${merged ? 'merged into the main checkout' : 'NOT merged'} and is kept unless you confirm its deletion next.` : '', 'Current OMD processes are checked and locked out during removal. Older runtimes and other applications cannot be checked. Confirm that none are using this checkout before continuing.', 'Session history is kept.'].join('\n');
    if (!confirm(branch ? 'Delete task worktree' : 'Archive task worktree', preview)) return null;
    const changed = sessionCheck(tree.path);
    if (changed) return { display: changed };
    // The status excludes shared setup links and copies, so force removes just those.
    const removed = git(['worktree', 'remove', '--force', tree.path], { write: true, timeout: 60_000, guards: [guardOf(listing, status)], exclusive: tree.path });
    if (!removed.ok) return { display: denied(removed.err, rootFor(state.trees[0].path)) };
    updateTasks(value => { delete value[tree.path]; });
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
  api.command('park', value => remove(value, false), { description: 'Remove a clean task checkout and keep its branch' });
  api.command('remove', value => remove(value, true), { description: 'Remove a clean task checkout, then optionally delete its merged branch' });

  api.command('prune', () => guard(() => {
    const state = refresh(load());
    const gone = state.trees.filter(tree => tree.prunable);
    if (!gone.length) return { display: 'No deleted worktrees to prune' };
    if (!confirm('Prune worktree records', gone.map(tree => `${tree.path}: ${tree.prunable}`).join('\n'))) return null;
    const pruned = git(['worktree', 'prune'], { write: true });
    updateTasks(value => { for (const tree of gone) delete value[tree.path]; });
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

  api.command('action', value => {
    const action = words(value);
    const path = load().selected ?? '';
    return action === 'new' ? { insert: '/omd_worktree:task ' } : action === 'switch' ? jump(path) : action === 'integrate' ? integrate(path)
      : action === 'park' || action === 'remove' ? remove(path, action === 'remove') : null;
  }, { description: 'Run a roster action' });

  api.provide({ name: 'omd.worktrees', version: '1.0.0', methods: { list: { input: 'null', output: 'object' } } }, {
    list: () => {
      const state = refresh(load());
      save(state);
      const meta = tasks().value;
      return { worktrees: state.trees.map(tree => ({ ...tree, task: meta[tree.path]?.task ?? null, issue: meta[tree.path]?.issue ?? null })) };
    },
  });

  for (const event of ['start', 'resume', 'idle'] as const) api.on(event, () => { save(refresh(load())); });

  const label = (meta: Meta | undefined, tree: Tree) => {
    const flags = [tree.main ? 'main' : '', tree.current ? 'here' : '', tree.locked ? 'locked' : '', tree.prunable ? 'deleted' : ''].filter(Boolean).join(', ');
    return `${tree.branch ?? `detached ${tree.head?.slice(0, 8) ?? ''}`}${meta ? ` · ${meta.task}` : ''}${meta?.issue ? ` (#${meta.issue})` : ''}${flags ? ` [${flags}]` : ''}`;
  };
  const roster = (state: State, meta: Record<string, Meta>, site: string): TerminalComponent[] => {
    const needle = state.query.toLowerCase();
    const trees = state.trees.filter(tree => !needle || `${tree.path} ${label(meta[tree.path], tree)}`.toLowerCase().includes(needle));
    let total = 0;
    const selected = trees.find(tree => tree.path === state.selected);
    return [
      { type: 'input', id: `omd_worktree_${site}_search`, label: 'Search worktrees', value: state.query, placeholder: 'branch, task or path; Enter filters', action: { command: 'omd_worktree:list', args: 'search' } },
      { type: 'list', id: `omd_worktree_${site}_roster`, label: 'Task worktrees', rows: trees.filter(tree => fit(tree.path, 256) === tree.path).slice(0, 200).map(tree => ({ value: tree.path, label: fit(label(meta[tree.path], tree), 256),
        spans: [{ text: fit(label(meta[tree.path], tree), 140), tone: tree.prunable ? 'failure' as const : tree.current ? 'accent' as const : 'normal' as const }, { text: fit(`  ${tree.path}`, 110), tone: 'muted' as const }] })).filter(row => (total += bytes(row)) <= ROWS_BYTES),
        ...(selected ? { selected: selected.path } : {}), action: { command: 'omd_worktree:list', args: 'select' } },
      ...(selected && !selected.main ? [{ type: 'select' as const, id: `omd_worktree_${site}_actions`, label: fit(`Act on ${selected.branch ?? selected.path}`, 128), value: 'switch',
        options: [['switch', 'switch'], ['integrate', 'integrate'], ['park', 'remove checkout, keep branch'], ['remove', 'remove']].map(([value, label]) => ({ value, label })), action: { command: 'omd_worktree:action' } }] : []),
      { type: 'button', id: `omd_worktree_${site}_new`, label: 'Create a task worktree', text: 'New task…', action: { command: 'omd_worktree:action', args: 'new' } },
    ];
  };
  api.on('terminal', () => {
    const state = load();
    const meta = state.tasks;
    const sites: Record<string, TerminalRenderSite> = { 'omd_worktree/roster': { mode: 'replace', components: state.error ? [{ type: 'text', id: 'omd_worktree_error', label: 'Worktrees unavailable', text: state.error, tone: 'muted' }] : roster(state, meta, 'site') } };
    const preview = state.preview;
    if (preview) sites.dialog = { mode: 'replace', components: [{ type: 'dialog', id: 'omd_worktree_dialog', label: 'Integrate task branch', title: fit(`Merge ${preview.branch} into this checkout?`, 128), children: [
      { type: 'code', id: 'omd_worktree_summary', label: 'Commits and changed files', text: preview.summary || 'no commits' },
      { type: 'diff', id: 'omd_worktree_diff', label: `Diff of ${preview.branch}`, unified: preview.diff, height: 16 },
      { type: 'button', id: 'omd_worktree_confirm', label: 'Merge after rechecking HEAD, the branch and a clean checkout', text: preview.commit ? 'Commit and merge' : 'Merge', action: { command: 'omd_worktree:merge' } },
      { type: 'button', id: 'omd_worktree_cancel', label: 'Close without merging', text: 'Cancel', action: { command: 'omd_worktree:hide' } },
    ] }] };
    else if (state.open) sites.dialog = { mode: 'replace', components: [{ type: 'dialog', id: 'omd_worktree_dialog', label: 'Task worktrees', title: 'Task worktrees', children: [...roster(state, meta, 'dialog'),
      ...(state.notice ? [{ type: 'text' as const, id: 'omd_worktree_notice', label: 'Last result', text: state.notice, tone: 'muted' as const }] : []),
      { type: 'button', id: 'omd_worktree_close', label: 'Close the roster', text: 'Close', action: { command: 'omd_worktree:hide' } }] }] };
    return { sites };
  });
}
