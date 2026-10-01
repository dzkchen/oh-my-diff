import type { ExecGuard, Fingerprint, ModAPI, ResourceRef, TerminalComponent, TerminalPatch, TerminalRenderSite, TerminalTone } from '../../api.d.ts';

type Entry = { path: string; original: string | null; index: string; worktree: string; conflicted: boolean };
type Commit = { oid: string; parents: string[]; subject: string };
type Head = { branch: string | null; oid: string | null; upstream: string | null; ahead: number; behind: number };
type Preview = { kind: 'discard' | 'commit' | 'switch'; tracked: boolean; target: string; from: string | null; destination: string | null; status: string; lines: string[]; guards: ExecGuard[]; paths: string[]; expected: Record<string, Fingerprint> | null };
type Saved = { error: string | null; head: Head | null; entries: Entry[]; total: number; rows: string[]; more: boolean; branches: string[]; selected: string | null; branch: string | null; message: string; preview: Preview | null; notice: string | null; status: string; guards: ExecGuard[]; backup: { path: string; reference: ResourceRef; expected: Fingerprint } | null };
type Result<T> = { ok: true; value: T } | { ok: false; error: string };

const EMPTY: Saved = { error: 'Git status not loaded', head: null, entries: [], total: 0, rows: [], more: false, branches: [], selected: null, branch: null, message: '', preview: null, notice: null, status: '', guards: [], backup: null };
const ENTRY_LIMIT = 1_000;
const STATUS_LIMIT = 65_536;
const DIALOG_TEXT_LIMIT = 4_096;
const STALE = 'Changed since it was shown; review the refreshed state and retry.';
const WRITE_UNAVAILABLE = 'This Git write is unavailable until its exact paths and preconditions can be checked.';

export default function activate(api: ModAPI) {
  const ascii = api.settings.icons === 'ascii';
  const glyph = ascii ? { node: '*', pipe: '|', merge: '\\', up: '^', down: 'v', arrow: '->', more: '...' } : { node: '●', pipe: '│', merge: '╮', up: '↑', down: '↓', arrow: '→', more: '…' };
  const width = Math.min(60, Math.max(24, typeof api.settings.width === 'number' ? Math.floor(api.settings.width) : 40));
  const visible = (value: string, limit?: number) => value.replace(/[\u0000-\u001f\u007f-\u009f]/g, '?').slice(0, limit);
  const bytes = (value: string) => [...value].reduce((total, character) => {
    const code = character.codePointAt(0) ?? 0;
    return total + (code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4);
  }, 0);
  const trim = (value: string, limit = width - 4) => {
    const safe = visible(value);
    if (bytes(safe) <= limit) return safe;
    let prefix = '';
    let used = bytes(glyph.more);
    for (const character of safe) {
      const size = bytes(character);
      if (used + size > limit) break;
      used += size;
      prefix += character;
    }
    return `${prefix}${glyph.more}`;
  };
  const saved = (): Saved => {
    const state = api.state.get();
    return state && typeof state === 'object' && !Array.isArray(state) ? { ...EMPTY, ...state } as Saved : { ...EMPTY };
  };
  const save = (state: Saved) => api.state.set(state);
  const gitArgs = (argv: string[]) => ['--no-pager', '--literal-pathspecs', '-c', 'core.quotepath=false', '-c', 'color.ui=false', '-c', 'core.fsmonitor=false', ...argv];
  type Read = { text: string; guard: ExecGuard };
  const read = (argv: string[], limit = 65_536): Result<Read> => {
    const result = api.host.tryCall('exec.run', {
      program: 'git', argv: gitArgs(argv),
      env: { GIT_OPTIONAL_LOCKS: '0' }, timeout_ms: 10_000, max_output_bytes: limit, write: false, network: 'none',
    });
    if (!result.ok) return { ok: false, error: result.error };
    const output = result.value;
    if (output.stdout_truncated || output.stderr_truncated) return { ok: false, error: 'Git output exceeded the safe preview limit' };
    if (output.timed_out) return { ok: false, error: 'Git command timed out' };
    if (output.exit_code !== 0) return { ok: false, error: visible(output.stderr.trim().split('\n')[0]?.slice(0, 200) || 'Git command failed') };
    if (!/^[0-9a-f]{64}$/.test(output.stdout_sha256) || !/^[0-9a-f]{64}$/.test(output.program.sha256)) return { ok: false, error: 'Git fingerprint unavailable' };
    return { ok: true, value: { text: output.stdout, guard: { program: 'git', sha256: output.program.sha256, argv: gitArgs(argv), env: { GIT_OPTIONAL_LOCKS: '0' }, stdout_sha256: output.stdout_sha256 } } };
  };
  const run = (argv: string[], limit = 65_536): Result<string> => {
    const result = read(argv, limit);
    return result.ok ? { ok: true, value: result.value.text } : result;
  };
  const write = (argv: string[], guards: ExecGuard[], paths: string[], stdin?: string, timeout_ms = 30_000): Result<string> => {
    if (!guards.length || !paths.length || paths.length > 128 || new Set(paths).size !== paths.length) return { ok: false, error: WRITE_UNAVAILABLE };
    const result = api.host.tryCall('exec.run', { program: 'git', sha256: guards[0].sha256, argv: gitArgs(argv), stdin, timeout_ms, max_output_bytes: 65_536, write: true, network: 'none', guards, required_access: { write: paths } });
    if (!result.ok) return { ok: false, error: result.error };
    const output = result.value;
    if (output.timed_out) return { ok: false, error: 'Git command timed out' };
    if (output.guards_verified !== guards.length || output.stdout_truncated || output.stderr_truncated || output.exit_code !== 0 || output.program.sha256 !== guards[0].sha256) return { ok: false, error: visible(output.stderr.trim().split('\n')[0]?.slice(0, 200) || 'Git write failed') };
    return { ok: true, value: output.stdout };
  };
  const indexGuard = (): Result<ExecGuard> => {
    const result = read(['ls-files', '-s', '-z']);
    return result.ok ? { ok: true, value: result.value.guard } : result;
  };
  const access = (paths: string[]): Result<null> => {
    const result = api.host.tryCall('workspace.check_access', { paths, write: true });
    return result.ok ? { ok: true, value: null } : { ok: false, error: result.error };
  };
  const status = (): Result<{ entries: Entry[]; head: Head; raw: string; guards: ExecGuard[] }> => {
    const result = read(['status', '--porcelain=v1', '-z', '-b', '--untracked-files=all'], 65_536);
    if (!result.ok) return result;
    const raw = result.value.text;
    if (bytes(raw) > STATUS_LIMIT) return { ok: false, error: 'too many changes to preview safely' };
    if (raw.includes('\uFFFD')) return { ok: false, error: 'Git path encoding unavailable' };
    const records = raw.split('\0');
    const header = records.shift() ?? '';
    if (!header.startsWith('## ')) return { ok: false, error: 'Git status format unavailable' };
    const branchText = header.slice(3);
    const detached = branchText.startsWith('HEAD (no branch)') || branchText.startsWith('HEAD (detached');
    const branch = detached ? null : branchText.replace(/^No commits yet on /, '').split('...')[0].split(' [')[0];
    const upstream = branchText.includes('...') ? branchText.split('...')[1].split(' [')[0] : null;
    const ahead = Number(/ahead (\d+)/.exec(branchText)?.[1] ?? 0);
    const behind = Number(/behind (\d+)/.exec(branchText)?.[1] ?? 0);
    const oidResult = read(['rev-parse', '--verify', 'HEAD']);
    if (!oidResult.ok && !branchText.startsWith('No commits yet on ')) return { ok: false, error: oidResult.error };
    const oid = oidResult.ok ? oidResult.value.text.trim() : null;
    if (oid && !/^[0-9a-f]{40,64}$/.test(oid)) return { ok: false, error: 'Git HEAD format unavailable' };
    const entries: Entry[] = [];
    for (let index = 0; index < records.length; index += 1) {
      const record = records[index];
      if (!record) continue;
      if (record.length < 4 || record[2] !== ' ') return { ok: false, error: 'Git status format unavailable' };
      const x = record[0];
      const y = record[1];
      const path = record.slice(3);
      const original = x === 'R' || x === 'C' || y === 'R' || y === 'C' ? records[++index] ?? null : null;
      if (!path || original === '') return { ok: false, error: 'Git status format unavailable' };
      entries.push({ path, original, index: x, worktree: y, conflicted: x === 'U' || y === 'U' || x === 'A' && y === 'A' || x === 'D' && y === 'D' });
      if (entries.length > ENTRY_LIMIT) return { ok: false, error: 'too many changes to preview safely' };
    }
    return { ok: true, value: { entries, head: { branch, oid, upstream, ahead, behind }, raw, guards: [result.value.guard, ...(oidResult.ok ? [oidResult.value.guard] : [])] } };
  };
  const commits = (count: number): Result<Commit[]> => {
    const result = run(['log', `--max-count=${count}`, '--format=%H%x00%P%x00%s%x00']);
    if (!result.ok) return result;
    const output: Commit[] = [];
    for (const record of result.value.split('\n')) {
      if (!record) continue;
      const [oid, parents, subject] = record.split('\0');
      if (!/^[0-9a-f]{40,64}$/.test(oid) || parents === undefined || subject === undefined) return { ok: false, error: 'Git log format unavailable' };
      output.push({ oid, parents: parents.split(' ').filter(Boolean), subject });
    }
    return { ok: true, value: output };
  };
  const branches = (): Result<string[]> => {
    const result = run(['for-each-ref', '--format=%(refname:short)', 'refs/heads'], 16_384);
    return result.ok ? { ok: true, value: result.value.split('\n').filter(branch => branch && bytes(branch) <= 128).slice(0, 100) } : result;
  };
  const diff = (path: string, staged: boolean): Result<string> => run(['diff', '--no-ext-diff', '--no-textconv', '--ignore-submodules=all', ...(staged ? ['--cached'] : []), '--', path], 65_536);
  const graph = (items: Commit[]): string[] => {
    const lanes: string[] = [];
    return items.map(commit => {
      let column = lanes.indexOf(commit.oid);
      if (column < 0) { column = lanes.length; lanes.push(commit.oid); }
      let prefix = lanes.map((_, index) => index === column ? glyph.node : glyph.pipe).join(' ');
      const [first, ...others] = commit.parents;
      if (first === undefined) lanes.splice(column, 1);
      else lanes[column] = first;
      for (const parent of others) if (!lanes.includes(parent)) { lanes.push(parent); prefix += glyph.merge; }
      for (let index = lanes.length - 1; index > 0; index -= 1) if (lanes.indexOf(lanes[index]) !== index) lanes.splice(index, 1);
      return `${prefix} ${commit.oid.slice(0, 7)} ${visible(commit.subject)}`;
    });
  };
  const refresh = (previous: Saved = saved()): Saved => {
    const result = status();
    if (!result.ok) {
      const next = { ...EMPTY, error: result.error, message: previous.message, backup: previous.backup };
      save(next);
      return next;
    }
    const log = result.value.head.oid ? commits(Math.min(12, Math.max(1, typeof api.settings.commits === 'number' ? Math.floor(api.settings.commits) : 6))) : { ok: true as const, value: [] };
    const local = branches();
    const entries = result.value.entries.sort((left, right) => left.conflicted === right.conflicted ? left.path.localeCompare(right.path) : left.conflicted ? -1 : 1);
    const names = local.ok ? local.value : [];
    let preview = previous.status === result.value.raw && previous.preview?.from === result.value.head.oid ? previous.preview : null;
    if (preview?.kind === 'switch') {
      const destination = run(['show-ref', '--verify', '--hash', `refs/heads/${preview.target}`], 256);
      if (!destination.ok || destination.value.trim() !== preview.destination) preview = null;
    }
    if (preview?.kind === 'commit') {
      const index = read(['ls-files', '-s', '-z']);
      if (!index.ok || index.value.guard.stdout_sha256 !== preview.guards.at(-1)?.stdout_sha256) preview = null;
    }
    if (preview?.kind === 'discard' && preview.tracked) {
      const file = api.host.tryCall('workspace.stat', { paths: preview.paths, hash: true });
      if (!file.ok || file.value.files[preview.target]?.sha256 !== preview.expected?.[preview.target]) preview = null;
    }
    const next: Saved = { ...previous, error: null, head: result.value.head, entries: entries.slice(0, 40), total: entries.length, rows: log.ok ? graph(log.value) : [], more: entries.length > 40, branches: names, selected: entries.some(entry => entry.path === previous.selected) ? previous.selected : entries[0]?.path ?? null, branch: previous.branch && names.includes(previous.branch) ? previous.branch : null, preview, status: result.value.raw, guards: result.value.guards };
    save(next);
    return next;
  };
  const headline = (head: Head | null) => head ? `${head.branch ?? `detached @ ${head.oid?.slice(0, 7) ?? '?'}`}${head.upstream ? `  ${glyph.up}${head.ahead} ${glyph.down}${head.behind}` : ''}` : 'no commits';
  const describe = (entry: Entry) => `${entry.index}${entry.worktree} ${entry.original ? `${visible(entry.original)} ${glyph.arrow} ` : ''}${visible(entry.path)}`;
  const line = (id: string, label: string, text: string, tone: TerminalTone = 'normal'): TerminalComponent => ({ type: 'text', id, label, text, tone });
  const button = (id: string, label: string, text: string, command: string): TerminalComponent => ({ type: 'button', id, label: trim(label, 128), text: trim(text, 200), action: { command: `omd_git:${command}` } });
  const sidebar = (state: Saved): TerminalComponent[] => {
    if (state.error) return [line('omd_git_error', 'Git status', trim(state.error), 'failure'), ...(state.backup ? [button('omd_git_restore', `Restore ${state.backup.path} from its backup`, 'Restore backup', 'restore')] : [])];
    const groups: [string, TerminalTone, (entry: Entry) => boolean][] = [
      ['Conflicted', 'failure', entry => entry.conflicted],
      ['Staged', 'success', entry => !entry.conflicted && entry.index !== ' ' && entry.index !== '?'],
      ['Unstaged', 'attention', entry => !entry.conflicted && entry.worktree !== ' ' && entry.index !== '?'],
      ['Untracked', 'muted', entry => entry.index === '?'],
    ];
    const changes = groups.flatMap(([name, tone, test]) => {
      const matched = state.entries.filter(test);
      return matched.length ? [line(`omd_git_${name.toLowerCase()}`, `${name} files`, [name, ...matched.slice(0, 6).map(entry => `  ${trim(describe(entry))}`), ...(matched.length > 6 ? [`  ${glyph.more} ${matched.length - 6} more`] : [])].join('\n'), tone)] : [];
    });
    const components: TerminalComponent[] = [
      { type: 'pane', id: 'omd_git_graph', label: 'Git commit graph', title: trim(`Git  ${headline(state.head)}`), children: [line('omd_git_commits', 'Recent commits', state.rows.length ? state.rows.map(row => trim(row)).join('\n') : 'no commits yet', 'accent')] },
      { type: 'pane', id: 'omd_git_changes', label: 'Changed files', title: `Changes  ${state.total}`, children: changes.length ? changes : [line('omd_git_clean', 'Working tree clean', 'working tree clean', 'success')] },
    ];
    const options = state.entries.filter(entry => bytes(entry.path) <= 128).slice(0, 16);
    const selected = options.find(entry => entry.path === state.selected) ?? options[0];
    if (selected) {
      components.push({ type: 'select', id: 'omd_git_file', label: 'Selected file', value: selected.path, options: options.map(entry => ({ value: entry.path, label: trim(describe(entry), 128) })), action: { command: 'omd_git:file' } });
      components.push(button('omd_git_diff', `Show diff of ${selected.path}`, 'Diff', 'diff'));
      if (!selected.conflicted && (selected.worktree !== ' ' || selected.index === '?')) components.push(button('omd_git_stage', `Stage ${selected.path}`, 'Stage', 'stage'));
      if (!selected.conflicted && selected.index !== ' ' && selected.index !== '?') components.push(button('omd_git_unstage', `Unstage ${selected.path}`, 'Unstage', 'unstage'));
      if (!selected.conflicted && (selected.worktree !== ' ' || selected.index === '?')) components.push(button('omd_git_discard', `Back up and discard ${selected.path}`, `Discard${glyph.more}`, 'discard'));
    }
    components.push({ type: 'input', id: 'omd_git_message', label: 'Commit message', value: state.message, placeholder: 'type a commit message', action: { command: 'omd_git:message' } });
    if (state.entries.some(entry => !entry.conflicted && entry.index !== ' ' && entry.index !== '?')) components.push(button('omd_git_commit', 'Preview staged commit', `Preview commit${glyph.more}`, 'commit'));
    const targets = state.branches.filter(branch => branch !== state.head?.branch).slice(0, 16);
    if (targets.length) {
      components.push({ type: 'select', id: 'omd_git_branch', label: 'Branch to preview', value: state.branch && targets.includes(state.branch) ? state.branch : targets[0], options: targets.map(value => ({ value, label: trim(value, 128) })), action: { command: 'omd_git:branch' } });
      components.push(button('omd_git_switch', 'Preview the selected branch', `Preview switch${glyph.more}`, 'switch'));
    }
    if (state.notice) components.push(line('omd_git_notice', 'Git notice', trim(state.notice, width * 2), 'muted'));
    if (state.backup) components.push(button('omd_git_restore', `Restore ${state.backup.path} from its backup`, 'Restore backup', 'restore'));
    return components;
  };
  const dialog = (preview: Preview): TerminalRenderSite => ({ mode: 'replace', components: [{ type: 'dialog', id: 'omd_git_dialog', label: 'Git preview', title: trim(preview.kind === 'switch' ? `Switch to ${preview.target}?` : preview.kind === 'commit' ? 'Commit staged files?' : `Discard ${preview.target}?`, 128), children: [{ type: 'pane', id: 'omd_git_preview_pane', label: 'Scrollable exact preview', title: 'Preview · up/down to inspect all paths', collapsed: false, scroll: 0, children: [line('omd_git_preview', 'Preview', preview.lines.join('\n'))] }, ...(preview.kind === 'discard' || preview.kind === 'commit' || preview.kind === 'switch' && preview.expected ? [button('omd_git_confirm', 'Confirm guarded Git action', 'Confirm', 'confirm')] : [line('omd_git_read_only', 'Git write status', WRITE_UNAVAILABLE, 'attention')]), ...(preview.kind === 'commit' ? [button('omd_git_staged_diff', 'Show staged diff', 'Staged diff', 'staged_diff')] : []), button('omd_git_cancel', 'Close preview', 'Close', 'cancel')] }] });
  const view = (): TerminalPatch => {
    const state = saved();
    return { sidebar_side: api.settings.side === 'right' ? 'right' : 'left', sidebar_width: width, sites: { sidebar: { mode: 'wrap', components: [...sidebar(state), { type: 'slot' }] }, ...(state.preview ? { dialog: dialog(state.preview) } : {}) }, status: state.error ? [] : [trim(`git: ${state.head?.branch ?? 'detached'}${state.total ? ` ${ascii ? '*' : '✱'}${state.total}` : ''}`, 40)], keybindings: { 'Alt+g': { command: 'omd_git:refresh' } } };
  };
  api.command('refresh', () => { const state = refresh({ ...saved(), notice: null }); return { display: state.error ? `Git: ${state.error}` : `Git: ${headline(state.head)}, ${state.total} changed` }; }, { description: 'Refresh the Git sidebar' });
  api.command('status', () => { const state = refresh(); return { display: state.error ? `Git: ${state.error}` : [trim(headline(state.head), 200), ...state.entries.map(entry => trim(describe(entry), 200)), ...(state.more ? [`${glyph.more} ${state.total - state.entries.length} more`] : [])].join('\n') }; }, { description: 'Show the current branch and changed files' });
  api.command('log', () => { const result = commits(50); return { display: result.ok ? graph(result.value).map(row => trim(row, 200)).join('\n') || 'no commits yet' : result.error }; }, { description: 'Show recent commits' });
  api.command('file', value => { const state = saved(); const path = typeof value === 'string' ? value : ''; if (!state.entries.some(entry => entry.path === path)) return { display: 'select a changed file first' }; save({ ...state, selected: path, notice: null }); return null; }, { description: 'Select a changed file' });
  api.command('branch', value => { const state = saved(); const branch = typeof value === 'string' ? value : ''; if (!state.branches.includes(branch)) return { display: 'unknown local branch' }; save({ ...state, branch, notice: null }); return null; }, { description: 'Select a local branch' });
  api.command('message', value => { const state = saved(); const message = typeof value === 'string' ? value.slice(0, 1000) : ''; save({ ...state, message, preview: null, notice: null }); return { display: message.trim() ? 'commit message saved' : 'commit message cleared' }; }, { description: 'Set the commit message' });
  const changeIndex = (kind: 'stage' | 'unstage') => {
    const state = saved();
    if (!state.selected) return { display: 'select a changed file first' };
    const current = status();
    if (!current.ok) return { display: current.error };
    if (!state.status || state.status !== current.value.raw || state.head?.oid !== current.value.head.oid) return { display: STALE };
    const entry = current.value.entries.find(item => item.path === state.selected);
    if (!entry || entry.conflicted || entry.original || kind === 'stage' && entry.worktree === ' ' && entry.index !== '?' || kind === 'unstage' && (entry.index === ' ' || entry.index === '?')) return { display: 'selected file cannot be changed in the index' };
    const path = entry.path;
    const scope = read(['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', path]);
    if (!scope.ok) return { display: scope.error };
    if (scope.value.text !== `${path}\0`) return { display: 'Git path scope is not an exact single file' };
    const allowed = access([path]);
    if (!allowed.ok) return { display: allowed.error };
    const indexed = indexGuard();
    if (!indexed.ok) return { display: indexed.error };
    const guards = [...current.value.guards, indexed.value];
    if (kind === 'stage') {
      const version = api.host.tryCall('workspace.stat', { paths: [path], hash: true });
      if (!version.ok) return { display: version.error };
      const file = version.value.files[path];
      if (file && (file.kind !== 'file' || !file.sha256)) return { display: 'staging requires a regular file or a tracked deletion' };
      if (file) {
        const content = read(['hash-object', '--no-filters', '--', path], 256);
        if (!content.ok) return { display: content.error };
        if (!/^[0-9a-f]{40,64}\n$/.test(content.value.text)) return { display: 'Git file fingerprint unavailable' };
        guards.push(content.value.guard);
      } else if (entry.index === '?') return { display: 'untracked file disappeared' };
    }
    const result = write(kind === 'stage' ? ['add', '-A', '--', path] : current.value.head.oid ? ['restore', '--staged', '--', path] : ['rm', '--cached', '-q', '--', path], guards, [path]);
    if (!result.ok) return { display: result.error };
    const next = refresh({ ...state, preview: null });
    const notice = `${kind === 'stage' ? 'staged' : 'unstaged'} ${trim(path, 80)}`;
    save({ ...next, notice });
    return { display: notice };
  };
  api.command('stage', () => changeIndex('stage'), { description: 'Stage the selected exact file after guarded preconditions' });
  api.command('unstage', () => changeIndex('unstage'), { description: 'Unstage the selected exact file after guarded preconditions' });
  api.command('diff', value => {
    const state = refresh();
    if (state.error) return { display: `Git: ${state.error}` };
    const path = typeof value === 'string' && value ? value : state.selected;
    const entry = state.entries.find(item => item.path === path);
    if (!entry) return { display: 'select a changed file first' };
    if (entry.index === '?') return { display: 'untracked file; no Git diff is available' };
    const staged = entry.worktree === ' ' && entry.index !== ' ';
    const result = diff(entry.path, staged);
    return { display: result.ok ? `${staged ? 'staged' : 'unstaged'} diff · ${trim(entry.path, 200)}\n${result.value.slice(0, 12_000)}${result.value.length > 12_000 ? `\n${glyph.more} truncated` : ''}` : result.error };
  }, { description: 'Show a changed file diff' });
  const discard = () => {
    const state = refresh();
    if (state.error) return { display: `Git: ${state.error}` };
    const entry = state.entries.find(item => item.path === state.selected);
    if (!entry) return { display: 'select a changed file first' };
    if (entry.conflicted || entry.worktree === ' ' && entry.index !== '?') return { display: 'selected file has no discardable worktree change' };
    const version = api.host.tryCall('workspace.stat', { paths: [entry.path], hash: true });
    if (!version.ok) return { display: version.error };
    const file = version.value.files[entry.path];
    if (file?.kind !== 'file' || !file.sha256) return { display: 'discard requires a regular file with a readable fingerprint' };
    const tracked = entry.index !== '?';
    const allowed = tracked ? access([entry.path]) : { ok: true as const, value: null };
    if (!allowed.ok) return { display: allowed.error };
    const change = tracked ? read(['diff', '--binary', '--no-ext-diff', '--no-textconv', '--ignore-submodules=all', '--', entry.path]) : null;
    if (change && !change.ok) return { display: change.error };
    const index = tracked ? indexGuard() : null;
    if (index && !index.ok) return { display: index.error };
    const content = tracked ? read(['hash-object', '--no-filters', '--', entry.path], 256) : null;
    if (content && (!content.ok || !/^[0-9a-f]{40,64}\n$/.test(content.value.text))) return { display: content.ok ? 'Git file fingerprint unavailable' : content.error };
    const lines = [`  ${trim(entry.path, width - 4)}`, '', ...(change?.ok ? [visible(change.value.text.slice(0, 8_000)), ''] : []), 'The current file will be backed up outside this repository before the change.', 'Confirmation refuses a changed file or Git status.'];
    save({ ...state, preview: { kind: 'discard', tracked, target: entry.path, from: state.head?.oid ?? null, destination: null, status: state.status, lines, guards: tracked && index?.ok && content?.ok ? [...state.guards, index.value, content.value.guard] : state.guards, paths: [entry.path], expected: { [entry.path]: file.sha256 } } });
    return null;
  };
  api.command('discard', discard, { description: 'Preview backing up and discarding an untracked file' });
  api.command('act', value => {
    const [action, ...rest] = String(value ?? '').trim().split(' ');
    const path = rest.join(' ');
    const state = refresh({ ...saved(), selected: path, notice: null });
    if (!state.entries.some(entry => entry.path === path)) return { display: `${trim(path, 80)} has no Git change` };
    return action === 'stage' || action === 'unstage' ? changeIndex(action) : action === 'discard' ? discard() : { display: 'usage: /act stage|unstage|discard PATH' };
  }, { description: 'Select a changed file and stage, unstage or preview discarding it' });
  api.command('switch', () => {
    const state = refresh();
    if (state.error) return { display: `Git: ${state.error}` };
    const target = state.branch ?? state.branches.find(branch => branch !== state.head?.branch);
    if (!target) return { display: 'no other local branch' };
    const destination = read(['show-ref', '--verify', '--hash', `refs/heads/${target}`], 256);
    if (!destination.ok) return { display: destination.error };
    const oid = destination.value.text.trim();
    if (!/^[0-9a-f]{40,64}$/.test(oid)) return { display: 'branch destination unavailable' };
    const changes = state.head?.oid ? read(['diff', '--name-status', '-z', '--no-ext-diff', '--no-textconv', state.head.oid, oid], 16_384) : { ok: true as const, value: { text: '', guard: null } };
    if (!changes.ok) return { display: changes.error };
    const records = changes.value.text.split('\0').filter(Boolean);
    const changed: string[] = [];
    const paths: string[] = [];
    for (let index = 0; index < records.length;) {
      const status = records[index++];
      const path = records[index++];
      if (!/^[A-Z][0-9]*$/.test(status) || !path) return { display: 'branch diff format unavailable' };
      paths.push(path);
      if (status.startsWith('R') || status.startsWith('C')) {
        const next = records[index++];
        if (!next) return { display: 'branch diff format unavailable' };
        paths.push(next);
        changed.push(`${status} ${JSON.stringify(path)} ${glyph.arrow} ${JSON.stringify(next)}`);
      } else changed.push(`${status} ${JSON.stringify(path)}`);
    }
    const affected = [...new Set(paths)];
    let expected: Record<string, Fingerprint> | null = null;
    let reason = state.total ? 'local changes must be resolved before switching' : affected.length === 0 || affected.length > 128 ? 'branch write scope is empty or too large' : '';
    if (!reason) {
      const allowed = access(affected);
      if (!allowed.ok) reason = allowed.error;
      else {
        const version = api.host.tryCall('workspace.stat', { paths: affected, hash: true });
        if (!version.ok) reason = version.error;
        else if (affected.some(path => version.value.files[path] && (version.value.files[path]?.kind !== 'file' || !version.value.files[path]?.sha256))) reason = 'branch write scope contains a non-regular file';
        else expected = Object.fromEntries(affected.map(path => [path, version.value.files[path]?.sha256 ?? null]));
      }
    }
    const lines = [`${state.head?.oid?.slice(0, 7) ?? 'no commit'} ${glyph.arrow} ${oid.slice(0, 7)}  ${changed.length} changed`, '', ...changed.map(value => `  ${value}`), '', reason || 'Affected files are backed up outside this repository before switching.'];
    if (bytes(lines.join('\n')) > DIALOG_TEXT_LIMIT) return { display: 'affected paths exceed the exact switch preview limit' };
    save({ ...state, branch: target, preview: { kind: 'switch', tracked: false, target, from: state.head?.oid ?? null, destination: oid, status: state.status, lines, guards: [...state.guards, destination.value.guard, ...(changes.value.guard ? [changes.value.guard] : [])], paths: affected, expected } });
    return null;
  }, { description: 'Preview a local branch switch' });
  api.command('commit', () => {
    if (!saved().message.trim()) return { display: 'type a commit message first' };
    const state = refresh();
    if (state.error) return { display: `Git: ${state.error}` };
    if (state.entries.some(entry => entry.conflicted)) return { display: 'resolve conflicted files before committing' };
    const current = status();
    if (!current.ok || current.value.raw !== state.status || current.value.head.oid !== state.head?.oid) return { display: STALE };
    const staged = current.value.entries.filter(entry => entry.index !== ' ' && entry.index !== '?');
    if (!staged.length) return { display: 'nothing is staged' };
    const paths = [...new Set(staged.flatMap(entry => [entry.path, ...(entry.original ? [entry.original] : [])]))];
    if (paths.length > 128) return { display: 'too many staged paths to authorize safely' };
    const allowed = access(paths);
    if (!allowed.ok) return { display: allowed.error };
    const index = read(['ls-files', '-s', '-z']);
    if (!index.ok) return { display: index.error };
    const lines = [`message: ${trim(state.message.split('\n')[0], 80)}`, '', ...staged.map(entry => `  ${entry.index}${entry.worktree} ${entry.original ? `${JSON.stringify(entry.original)} ${glyph.arrow} ` : ''}${JSON.stringify(entry.path)}`), '', 'Git status and the full index are checked again before committing. Hooks may change the staged tree; inspect the commit if its tree differs from the preview.'];
    if (bytes(lines.join('\n')) > DIALOG_TEXT_LIMIT) return { display: 'staged paths exceed the exact commit preview limit' };
    save({ ...state, preview: { kind: 'commit', tracked: false, target: '', from: state.head?.oid ?? null, destination: null, status: state.status, lines, guards: [...current.value.guards, index.value.guard], paths, expected: null } });
    return null;
  }, { description: 'Preview a staged commit with an index fingerprint' });
  api.command('staged_diff', () => {
    const preview = saved().preview;
    if (preview?.kind !== 'commit') return { display: 'open a commit preview first' };
    const result = run(['diff', '--cached', '--no-ext-diff', '--no-textconv', '--ignore-submodules=all'], 65_536);
    return { display: result.ok ? `${result.value.slice(0, 12_000)}${result.value.length > 12_000 ? `\n${glyph.more} truncated` : ''}` : result.error };
  }, { description: 'Show the staged diff for the commit preview' });
  api.command('confirm', () => {
    const previous = saved();
    const preview = previous.preview;
    if (!preview) return { display: 'nothing to confirm' };
    if (preview.kind === 'commit') {
      const current = status();
      if (!current.ok || current.value.raw !== preview.status || current.value.head.oid !== preview.from || !previous.message.trim()) { save({ ...previous, preview: null, notice: STALE }); return { display: STALE }; }
      const result = write(['commit', '--file=-', '--cleanup=strip'], preview.guards, preview.paths, previous.message.trim(), 120_000);
      if (!result.ok) {
        const observed = status();
        const moved = observed.ok && observed.value.head.oid !== preview.from;
        const notice = `${moved ? `HEAD moved to ${observed.value.head.oid?.slice(0, 12) ?? 'an unknown commit'}` : 'Commit did not complete'}; ${visible(result.error, 160)}; preview index ${preview.guards.at(-1)?.stdout_sha256.slice(0, 12) ?? 'unavailable'}. Refresh and inspect Git state.`;
        save({ ...previous, preview: null, notice });
        return { display: notice };
      }
      const tree = read(['ls-tree', '-r', '--full-tree', '-z', '--format=%(objectmode) %(objectname) 0%x09%(path)', 'HEAD']);
      const matches = tree.ok && tree.value.guard.program === 'git' && tree.value.guard.sha256 === preview.guards[0].sha256 && tree.value.guard.stdout_sha256 === preview.guards.at(-1)?.stdout_sha256;
      const next = refresh({ ...previous, preview: null, message: '' });
      const notice = matches ? `committed ${next.head?.oid?.slice(0, 7) ?? 'staged files'}` : `commit created; committed tree could not be matched to the previewed index${tree.ok ? '' : ` (${visible(tree.error, 100)})`}. Inspect the commit before relying on the preview.`;
      save({ ...next, notice });
      return { display: notice };
    }
    if (preview.kind === 'switch') {
      if (!preview.expected || !preview.paths.length || preview.guards.length !== 4) return { display: WRITE_UNAVAILABLE };
      const current = status();
      if (!current.ok || current.value.raw !== preview.status || current.value.head.oid !== preview.from || current.value.entries.length) { save({ ...previous, preview: null, notice: STALE }); return { display: STALE }; }
      const destination = read(['show-ref', '--verify', '--hash', `refs/heads/${preview.target}`], 256);
      if (!destination.ok || destination.value.text.trim() !== preview.destination) { save({ ...previous, preview: null, notice: STALE }); return { display: STALE }; }
      const backup = api.host.tryCall('workspace.backup', { expected: preview.expected });
      if (!backup.ok) { save({ ...previous, preview: null, notice: backup.error }); return { display: backup.error }; }
      const result = write(['switch', '--no-overwrite-ignore', '--', preview.target], preview.guards, preview.paths);
      if (!result.ok) { const notice = `${result.error}; backup ${backup.value.backup.reference}`; save({ ...previous, preview: null, notice }); return { display: notice }; }
      const next = refresh({ ...previous, preview: null, branch: null });
      const notice = `switched to ${trim(preview.target, 80)}; backup ${backup.value.backup.reference}`;
      save({ ...next, notice });
      return { display: notice };
    }
    if (preview.kind !== 'discard' || !preview.expected || preview.paths.length !== 1) return { display: WRITE_UNAVAILABLE };
    const current = status();
    if (!current.ok || current.value.raw !== preview.status || current.value.head.oid !== preview.from || !current.value.entries.some(entry => entry.path === preview.target && !entry.conflicted && (preview.tracked ? entry.index !== '?' && entry.worktree !== ' ' : entry.index === '?' && entry.worktree === '?'))) {
      save({ ...previous, preview: null, notice: STALE });
      return { display: STALE };
    }
    if (preview.tracked) {
      const backup = api.host.tryCall('workspace.backup', { expected: preview.expected });
      if (!backup.ok) { save({ ...previous, preview: null, notice: backup.error }); return { display: backup.error }; }
      const result = write(['restore', '--worktree', '--', preview.target], preview.guards, preview.paths);
      const version = api.host.tryCall('workspace.stat', { paths: preview.paths, hash: true });
      const expected = version.ok ? version.value.files[preview.target]?.sha256 ?? null : null;
      const retained = { path: preview.target, reference: backup.value.backup, expected };
      if (!result.ok) { save({ ...previous, preview: null, notice: result.error, backup: retained }); return { display: `${result.error}; backup retained` }; }
      const next = refresh({ ...previous, preview: null });
      const notice = `discarded ${trim(preview.target, 80)}; backup ${backup.value.backup.reference}`;
      save({ ...next, notice, backup: retained });
      return { display: notice };
    }
    const result = api.host.tryCall('workspace.transaction', { expected: preview.expected, deletes: preview.paths, backup: true });
    if (!result.ok || !result.value.backup) {
      const notice = !result.ok && result.error.startsWith('stale') ? STALE : !result.ok ? result.error : 'backup unavailable; discard refused';
      save({ ...previous, preview: null, notice });
      return { display: notice };
    }
    const next = refresh({ ...previous, preview: null });
    const notice = `discarded ${trim(preview.target, 80)}; backup ${result.value.backup.reference}`;
    save({ ...next, notice, backup: { path: preview.target, reference: result.value.backup, expected: null } });
    return { display: notice };
  }, { description: 'Confirm an untracked discard with an outside-repository backup' });
  api.command('restore', () => {
    const state = saved();
    if (!state.backup) return { display: 'no Git discard backup to restore' };
    const restored = api.host.tryCall('workspace.restore', { backup: state.backup.reference, expected: { [state.backup.path]: state.backup.expected } });
    if (!restored.ok) return { display: restored.error };
    const next = refresh({ ...state, backup: null, preview: null });
    const notice = `restored ${trim(state.backup.path, 80)}`;
    save({ ...next, notice });
    return { display: notice };
  }, { description: 'Restore the last discarded file if its path is still absent' });
  api.command('cancel', () => { save({ ...saved(), preview: null }); return null; }, { description: 'Close the Git preview' });
  for (const event of ['start', 'resume', 'turn_start', 'turn_end', 'idle'] as const) api.on(event, () => { refresh(); });
  api.on('terminal', () => view());
}
