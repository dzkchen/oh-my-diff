import type { Json, ModAPI, ResourceRef } from '../../api.d.ts';

type Repo = { top: string; gitdir: string };
type Snap = { commit: string; tree: string };
type Change = { path: string; target: string | null; status: string };
type Entry = {
  thread: string; turn: string; outcome: string; at: number; before: string; after: string; count: number; paths: string[];
  undone: { at: number; before: string; after: string } | null;
};
type State = { entries: Entry[]; pending: Record<string, { turn: string; before: string; at: number }>; error: string | null };
type Outcome = { done: string; current: Snap; after: Snap } | { refused: string };

const REFS = 'refs/omd/checkpoints/';
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const KEEP = 10;
const SHOWN = 12;
const BATCH = 128;
const STDIN_BYTES = 60_000;
const DIFF_BYTES = 900_000;
const PAGE_BYTES = 16_384;
const LIST_ENTRIES = 2_000;
const STALE_MS = 3 * 60 * 60 * 1000;
const ADD_MS = 20_000;
const GIT_MS = 5_000;
const RESTORE_MS = 30_000;
const IDENTITY = ['-c', 'user.name=OMD checkpoint', '-c', 'user.email=omd@localhost'];
const encoder = new TextEncoder();

const chunks = <T>(items: T[], size: number) => Array.from({ length: Math.ceil(items.length / size) }, (_, index) => items.slice(index * size, (index + 1) * size));
const byBytes = (paths: string[]) => {
  const out: string[][] = [[]];
  let used = 0;
  for (const path of paths) {
    const bytes = encoder.encode(path).length + 1;
    if (used + bytes > STDIN_BYTES && out.at(-1)!.length) {
      out.push([]);
      used = 0;
    }
    out.at(-1)!.push(path);
    used += bytes;
  }
  return out.filter(part => part.length);
};
const listed = (paths: string[], total = paths.length) => `${paths.slice(0, SHOWN).join(', ')}${total > SHOWN ? ` and ${total - SHOWN} more` : ''}`;
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;
const clock = (at: number) => new Date(at).toISOString().slice(11, 16);
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

export default function activate(api: ModAPI) {
  const load = (): State => ({ entries: [], pending: {}, error: null, ...api.state.get() as Partial<State> | null });
  const save = (state: State) => api.state.set(state as unknown as Json);

  const here = (): { thread: string | null; cwd?: string } => {
    try {
      const session = api.session();
      return { thread: session.thread_id, cwd: session.cwd };
    } catch {
      return { thread: null };
    }
  };
  const exec = (cwd: string | undefined, argv: string[], options: { env?: Record<string, string>; stdin?: string; timeout?: number; artifact?: boolean } = {}) => {
    const run = api.host.tryCall('exec.run', {
      program: 'git', argv: ['--no-pager', '--literal-pathspecs', '-c', 'core.quotepath=false', ...argv], ...cwd ? { cwd } : {}, sandbox: 'none',
      timeout_ms: options.timeout ?? GIT_MS, ...options.env ? { env: options.env } : {}, ...options.stdin === undefined ? {} : { stdin: options.stdin },
      ...options.artifact ? { output_artifact: true, max_output_bytes: DIFF_BYTES } : {},
    });
    if (!run.ok) throw new Error(run.error.startsWith('exec_program_unavailable') ? 'git was not found on PATH' : run.error);
    const result = run.value;
    if (result.timed_out) throw new Error(`git ${argv[0]} took too long`);
    if (result.exit_code !== 0) {
      const detail = (result.stderr || result.stdout).trim().split('\n')[0] || `git ${argv[0]} failed`;
      throw new Error(/index\.lock/.test(detail) ? `${detail} (an earlier snapshot was interrupted; delete that .lock file)` : detail);
    }
    if (result.stdout_truncated) throw new Error(`git ${argv[0]} printed more than OMD can read`);
    return result;
  };
  const git = (cwd: string | undefined, argv: string[], options: { env?: Record<string, string>; stdin?: string; timeout?: number } = {}) => {
    const result = exec(cwd, argv, options);
    if (result.stdout_preview_truncated) throw new Error(`git ${argv[0]} printed more than OMD can read`);
    return result.stdout;
  };
  const paged = (cwd: string, argv: string[]) => {
    const result = exec(cwd, argv, { artifact: true });
    if (!result.stdout_preview_truncated) return result.stdout;
    if (!result.output_artifact) throw new Error(`git ${argv[0]} printed more than OMD can read`);
    let text = '';
    let cursor: number | null = 0;
    while (cursor !== null) {
      const page: { ok: true; value: { text: string; cursor: number | null } } | { ok: false; error: string } = api.host.tryCall('exec.output_page', { artifact: result.output_artifact as ResourceRef, cursor, max_bytes: PAGE_BYTES });
      if (!page.ok) throw new Error(`reading git ${argv[0]} output failed: ${page.error}`);
      const next: number | null = page.value.cursor;
      text += page.value.text;
      cursor = next;
    }
    return text;
  };
  const repo = (): Repo => {
    const [top = '', gitdir = ''] = git(here().cwd, ['rev-parse', '--show-toplevel', '--absolute-git-dir']).trim().split('\n');
    if (!top || !gitdir) throw new Error('not a Git repository');
    return { top, gitdir };
  };
  const head = (r: Repo) => {
    const run = api.host.tryCall('exec.run', { program: 'git', argv: ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], cwd: r.top, sandbox: 'none', timeout_ms: GIT_MS });
    return run.ok && run.value.exit_code === 0 ? run.value.stdout.trim() : '';
  };
  const snapshot = (r: Repo, thread: string, label: string): Snap => {
    const env = { GIT_INDEX_FILE: `${r.gitdir}/omd-checkpoint-${thread.replace(/[^A-Za-z0-9-]/g, '').slice(0, 64) || 'session'}.index` };
    const parent = head(r);
    if (parent && git(r.top, ['write-tree'], { env }).trim() === EMPTY_TREE) git(r.top, ['read-tree', parent], { env });
    git(r.top, ['add', '--all'], { env, timeout: ADD_MS });
    const tree = git(r.top, ['write-tree'], { env }).trim();
    const commit = git(r.top, [...IDENTITY, 'commit-tree', tree, ...parent ? ['-p', parent] : [], '-m', label]).trim();
    return { commit, tree };
  };
  const pin = (r: Repo, commits: string[]) => {
    try {
      git(r.top, ['update-ref', '--stdin'], { stdin: commits.map(commit => `update ${REFS}${commit} ${commit}\n`).join('') });
    } catch {
      return;
    }
  };
  const keepRefs = (r: Repo, state: State) => {
    try {
      const wanted = new Set([
        ...state.entries.flatMap(entry => [entry.before, entry.after, ...entry.undone ? [entry.undone.before, entry.undone.after] : []]),
        ...Object.values(state.pending).map(pending => pending.before),
      ]);
      const present = git(r.top, ['for-each-ref', '--format=%(refname)', REFS]).split('\n').filter(Boolean);
      const lines = [
        ...present.filter(ref => !wanted.has(ref.slice(REFS.length))).map(ref => `delete ${ref}`),
        ...[...wanted].filter(commit => !present.includes(REFS + commit)).map(commit => `update ${REFS}${commit} ${commit}`),
      ];
      for (const part of chunks(lines, 500)) git(r.top, ['update-ref', '--stdin'], { stdin: `${part.join('\n')}\n` });
    } catch {
      return;
    }
  };

  const changes = (r: Repo, target: string, source: string): Change[] => {
    const fields = paged(r.top, ['diff', '--raw', '-z', '--no-renames', '--no-abbrev', '--ignore-submodules=all', target, source]).split('\0');
    const out: Change[] = [];
    for (let index = 0; index + 1 < fields.length; index += 2) {
      const [, , blob, , status] = fields[index].split(' ');
      if (!status) throw new Error('git diff output could not be read');
      out.push({ path: fields[index + 1], target: /^0+$/.test(blob) ? null : blob, status: status[0] });
    }
    return out;
  };
  const counts = (r: Repo, target: string, source: string) => {
    const out = new Map<string, string>();
    for (const record of paged(r.top, ['diff', '--numstat', '-z', '--no-renames', '--ignore-submodules=all', target, source]).split('\0')) {
      const [added, removed, ...path] = record.split('\t');
      if (path.length) out.set(path.join('\t'), added === '-' ? 'binary' : added === '0' && removed === '0' ? 'mode only' : `+${added} -${removed}`);
    }
    return out;
  };
  const preview = (r: Repo, entry: Entry) => {
    const moved = changes(r, entry.before, entry.after);
    const lines = counts(r, entry.before, entry.after);
    const current = snapshot(r, `${entry.thread}-preview`, 'omd checkpoint: preview');
    const drifted = new Set(changes(r, entry.after, current.commit).map(change => change.path));
    const rows = moved.slice(0, SHOWN).map(change => {
      const size = lines.get(change.path) ?? 'binary';
      const what = change.status === 'A' ? `created by the turn (${size}); /undo deletes it` : change.status === 'D' ? `deleted by the turn (${size}); /undo brings it back` : size;
      return `  ${change.path}: ${what}${drifted.has(change.path) ? ' [changed since]' : ''}`;
    });
    const later = moved.filter(change => drifted.has(change.path)).length;
    return [
      `/undo would undo the ${clock(entry.at)} UTC turn, ${plural(moved.length, 'file')} (+ lines the turn added, - lines it removed):`,
      ...rows, ...moved.length > SHOWN ? [`  and ${moved.length - SHOWN} more`] : [],
      later ? `${plural(later, 'file')} changed since the turn, so /undo will refuse; /undo force undoes anyway and keeps your edits for /redo.` : 'Run /undo to apply it.',
    ].join('\n');
  };
  const stats = (paths: string[]) => {
    const files: Record<string, { kind: string; sha256?: string } | null> = {};
    for (const part of chunks(paths, BATCH)) {
      const stat = api.host.tryCall('workspace.stat', { paths: part, hash: true });
      if (!stat.ok) throw new Error(`could not inspect files: ${stat.error}`);
      Object.assign(files, stat.value.files);
    }
    return files;
  };

  // Idempotent: a path already back at target counts as done, and one at neither source nor target is a later edit.
  const revert = (r: Repo, thread: string, target: string, source: string, refusal: string | null): Outcome => {
    const moved = new Map(changes(r, target, source).map(change => [change.path, change]));
    if (!moved.size) return { refused: 'Nothing to change: that turn left no file changes.' };
    const current = snapshot(r, thread, 'omd checkpoint: before undo');
    pin(r, [current.commit]);
    const offSource = new Set(changes(r, source, current.commit).map(change => change.path).filter(path => moved.has(path)));
    const todo = changes(r, target, current.commit).filter(change => moved.has(change.path)).map(change => moved.get(change.path)!);
    const drifted = todo.map(change => change.path).filter(path => offSource.has(path));
    if (drifted.length && refusal) return { refused: `Not done: ${plural(drifted.length, 'file')} changed since: ${listed(drifted)}. ${refusal}` };
    if (!todo.length) return { done: 'The files already match that point.', current, after: current };
    const paths = todo.map(change => change.path);
    for (const part of chunks(paths, BATCH)) {
      const access = api.host.tryCall('workspace.check_access', { paths: part, write: true });
      if (!access.ok) return { refused: `Not done: this session can't write ${listed(part)} (${access.error}).` };
    }
    const added = todo.filter(change => change.target === null).map(change => change.path);
    const restored = todo.filter(change => change.target !== null).map(change => change.path);
    const found = stats(paths);
    const removable = new Set(added);
    for (const path of restored.filter(item => found[item]?.kind === 'dir')) {
      const listing = api.host.tryCall('workspace.list', { path, recursive: true, include_ignored: true, max_entries: LIST_ENTRIES });
      const foreign = !listing.ok ? [path] : listing.value.truncated ? [`${path}/…`]
        : listing.value.entries.filter(entry => entry.kind !== 'dir' && !removable.has(entry.path)).map(entry => entry.path);
      if (foreign.length) {
        return { refused: `Not done: ${path} is now a directory that also holds ${listed(foreign)}, which that turn didn't create. Putting the file back would delete them, so move them out first.` };
      }
    }
    let deleted = 0;
    const failed: string[] = [];
    const present = added.filter(path => found[path] !== null);
    for (const part of chunks(present, BATCH)) {
      const files = part.filter(path => found[path]?.kind === 'file' && found[path]?.sha256);
      failed.push(...part.filter(path => !files.includes(path)));
      if (!files.length) continue;
      const removed = api.host.tryCall('workspace.transaction', { expected: Object.fromEntries(files.map(path => [path, found[path]!.sha256!])), deletes: files });
      if (removed.ok) deleted += files.length;
      else failed.push(...files);
    }
    for (const part of byBytes(restored)) {
      git(r.top, ['restore', `--source=${target}`, '--worktree', '--pathspec-from-file=-', '--pathspec-file-nul'], { stdin: part.join('\0'), timeout: RESTORE_MS });
    }
    const after = snapshot(r, thread, 'omd checkpoint: after undo');
    const parts = [restored.length ? `restored ${plural(restored.length, 'file')}` : '', deleted ? `deleted ${plural(deleted, 'file')}` : ''].filter(Boolean).join(' and ');
    const kept = failed.length ? ` Could not delete ${listed(failed)}; remove ${failed.length === 1 ? 'it' : 'them'} by hand if needed.` : '';
    return { done: `${parts.charAt(0).toUpperCase()}${parts.slice(1) || 'Nothing to change'}.${kept}`, current, after };
  };

  const running = (state: State) => Object.values(state.pending).some(pending => Date.now() - pending.at < STALE_MS);
  const fail = (error: unknown) => ({ display: `Checkpoints are unavailable here: ${message(error)}` });

  api.on('turn_start', ({ turn_id }) => {
    const state = load();
    const thread = here().thread ?? 'session';
    for (const [key, pending] of Object.entries(state.pending)) if (Date.now() - pending.at >= STALE_MS) delete state.pending[key];
    let r: Repo | null = null;
    try {
      r = repo();
      state.pending[thread] = { turn: turn_id, before: snapshot(r, thread, `omd checkpoint: before turn ${turn_id}`).commit, at: Date.now() };
      state.error = null;
    } catch (error) {
      delete state.pending[thread];
      state.error = message(error);
    }
    save(state);
    if (r) keepRefs(r, state);
  });

  api.on('turn_end', ({ turn_id, outcome }) => {
    const state = load();
    const thread = here().thread ?? 'session';
    const pending = state.pending[thread];
    delete state.pending[thread];
    let r: Repo | null = null;
    try {
      r = repo();
      if (pending && pending.turn === turn_id) {
        const after = snapshot(r, thread, `omd checkpoint: after turn ${turn_id}`);
        const moved = changes(r, pending.before, after.commit);
        if (moved.length) {
          state.entries = [...state.entries, {
            thread, turn: turn_id, outcome, at: pending.at, before: pending.before, after: after.commit,
            count: moved.length, paths: moved.slice(0, SHOWN).map(change => change.path), undone: null,
          }].slice(-KEEP);
        }
        state.error = null;
      }
    } catch (error) {
      state.error = message(error);
    }
    save(state);
    if (r) keepRefs(r, state);
  });

  const apply = (state: State, run: (r: Repo) => Outcome, settle: (outcome: Extract<Outcome, { done: string }>) => void, said: (done: string) => string) => {
    try {
      const r = repo();
      const outcome = run(r);
      if ('refused' in outcome) return { display: outcome.refused };
      settle(outcome);
      save(state);
      keepRefs(r, state);
      return { display: said(outcome.done) };
    } catch (error) {
      return fail(error);
    }
  };

  api.command('undo', input => {
    const words = String(input ?? '').trim().split(/\s+/).filter(Boolean);
    const state = load();
    const entries = state.entries;
    if (words[0] === 'list') {
      if (!entries.length) return { display: `No checkpoints in this repository yet.${state.error ? ` Last problem: ${state.error}` : ''}` };
      return { display: ['Checkpoints in this repository, newest first:', ...entries.slice().reverse().map((entry, index) =>
        `${index + 1}. ${clock(entry.at)} UTC, ${entry.outcome} turn, ${plural(entry.count, 'file')}${entry.undone ? ' (undone; /redo restores it)' : ''}: ${listed(entry.paths, entry.count)}`)].join('\n') };
    }
    if (words.length && !['force', 'show'].includes(words[0])) return { display: 'Usage: /undo [force|show|list]' };
    const entry = entries.filter(item => !item.undone).at(-1);
    if (words[0] === 'show' && entry) {
      try {
        return { display: preview(repo(), entry) };
      } catch (error) {
        return fail(error);
      }
    }
    if (words[0] !== 'show' && running(state)) return { display: 'A turn is running. Use /undo after it ends.' };
    if (!entry) return { display: entries.length ? 'Every recorded turn is already undone. /redo brings the last one back.' : `No turn with file changes recorded in this repository yet.${state.error ? ` Last problem: ${state.error}` : ''}` };
    return apply(state,
      r => revert(r, entry.thread, entry.before, entry.after, words[0] === 'force' ? null
        : 'Undoing would overwrite those edits. Run /undo force to undo anyway; the current files are saved first, so /redo brings them back.'),
      outcome => { entry.undone = { at: Date.now(), before: outcome.current.commit, after: outcome.after.commit }; },
      done => `Undid the ${clock(entry.at)} UTC turn: ${done} /redo puts it back. Commits and branches are unchanged.`);
  }, { description: 'Undo the file changes of the last turn in this repository: /undo, /undo show, /undo force, /undo list', args_hint: '[force|show|list]' });

  api.command('redo', input => {
    const words = String(input ?? '').trim().split(/\s+/).filter(Boolean);
    if (words.length && words[0] !== 'force') return { display: 'Usage: /redo [force]' };
    const state = load();
    if (running(state)) return { display: 'A turn is running. Use /redo after it ends.' };
    const entry = state.entries.filter(item => item.undone).sort((a, b) => a.undone!.at - b.undone!.at).at(-1);
    if (!entry?.undone) return { display: 'Nothing to redo.' };
    const { before, after } = entry.undone;
    return apply(state,
      r => revert(r, entry.thread, before, after, words[0] === 'force' ? null : 'Redoing would overwrite those edits, and /redo force does so without saving them.'),
      () => { entry.undone = null; },
      done => `Redid the ${clock(entry.at)} UTC turn: ${done}`);
  }, { description: 'Bring back the changes /undo removed', args_hint: '[force]' });
}
