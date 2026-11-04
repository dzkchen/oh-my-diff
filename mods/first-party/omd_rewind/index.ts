import type { Json, ModAPI, ResourceRef } from '../../api.d.ts';

type Source = { backup: ResourceRef } | { git: string } | { absent: true } | { lost: string };
type Saved = { sha: string | null; backup: ResourceRef | null };
type Change = { before: string | null; after: string | null; source: Source };
type Checkpoint = {
  id: number; turn: string; label: string; at: number; head: string | null; ready: boolean;
  saved: Record<string, Saved>; skipped: string[]; files: Record<string, Change>; partial: boolean;
};
type State = { next: number; turn: string | null; active: boolean; pending: string; label: string; pool: Record<string, Saved>; checkpoints: Checkpoint[] };
type Planned = { path: string; first: Change; last: Change; current: string | null };

const KEEP = 20;
const FILES = 80;
const BACKUPS = 48;
const POOL = 96;
const LABEL = 72;
const SHOWN = 3;
const PATCH = /^\*\*\* (?:Add|Update|Delete) File: (.+)$|^\*\*\* Move to: (.+)$/gm;
const EDIT_TOOL = /(^|_)(edit|write|create|replace)(_file|_editor)?$/;
const LISTING = `git rev-parse --git-dir >/dev/null 2>&1 || exit 4
git rev-parse --verify -q HEAD || echo
printf -- '--\\n'
git -c core.quotepath=off ls-files -m -o --exclude-standard | head -${BACKUPS * 4}`;
const RESTORE = 'mkdir -p "$(dirname "$2")" && git show "$1:./$2" > "$2"';

const fresh = (): State => ({ next: 1, turn: null, active: false, pending: '', label: '', pool: {}, checkpoints: [] });
const field = (value: Json, key: string): Json => value && typeof value === 'object' && !Array.isArray(value) ? value[key] ?? null : null;
const strings = (value: Json): string[] => typeof value === 'string' ? [value] : Array.isArray(value) ? value.flatMap(strings) : value && typeof value === 'object' ? Object.values(value).flatMap(strings) : [];
const short = (text: string) => {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > LABEL ? `${line.slice(0, LABEL - 1)}…` : line;
};
const ago = (ms: number) => {
  const minutes = Math.round(ms / 60_000);
  return minutes < 1 ? 'just now' : minutes < 60 ? `${minutes} min ago` : minutes < 1440 ? `${Math.round(minutes / 60)} h ago` : `${Math.round(minutes / 1440)} d ago`;
};
const names = (paths: string[]) => paths.length > SHOWN ? `${paths.slice(0, SHOWN).join(', ')} +${paths.length - SHOWN}` : paths.join(', ');

function named(tool: string, args: Json, root: string, cwd: string): string[] {
  const given = tool === 'apply_patch'
    ? [...strings(args).join('\n').matchAll(PATCH)].map(match => (match[1] ?? match[2]).trim())
    : EDIT_TOOL.test(tool) ? [field(args, 'path'), field(args, 'file_path')].filter((path): path is string => typeof path === 'string') : [];
  const base = cwd === root ? '' : cwd.startsWith(`${root}/`) ? `${cwd.slice(root.length + 1)}/` : null;
  return [...new Set(given.flatMap(path => {
    if (path.split('/').includes('..')) return [];
    if (path.startsWith('/')) return path.startsWith(`${root}/`) ? [path.slice(root.length + 1)] : [];
    return base === null ? [] : [`${base}${path.replace(/^\.\//, '')}`];
  }))];
}

export default function activate(api: ModAPI) {
  const load = (): State => ({ ...fresh(), ...(api.state.get() as Partial<State> | null) });
  const save = (state: State) => api.state.set(state as unknown as Json);

  const current = (state: State): Checkpoint => {
    const last = state.checkpoints[state.checkpoints.length - 1];
    if (last && last.turn === (state.turn ?? '')) return last;
    const made: Checkpoint = { id: state.next, turn: state.turn ?? '', label: state.label, at: Date.now(), head: null, ready: false, saved: {}, skipped: [], files: {}, partial: false };
    state.next += 1;
    state.checkpoints = [...state.checkpoints.filter(cp => Object.keys(cp.files).length), made].slice(-KEEP);
    for (const cp of state.checkpoints) if (cp !== made) cp.saved = {};
    return made;
  };

  const capture = (state: State, cp: Checkpoint, paths: string[]) => {
    const wanted = [...new Set(paths)].filter(path => !(path in cp.saved) && !(path in cp.files) && !cp.skipped.includes(path));
    const made = Object.values(cp.saved).filter(entry => entry.backup).length;
    const take = wanted.slice(0, Math.max(0, Math.min(128, BACKUPS - made)));
    cp.skipped.push(...wanted.slice(take.length));
    if (!take.length) return;
    const stat = api.host.tryCall('workspace.stat', { paths: take, hash: true });
    if (!stat.ok) { cp.skipped.push(...take); return; }
    for (const path of take) {
      const file = stat.value.files[path];
      if (!file) { cp.saved[path] = { sha: null, backup: null }; continue; }
      const sha = file.sha256;
      if (file.kind !== 'file' || !sha) { cp.skipped.push(path); continue; }
      const pooled = state.pool[path];
      if (pooled?.sha === sha && pooled.backup) { cp.saved[path] = pooled; continue; }
      const backup = api.host.tryCall('workspace.backup', { expected: { [path]: sha } });
      if (!backup.ok) { cp.skipped.push(path); continue; }
      cp.saved[path] = { sha, backup: backup.value.backup };
      const { [path]: _, ...rest } = state.pool;
      state.pool = Object.fromEntries([...Object.entries(rest), [path, cp.saved[path]]].slice(-POOL));
    }
  };

  const prepare = (state: State, cp: Checkpoint, paths: string[]) => {
    if (!cp.ready) {
      cp.ready = true;
      const run = api.host.tryCall('exec.run', { program: 'sh', argv: ['-c', LISTING], timeout_ms: 3000, max_output_bytes: 65_536 });
      if (run.ok && !run.value.timed_out && run.value.exit_code === 0) {
        const [head = '', list = ''] = run.value.stdout.split('--\n');
        cp.head = head.trim() || null;
        capture(state, cp, list.split('\n').filter(Boolean));
      }
    }
    capture(state, cp, paths);
  };

  const resolve = (cp: Checkpoint, path: string, before: string | null): Source => {
    const saved = cp.saved[path];
    if (saved && saved.sha === before) return saved.backup ? { backup: saved.backup } : { absent: true };
    if (saved) return { lost: 'it changed outside the agent before this turn edited it' };
    if (before === null) return { absent: true };
    if (cp.skipped.includes(path)) return { lost: 'too many files were uncommitted when the turn started' };
    if (cp.ready && cp.head) return { git: cp.head };
    return { lost: 'it was changed by a command and there is no Git history to restore it from' };
  };

  api.intercept('input', (e, next) => {
    if (!e.text.trimStart().startsWith('/')) {
      const state = load();
      state.pending = short(e.text);
      save(state);
    }
    return next(e);
  });

  api.on('turn_start', ({ turn_id }) => {
    const state = load();
    state.turn = turn_id;
    state.active = true;
    state.label = state.pending || `turn ${state.next}`;
    state.pending = '';
    save(state);
  });

  api.on('turn_end', ({ turn_id }) => {
    const state = load();
    state.active = false;
    const last = state.checkpoints[state.checkpoints.length - 1];
    if (last?.turn === turn_id) {
      last.saved = {};
      if (!Object.keys(last.files).length) state.checkpoints = state.checkpoints.slice(0, -1);
    }
    save(state);
  });

  api.intercept('tool', async (e, next) => {
    const caller = next.origin?.caller;
    if (caller !== 'model' && caller !== 'code_mode') return next(e);
    const state = load();
    const { root, cwd } = api.session();
    prepare(state, current(state), named(e.tool, e.arguments, root, cwd));
    save(state);
    return next(e);
  });

  api.on('workspace_change', e => {
    if (e.source !== 'tool' && e.source !== 'rescan') return;
    const state = load();
    if (e.source === 'rescan' && !state.active) return;
    const cp = current(state);
    if (e.status !== 'observed') cp.partial = true;
    for (const { path, before, after } of e.status === 'observed' ? e.changes : []) {
      const known = cp.files[path];
      if (known) known.after = after;
      else if (before === after) continue;
      else if (Object.keys(cp.files).length >= FILES) cp.partial = true;
      else cp.files[path] = { before, after, source: resolve(cp, path, before) };
    }
    save(state);
  });

  const list = (state: State) => {
    const cps = state.checkpoints.filter(cp => Object.keys(cp.files).length);
    if (!cps.length) return { display: 'No checkpoints yet. omd_rewind records the files each turn changes, starting with the next turn that edits a file.' };
    const rows = [...cps].reverse().map(cp => {
      const files = Object.keys(cp.files);
      const flags = [cp.partial ? 'incomplete' : '', Object.values(cp.files).some(file => 'lost' in file.source) ? 'some files can\'t be restored' : ''].filter(Boolean);
      return `  #${cp.id}  ${ago(Date.now() - cp.at)}  "${cp.label}"  ${files.length} file${files.length === 1 ? '' : 's'}: ${names(files)}${flags.length ? `  (${flags.join('; ')})` : ''}`;
    });
    return { display: [`Checkpoints, newest first. \`/rewind N\` puts back the files as they were before turn N and undoes every later turn's file changes.`, ...rows].join('\n') };
  };

  const plan = (cps: Checkpoint[]): Planned[] | string => {
    const merged = new Map<string, { first: Change; last: Change }>();
    for (const cp of cps) for (const [path, change] of Object.entries(cp.files)) {
      const seen = merged.get(path);
      merged.set(path, { first: seen?.first ?? change, last: change });
    }
    const paths = [...merged.keys()];
    const now: Record<string, string | null> = {};
    for (let index = 0; index < paths.length; index += 128) {
      const stat = api.host.tryCall('workspace.stat', { paths: paths.slice(index, index + 128), hash: true });
      if (!stat.ok) return `Couldn't read the current files: ${stat.error}`;
      for (const [path, file] of Object.entries(stat.value.files)) now[path] = file?.sha256 ?? null;
    }
    return paths.map(path => ({ path, ...merged.get(path)!, current: now[path] ?? null }));
  };

  const put = (item: Planned): string | null => {
    const { path, first, current: sha } = item;
    const source = first.source;
    if (sha === first.before) return null;
    if ('lost' in source) return source.lost;
    if ('absent' in source) {
      const done = api.host.tryCall('workspace.transaction', { expected: { [path]: sha }, deletes: [path] });
      return done.ok ? null : done.error;
    }
    if ('backup' in source) {
      const done = api.host.tryCall('workspace.restore', { backup: source.backup, expected: { [path]: sha } });
      return done.ok ? null : done.error;
    }
    const run = api.host.tryCall('exec.run', { program: 'sh', argv: ['-c', RESTORE, 'sh', source.git, path], write: true, required_access: { write: [path] }, timeout_ms: 5000, max_output_bytes: 4096 });
    if (!run.ok) return run.error;
    if (run.value.exit_code !== 0) return run.value.stderr.trim() || `git exited with ${run.value.exit_code}`;
    const check = api.host.tryCall('workspace.stat', { paths: [path], hash: true });
    return check.ok && check.value.files[path]?.sha256 === first.before ? null : 'the version restored from Git differs from the one the turn started with';
  };

  const rewind = (state: State, id: number, force: boolean) => {
    if (state.active) return { display: 'A turn is running. Rewind once it finishes.' };
    const index = state.checkpoints.findIndex(cp => cp.id === id && Object.keys(cp.files).length);
    if (index < 0) return { display: `There's no checkpoint #${id}. Run \`/rewind\` to see the list.` };
    const cps = state.checkpoints.slice(index);
    const planned = plan(cps);
    if (typeof planned === 'string') return { display: planned };
    const edited = planned.filter(item => item.current !== item.last.after);
    const lost = planned.filter(item => 'lost' in item.first.source && item.current !== item.first.before);
    const partial = cps.some(cp => cp.partial);
    if (!force && (edited.length || lost.length || partial)) {
      return { display: [
        `Nothing changed yet. Rewinding to before #${id} needs \`/rewind ${id} force\` because:`,
        ...edited.map(item => `  ${item.path} changed after the agent last edited it; rewinding discards that change`),
        ...lost.map(item => `  ${item.path} can't be restored (${(item.first.source as { lost: string }).lost}); it stays as it is`),
        ...(partial ? ['  some changes in these turns weren\'t recorded, so files other than the ones listed keep their changes'] : []),
      ].join('\n') };
    }
    const failed: string[] = [];
    const restored: string[] = [];
    const removed: string[] = [];
    for (const item of planned) {
      if (lost.includes(item)) continue;
      const error = put(item);
      if (error) failed.push(`  ${item.path}: ${error}`);
      else if (item.current !== item.first.before) (item.first.before === null ? removed : restored).push(item.path);
    }
    const label = cps[0].label;
    if (!failed.length) state.checkpoints = state.checkpoints.slice(0, index);
    save(state);
    const lines = [
      `Rewound to before #${id} "${label}".`,
      ...(restored.length ? [`  Restored: ${restored.join(', ')}`] : []),
      ...(removed.length ? [`  Deleted (created after the checkpoint): ${removed.join(', ')}`] : []),
      ...(lost.length ? [`  Left as is: ${lost.map(item => item.path).join(', ')}`] : []),
      ...(failed.length ? ['  Failed, so the checkpoints are kept and you can try again:', ...failed] : []),
      'The conversation is unchanged: the composer has a note telling the agent what was undone.',
    ];
    const changed = [...restored, ...removed];
    return {
      display: lines.join('\n'),
      ...(changed.length ? { insert: `[I rewound the files to how they were before "${label}" and undid your later file changes to ${names(changed)}. Re-read files before editing them.] ` } : {}),
    };
  };

  api.command('rewind', args => {
    const words = (typeof args === 'string' ? args : '').trim().split(/\s+/).filter(Boolean);
    const state = load();
    if (!words.length || words[0] === 'list') return list(state);
    const id = Number(words[0].replace(/^#/, ''));
    const force = words.slice(1).includes('force');
    if (!Number.isInteger(id) || words.slice(1).some(word => word !== 'force')) return { display: 'Usage: `/rewind` lists checkpoints, `/rewind N` rewinds to before turn N, `/rewind N force` rewinds even over later edits.' };
    return rewind(state, id, force);
  }, { description: 'Put files back as they were before an earlier turn', args_hint: '[N [force]]' });
}
