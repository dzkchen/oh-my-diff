import type { Json, ModAPI } from '../../api.d.ts';

type Repo = { top: string; gitdir: string };
type Snap = { commit: string; tree: string };
type Change = { path: string; status: string; target: string | null };
type Entry = {
  thread: string; turn: string; outcome: string; at: number; before: string; after: string; count: number; paths: string[];
  undone: { at: number; before: string; after: string } | null;
};
type State = { entries: Entry[]; pending: Record<string, { turn: string; before: string; at: number }>; error: string | null };

const REFS = 'refs/omd/checkpoints/';
const KEEP = 10;
const SHOWN = 12;
const BATCH = 128;
const ADD_MS = 3_500;
const GIT_MS = 1_500;
const RESTORE_MS = 30_000;
const IDENTITY = ['-c', 'user.name=OMD checkpoint', '-c', 'user.email=omd@localhost'];

const chunks = <T>(items: T[], size: number) => Array.from({ length: Math.ceil(items.length / size) }, (_, index) => items.slice(index * size, (index + 1) * size));
const listed = (paths: string[], total = paths.length) => `${paths.slice(0, SHOWN).join(', ')}${total > SHOWN ? ` and ${total - SHOWN} more` : ''}`;
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;
const clock = (at: number) => new Date(at).toISOString().slice(11, 16);

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
  const git = (cwd: string | undefined, argv: string[], options: { env?: Record<string, string>; stdin?: string; timeout?: number } = {}) => {
    const run = api.host.tryCall('exec.run', {
      program: 'git', argv: ['--no-pager', '--literal-pathspecs', '-c', 'core.quotepath=false', ...argv], ...cwd ? { cwd } : {}, sandbox: 'none',
      timeout_ms: options.timeout ?? GIT_MS, ...options.env ? { env: options.env } : {}, ...options.stdin === undefined ? {} : { stdin: options.stdin },
    });
    if (!run.ok) throw new Error(run.error.startsWith('exec_program_unavailable') ? 'git was not found on PATH' : run.error);
    const result = run.value;
    if (result.timed_out) throw new Error(`git ${argv[0]} took too long`);
    if (result.stdout_truncated) throw new Error(`git ${argv[0]} printed more than OMD can read`);
    if (result.exit_code !== 0) throw new Error((result.stderr || result.stdout).trim().split('\n')[0] || `git ${argv[0]} failed`);
    return result.stdout;
  };
  const repo = (): Repo => {
    const [top = '', gitdir = ''] = git(here().cwd, ['rev-parse', '--show-toplevel', '--absolute-git-dir']).trim().split('\n');
    if (!top || !gitdir) throw new Error('not a Git repository');
    return { top, gitdir };
  };
  const snapshot = (r: Repo, thread: string, label: string): Snap => {
    const env = { GIT_INDEX_FILE: `${r.gitdir}/omd-checkpoint-${thread.replace(/[^A-Za-z0-9-]/g, '').slice(0, 64) || 'session'}.index` };
    git(r.top, ['add', '--all', '--ignore-errors'], { env, timeout: ADD_MS });
    const tree = git(r.top, ['write-tree'], { env }).trim();
    const head = api.host.tryCall('exec.run', { program: 'git', argv: ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], cwd: r.top, sandbox: 'none', timeout_ms: GIT_MS });
    const parent = head.ok && head.value.exit_code === 0 ? head.value.stdout.trim() : '';
    const commit = git(r.top, [...IDENTITY, 'commit-tree', tree, ...parent ? ['-p', parent] : [], '-m', label]).trim();
    return { commit, tree };
  };
  const keepRefs = (r: Repo, state: State) => {
    const wanted = new Set([
      ...state.entries.flatMap(entry => [entry.before, entry.after, ...entry.undone ? [entry.undone.before, entry.undone.after] : []]),
      ...Object.values(state.pending).map(pending => pending.before),
    ]);
    const present = git(r.top, ['for-each-ref', '--format=%(refname)', REFS]).split('\n').filter(Boolean);
    const lines = [
      ...present.filter(ref => !wanted.has(ref.slice(REFS.length))).map(ref => `delete ${ref}`),
      ...[...wanted].filter(commit => !present.includes(REFS + commit)).map(commit => `update ${REFS}${commit} ${commit}`),
    ];
    if (lines.length) git(r.top, ['update-ref', '--stdin'], { stdin: `${lines.join('\n')}\n` });
  };

  const changes = (r: Repo, target: string, source: string): Change[] => {
    const raw = git(r.top, ['diff', '--raw', '-z', '--no-renames', '--no-abbrev', '--ignore-submodules=all', target, source]);
    const fields = raw.split('\0');
    const out: Change[] = [];
    for (let index = 0; index + 1 < fields.length; index += 2) {
      const [, , blob, , status] = fields[index].split(' ');
      if (!status) continue;
      out.push({ path: fields[index + 1], status: status[0], target: /^0+$/.test(blob) ? null : blob });
    }
    return out;
  };

  // Puts every path that changed between target and source back to its target content, but only where the work tree still matches source.
  const revert = (r: Repo, thread: string, target: string, source: string, force: string | null): { done: string; current: Snap; after: Snap } | { refused: string } => {
    const moved = changes(r, target, source);
    if (!moved.length) return { refused: 'Nothing to change: the files already match.' };
    const paths = moved.map(change => change.path);
    const current = snapshot(r, thread, 'omd checkpoint: before undo');
    const touched = new Set(paths);
    const drifted = changes(r, source, current.commit).map(change => change.path).filter(path => touched.has(path));
    if (drifted.length && force) {
      return { refused: `Not done: ${plural(drifted.length, 'file')} changed since: ${listed(drifted)}. ${force}` };
    }
    for (const part of chunks(paths, BATCH)) {
      const access = api.host.tryCall('workspace.check_access', { paths: part, write: true });
      if (!access.ok) return { refused: `Not done: this session can't write ${listed(part)} (${access.error}).` };
    }
    const added = moved.filter(change => change.target === null).map(change => change.path);
    const failed: string[] = [];
    for (const part of chunks(added, BATCH)) {
      const stat = api.host.tryCall('workspace.stat', { paths: part, hash: true });
      if (!stat.ok) {
        failed.push(...part);
        continue;
      }
      const present = part.filter(path => stat.value.files[path]?.kind === 'file' && stat.value.files[path]?.sha256);
      failed.push(...part.filter(path => stat.value.files[path] && !present.includes(path)));
      if (!present.length) continue;
      const removed = api.host.tryCall('workspace.transaction', { expected: Object.fromEntries(present.map(path => [path, stat.value.files[path]!.sha256!])), deletes: present });
      if (!removed.ok) failed.push(...present);
    }
    const restored = moved.filter(change => change.target !== null).map(change => change.path);
    if (restored.length) {
      git(r.top, ['restore', `--source=${target}`, '--worktree', '--pathspec-from-file=-', '--pathspec-file-nul'], { stdin: restored.join('\0'), timeout: RESTORE_MS });
    }
    const after = snapshot(r, thread, 'omd checkpoint: after undo');
    const parts = [restored.length ? `restored ${plural(restored.length, 'file')}` : '', added.length - failed.length ? `deleted ${plural(added.length - failed.length, 'file')}` : '']
      .filter(Boolean).join(' and ');
    const kept = failed.length ? ` Could not remove ${listed(failed)}; delete ${failed.length === 1 ? 'it' : 'them'} by hand if needed.` : '';
    return { done: `${parts.charAt(0).toUpperCase()}${parts.slice(1) || 'Nothing to change'}.${kept}`, current, after };
  };

  const busy = (state: State) => Object.keys(state.pending).length > 0;
  const fail = (error: unknown) => ({ display: `Checkpoints are unavailable here: ${error instanceof Error ? error.message : String(error)}` });

  api.on('turn_start', ({ turn_id }) => {
    const state = load();
    const thread = here().thread ?? 'session';
    try {
      const r = repo();
      state.pending[thread] = { turn: turn_id, before: snapshot(r, thread, `omd checkpoint: before turn ${turn_id}`).commit, at: Date.now() };
      state.error = null;
      keepRefs(r, state);
    } catch (error) {
      delete state.pending[thread];
      state.error = error instanceof Error ? error.message : String(error);
    }
    save(state);
  });

  api.on('turn_end', ({ turn_id, outcome }) => {
    const state = load();
    const thread = here().thread ?? 'session';
    const pending = state.pending[thread];
    delete state.pending[thread];
    try {
      const r = repo();
      if (pending && pending.turn === turn_id) {
        const after = snapshot(r, thread, `omd checkpoint: after turn ${turn_id}`);
        const moved = changes(r, pending.before, after.commit);
        if (moved.length) {
          state.entries = [...state.entries.filter(entry => !entry.undone), {
            thread, turn: turn_id, outcome, at: pending.at, before: pending.before, after: after.commit,
            count: moved.length, paths: moved.slice(0, SHOWN).map(change => change.path), undone: null,
          }].slice(-KEEP);
        }
        state.error = null;
      }
      keepRefs(r, state);
    } catch (error) {
      state.error = error instanceof Error ? error.message : String(error);
    }
    save(state);
  });

  api.command('undo', input => {
    const words = String(input ?? '').trim().split(/\s+/).filter(Boolean);
    const state = load();
    const own = state.entries;
    if (words[0] === 'list') {
      if (!own.length) return { display: `No checkpoints in this repository yet.${state.error ? ` Last problem: ${state.error}` : ''}` };
      return { display: ['Checkpoints in this repository, newest first:', ...own.slice().reverse().map((entry, index) =>
        `${index + 1}. ${clock(entry.at)} UTC, ${entry.outcome} turn, ${plural(entry.count, 'file')}${entry.undone ? ' (undone; /redo restores it)' : ''}: ${listed(entry.paths, entry.count)}`)].join('\n') };
    }
    if (words.length && words[0] !== 'force') return { display: 'Usage: /undo [force|list]' };
    if (busy(state)) return { display: 'A turn is running. Use /undo after it ends.' };
    const entry = own.filter(item => !item.undone).at(-1);
    if (!entry) return { display: own.length ? 'Every recorded turn is already undone. /redo brings the last one back.' : `No turn with file changes recorded in this repository yet.${state.error ? ` Last problem: ${state.error}` : ''}` };
    try {
      const r = repo();
      const result = revert(r, entry.thread, entry.before, entry.after, words[0] === 'force' ? null
        : 'Undoing would overwrite those edits. Run /undo force to undo anyway; the current files are saved first, so /redo brings them back.');
      if ('refused' in result) return { display: result.refused };
      entry.undone = { at: Date.now(), before: result.current.commit, after: result.after.commit };
      keepRefs(r, state);
      save(state);
      return { display: `Undid the ${clock(entry.at)} UTC turn: ${result.done} /redo puts it back. Commits and branches are unchanged.` };
    } catch (error) {
      return fail(error);
    }
  }, { description: 'Undo the file changes of the last turn in this repository: /undo, /undo force, /undo list', args_hint: '[force|list]' });

  api.command('redo', input => {
    const words = String(input ?? '').trim().split(/\s+/).filter(Boolean);
    if (words.length && words[0] !== 'force') return { display: 'Usage: /redo [force]' };
    const state = load();
    if (busy(state)) return { display: 'A turn is running. Use /redo after it ends.' };
    const entry = state.entries.filter(item => item.undone).sort((a, b) => a.undone!.at - b.undone!.at).at(-1);
    if (!entry?.undone) return { display: 'Nothing to redo.' };
    try {
      const r = repo();
      const result = revert(r, entry.thread, entry.undone.before, entry.undone.after, words[0] === 'force' ? null
        : 'Redoing would overwrite those edits, and /redo force does so without saving them.');
      if ('refused' in result) return { display: result.refused };
      entry.undone = null;
      keepRefs(r, state);
      save(state);
      return { display: `Redid the ${clock(entry.at)} UTC turn: ${result.done}` };
    } catch (error) {
      return fail(error);
    }
  }, { description: 'Bring back the changes /undo removed', args_hint: '[force]' });
}
