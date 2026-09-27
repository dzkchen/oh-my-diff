import type { GitCommit, GitEntry, GitHead, GitStatus, Json, ModAPI, TerminalComponent, TerminalPatch, TerminalRenderSite, TerminalTone } from '../../api-0.1.d.ts';

type Entry = { p: string; o: string | null; x: string; y: string; c: boolean; f: string };
type Row = { g: string; o: string; s: string };
type Preview = { kind: 'discard' | 'commit' | 'switch'; paths: string[]; fingerprint: string; lines: string[]; target: string };
type Saved = {
  error: string | null;
  head: GitHead | null;
  entries: Entry[];
  total: number;
  rows: Row[];
  more: boolean;
  branches: string[];
  selected: string | null;
  branch: string | null;
  message: string;
  preview: Preview | null;
  notice: string | null;
};

const ENTRY_LIMIT = 40;
const EMPTY: Saved = { error: null, head: null, entries: [], total: 0, rows: [], more: false, branches: [], selected: null, branch: null, message: '', preview: null, notice: null };

export default function activate(api: ModAPI) {
  const ascii = api.settings.icons === 'ascii';
  const glyph = ascii
    ? { node: '*', pipe: '|', merge: '\\', up: '^', down: 'v', arrow: '->', more: '...' }
    : { node: '●', pipe: '│', merge: '╮', up: '↑', down: '↓', arrow: '→', more: '…' };
  const width = Math.min(60, Math.max(24, typeof api.settings.width === 'number' ? Math.floor(api.settings.width) : 40));
  const text = width - 4;
  const trim = (value: string, limit = text) => (value.length > limit ? `${value.slice(0, Math.max(1, limit - 1))}${glyph.more}` : value);
  const bytes = (value: string) => [...value].reduce((total, char) => {
    const code = char.codePointAt(0) ?? 0;
    return total + (code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4);
  }, 0);
  const fit = (value: string, limit: number) => {
    if (bytes(value) <= limit) return value;
    let result = '';
    let used = bytes(glyph.more);
    for (const char of value) {
      used += bytes(char);
      if (used > limit) break;
      result += char;
    }
    return `${result}${glyph.more}`;
  };

  const saved = (): Saved => {
    const stored = api.state.get();
    return stored && typeof stored === 'object' && !Array.isArray(stored) ? { ...EMPTY, ...(stored as unknown as Partial<Saved>) } : { ...EMPTY };
  };
  const save = (state: Saved) => api.state.set(state as unknown as Json);

  const graph = (commits: GitCommit[]): Row[] => {
    const lanes: string[] = [];
    return commits.map(commit => {
      let column = lanes.indexOf(commit.oid);
      if (column < 0) {
        column = lanes.length;
        lanes.push(commit.oid);
      }
      let prefix = lanes.map((_, index) => (index === column ? glyph.node : glyph.pipe)).join(' ');
      const [first, ...others] = commit.parents;
      if (first === undefined) lanes.splice(column, 1);
      else lanes[column] = first;
      for (const parent of others) {
        if (!lanes.includes(parent)) {
          lanes.push(parent);
          prefix += glyph.merge;
        }
      }
      for (let index = lanes.length - 1; index > 0; index -= 1) {
        if (lanes.indexOf(lanes[index]) !== index) lanes.splice(index, 1);
      }
      return { g: prefix, o: commit.oid.slice(0, 7), s: commit.subject };
    });
  };

  const compact = (entry: GitEntry): Entry => ({ p: entry.path, o: entry.orig_path, x: entry.index, y: entry.worktree, c: entry.conflicted, f: entry.fingerprint });

  const refresh = (state: Saved = saved()): Saved => {
    const status = api.host.tryCall('git.status', null);
    if (!status.ok) {
      const next = { ...EMPTY, error: status.error.replace(/^git_failed: /, ''), message: state.message };
      save(next);
      return next;
    }
    const value: GitStatus = status.value;
    const order = (entry: GitEntry) => (entry.conflicted ? 0 : entry.worktree !== ' ' && entry.index !== '?' ? 1 : entry.index === '?' ? 2 : 3);
    const entries = [...value.entries].sort((left, right) => order(left) - order(right) || left.path.localeCompare(right.path)).slice(0, ENTRY_LIMIT).map(compact);
    const log = api.host.tryCall('git.log', { limit: Math.min(12, Math.max(1, typeof api.settings.commits === 'number' ? Math.floor(api.settings.commits) : 6)) });
    const branches = api.host.tryCall('git.branches', null);
    const selected = entries.some(entry => entry.p === state.selected) ? state.selected : entries[0]?.p ?? null;
    const local = branches.ok ? branches.value.local.slice(0, 16) : [];
    const next: Saved = {
      ...state,
      error: null,
      head: value.head,
      entries,
      total: value.entries.length + (value.truncated ? 1 : 0),
      rows: log.ok ? graph(log.value.commits) : [],
      more: log.ok && log.value.truncated,
      branches: local,
      selected,
      branch: state.branch && local.includes(state.branch) ? state.branch : null,
    };
    save(next);
    return next;
  };

  const line = (id: string, label: string, value: string, tone: TerminalTone = 'normal'): TerminalComponent => ({ type: 'text', id, label, text: value, tone });
  const button = (id: string, label: string, value: string, command: string, args = ''): TerminalComponent => ({ type: 'button', id, label: fit(label, 128), text: fit(value, 200), action: { command: `omd_git:${command}`, args } });
  const describe = (entry: Entry) => `${entry.x}${entry.y} ${entry.o ? `${entry.o} ${glyph.arrow} ${entry.p}` : entry.p}`;
  const headline = (head: GitHead | null) => {
    if (!head) return 'no commits';
    const where = head.branch ?? `detached @ ${head.oid?.slice(0, 7) ?? '?'}`;
    const drift = head.upstream ? `  ${glyph.up}${head.ahead} ${glyph.down}${head.behind}` : '';
    return `${where}${drift}`;
  };

  const sidebar = (state: Saved): TerminalComponent[] => {
    if (state.error) {
      const known: Record<string, string> = { not_a_git_repository: 'not a Git repository', git_unavailable: 'git is not installed' };
      const reason = known[state.error] ?? (state.error.startsWith('git_unavailable') ? known.git_unavailable : state.error);
      return [line('omd_git_error', 'Git status', `Git ${glyph.more} ${trim(reason)}`, state.error === 'not_a_git_repository' ? 'muted' : 'failure')];
    }
    const groups: [string, string, TerminalTone, (entry: Entry) => boolean][] = [
      ['conflicted', 'Conflicted files', 'failure', entry => entry.c],
      ['staged', 'Staged files', 'success', entry => !entry.c && entry.x !== ' ' && entry.x !== '?'],
      ['unstaged', 'Unstaged files', 'attention', entry => !entry.c && entry.y !== ' ' && entry.x !== '?'],
      ['untracked', 'Untracked files', 'muted', entry => entry.x === '?'],
    ];
    const staged = state.entries.filter(groups[1][3]).length;
    const changes = groups
      .map(([name, label, tone, test]) => {
        const matched = state.entries.filter(test);
        return matched.length ? line(`omd_git_${name}`, label, [name, ...matched.slice(0, 6).map(entry => `  ${trim(describe(entry), text - 2)}`), ...(matched.length > 6 ? [`  ${glyph.more} ${matched.length - 6} more`] : [])].join('\n'), tone) : null;
      })
      .filter((component): component is TerminalComponent => component !== null);
    const other = state.total - staged;
    const components: TerminalComponent[] = [
      {
        type: 'pane', id: 'omd_git_graph', label: 'Git commit graph', title: fit(trim(`Git  ${headline(state.head)}`), 128),
        children: [line('omd_git_commits', 'Recent commits', state.rows.length ? [...state.rows.map(row => trim(`${row.g} ${row.o} ${row.s}`)), ...(state.more ? [`${glyph.down} more ${glyph.more} /omd_git:log`] : [])].join('\n') : 'no commits yet', 'accent')],
      },
      {
        type: 'pane', id: 'omd_git_changes', label: 'Changed files', title: trim(`Changes  ${staged} staged ${glyph.more} ${other} other`),
        children: changes.length ? changes : [line('omd_git_clean', 'Working tree clean', 'working tree clean', 'success')],
      },
    ];
    const options = state.entries.filter(entry => bytes(entry.p) <= 128).slice(0, 16);
    const selected = options.find(entry => entry.p === state.selected) ?? options[0];
    if (selected) {
      components.push({ type: 'select', id: 'omd_git_file', label: 'Selected file', value: selected.p, options: options.map(entry => ({ value: entry.p, label: fit(describe(entry), 128) })), action: { command: 'omd_git:file' } });
      components.push(button('omd_git_diff', `Show diff of ${selected.p}`, 'Diff', 'diff'));
      if (!selected.c && (selected.y !== ' ' || selected.x === '?')) components.push(button('omd_git_stage', `Stage ${selected.p}`, 'Stage', 'stage'));
      if (!selected.c && selected.x !== ' ' && selected.x !== '?') components.push(button('omd_git_unstage', `Unstage ${selected.p}`, 'Unstage', 'unstage'));
      if (!selected.c && (selected.y !== ' ' || selected.x === '?')) components.push(button('omd_git_discard', `Discard changes to ${selected.p}`, `Discard${glyph.more}`, 'discard'));
    }
    components.push({ type: 'input', id: 'omd_git_message', label: 'Commit message', value: state.message, placeholder: 'type a commit message', action: { command: 'omd_git:message' } });
    if (staged) components.push(button('omd_git_commit', `Commit ${staged} staged files`, `Commit ${staged} staged${glyph.more}`, 'commit'));
    const targets = state.branches.filter(name => name !== state.head?.branch && bytes(name) <= 128);
    if (targets.length) {
      components.push({ type: 'select', id: 'omd_git_branch', label: 'Branch to switch to', value: state.branch && targets.includes(state.branch) ? state.branch : targets[0], options: targets.map(name => ({ value: name, label: fit(name, 128) })), action: { command: 'omd_git:branch' } });
      components.push(button('omd_git_switch', 'Switch to the selected branch', `Switch${glyph.more}`, 'switch'));
    }
    if (state.notice) components.push(line('omd_git_notice', 'Git notice', trim(state.notice, text * 2), 'muted'));
    return components;
  };

  const dialog = (preview: Preview): TerminalRenderSite => {
    const title = { discard: 'Discard changes?', commit: 'Commit staged files?', switch: `Switch to ${preview.target}?` }[preview.kind];
    const confirm = { discard: `Discard ${preview.paths.length === 1 ? preview.paths[0] : `${preview.paths.length} files`}`, commit: 'Commit', switch: 'Switch branch' }[preview.kind];
    const children: TerminalComponent[] = [line('omd_git_preview', `${title} preview`, preview.lines.join('\n'))];
    children.push(button('omd_git_confirm', confirm, trim(confirm, 60), 'confirm'));
    if (preview.kind === 'commit') children.push(button('omd_git_staged_diff', 'Show the staged diff', 'Show staged diff', 'staged_diff'));
    children.push(button('omd_git_cancel', 'Cancel', 'Cancel', 'cancel'));
    return { mode: 'replace', components: [{ type: 'dialog', id: 'omd_git_dialog', label: fit(title, 128), title: fit(title, 128), children }] };
  };

  const view = (): TerminalPatch => {
    const state = saved();
    const sites: Partial<Record<'sidebar' | 'dialog', TerminalRenderSite>> = {
      sidebar: { mode: 'wrap', components: [...sidebar(state), { type: 'slot' }] },
    };
    if (state.preview) sites.dialog = dialog(state.preview);
    const count = state.total ? ` ${ascii ? '*' : '✱'}${state.total}` : '';
    return {
      sidebar_side: api.settings.side === 'right' ? 'right' : 'left',
      sidebar_width: width,
      sites,
      status: state.error ? [] : [fit(`git: ${state.head?.branch ?? 'detached'}${count}`, 40)],
      keybindings: { 'Alt+g': { command: 'omd_git:refresh' } },
    };
  };

  const stale = (error: string) => error.startsWith('stale_git_state');
  const fail = (state: Saved, error: string) => {
    const next = refresh({ ...state, preview: null });
    const notice = stale(error) ? 'Changed since it was shown; review the refreshed state and retry.' : error;
    save({ ...next, notice });
    return { display: notice };
  };
  const counts = (diff: string) => {
    const lines = diff.split('\n');
    const added = lines.filter(value => value.startsWith('+') && !value.startsWith('+++')).length;
    const removed = lines.filter(value => value.startsWith('-') && !value.startsWith('---')).length;
    return `+${added} -${removed}`;
  };

  const commands: Record<string, (argument: string) => { display: string } | null> = {
    refresh: () => {
      const state = refresh({ ...saved(), notice: null });
      return { display: state.error ? `Git: ${state.error}` : `Git: ${headline(state.head)}, ${state.total} changed` };
    },
    status: () => {
      const state = refresh();
      if (state.error) return { display: `Git: ${state.error}` };
      return { display: [`${headline(state.head)}`, ...state.entries.map(describe)].join('\n') || 'working tree clean' };
    },
    log: () => {
      const log = api.host.tryCall('git.log', { limit: 50 });
      return { display: log.ok ? graph(log.value.commits).map(row => `${row.g} ${row.o} ${row.s}`).join('\n') || 'no commits yet' : log.error };
    },
    file: argument => {
      const state = saved();
      if (!state.entries.some(entry => entry.p === argument)) return { display: `not a changed file: ${argument}` };
      save({ ...state, selected: argument, notice: null });
      return null;
    },
    branch: argument => {
      const state = saved();
      if (!state.branches.includes(argument)) return { display: `unknown branch: ${argument}` };
      save({ ...state, branch: argument, notice: null });
      return null;
    },
    message: argument => {
      const message = argument.slice(0, 4096);
      save({ ...saved(), message, notice: null });
      return { display: message.trim() ? 'commit message saved' : 'commit message cleared' };
    },
    diff: argument => {
      const state = saved();
      const path = argument || state.selected;
      const entry = state.entries.find(item => item.p === path);
      if (!path || !entry) return { display: 'select a changed file first' };
      const staged = entry.y === ' ' && entry.x !== ' ' && entry.x !== '?';
      const diff = api.host.tryCall('git.diff', { path, staged });
      if (!diff.ok) return { display: diff.error };
      const body = diff.value.binary ? 'binary file changed' : diff.value.text || 'no textual changes';
      return { display: `${staged ? 'staged' : 'unstaged'} diff · ${path}\n${body.slice(0, 12_000)}${diff.value.truncated || body.length > 12_000 ? `\n${glyph.more} truncated` : ''}` };
    },
    stage: () => {
      const state = saved();
      const entry = state.entries.find(item => item.p === state.selected);
      if (!entry) return { display: 'select a changed file first' };
      const result = api.host.tryCall('git.stage', { paths: [entry.p], fingerprint: entry.f });
      if (!result.ok) return fail(state, result.error);
      save({ ...refresh(state), notice: `staged ${entry.p}` });
      return { display: `staged ${entry.p}` };
    },
    unstage: () => {
      const state = saved();
      const entry = state.entries.find(item => item.p === state.selected);
      if (!entry) return { display: 'select a changed file first' };
      const result = api.host.tryCall('git.unstage', { paths: [entry.p], fingerprint: entry.f });
      if (!result.ok) return fail(state, result.error);
      save({ ...refresh(state), notice: `unstaged ${entry.p}` });
      return { display: `unstaged ${entry.p}` };
    },
    discard: () => {
      const state = saved();
      const entry = state.entries.find(item => item.p === state.selected);
      if (!entry) return { display: 'select a changed file first' };
      const diff = api.host.tryCall('git.diff', { path: entry.p, staged: false });
      if (!diff.ok) return fail(state, diff.error);
      const head = state.head?.oid?.slice(0, 7) ?? 'no commit';
      const lines = [
        `HEAD ${head} ${glyph.more} checked again on confirm`,
        '',
        `  ${describe(entry)}   ${diff.value.binary ? 'binary' : counts(diff.value.text)}`,
        ...diff.value.text.split('\n').filter(value => /^[+-][^+-]/.test(value)).slice(0, 8).map(value => `    ${trim(value, 64)}`),
        '',
        entry.x === '?' ? 'The untracked file is moved to a backup.' : 'A copy is kept in a backup before restoring.',
      ];
      save({ ...state, notice: null, preview: { kind: 'discard', paths: [entry.p], fingerprint: diff.value.fingerprint, lines, target: entry.p } });
      return null;
    },
    commit: () => {
      const state = saved();
      if (!state.message.trim()) return { display: 'type a commit message first' };
      const status = api.host.tryCall('git.status', null);
      if (!status.ok) return fail(state, status.error);
      if (status.value.truncated) return { display: 'too many changes to preview a commit safely' };
      const staged = status.value.entries.filter(entry => !entry.conflicted && entry.index !== ' ' && entry.index !== '?');
      if (!staged.length) return { display: 'nothing is staged' };
      const lines = [`message: ${trim(state.message.split('\n')[0], 60)}`, '', ...staged.slice(0, 10).map(entry => `  ${describe(compact(entry))}`), ...(staged.length > 10 ? [`  ${glyph.more} ${staged.length - 10} more`] : [])];
      save({ ...state, notice: null, preview: { kind: 'commit', paths: staged.map(entry => entry.path), fingerprint: status.value.staged_fingerprint, lines, target: '' } });
      return null;
    },
    staged_diff: () => {
      const preview = saved().preview;
      if (!preview || preview.kind !== 'commit') return { display: 'open a commit preview first' };
      const parts: string[] = [];
      for (const path of preview.paths.slice(0, 8)) {
        const diff = api.host.tryCall('git.diff', { path, staged: true });
        parts.push(diff.ok ? (diff.value.binary ? `binary ${path}` : diff.value.text) : `${path}: ${diff.error}`);
      }
      const body = parts.join('\n');
      return { display: `${body.slice(0, 12_000)}${body.length > 12_000 || preview.paths.length > 8 ? `\n${glyph.more} truncated` : ''}` };
    },
    switch: () => {
      const state = saved();
      const target = state.branch ?? state.branches.find(name => name !== state.head?.branch);
      if (!target) return { display: 'no other local branch' };
      const preview = api.host.tryCall('git.switch_preview', { branch: target });
      if (!preview.ok) return fail(state, preview.error);
      const { changes, fingerprint } = preview.value;
      if (!fingerprint) return { display: 'too many changes to preview a branch switch safely' };
      const count = changes.length + (preview.value.truncated ? 1 : 0);
      const local = preview.value.local_changes;
      const lines = [
        `${preview.value.from?.slice(0, 7) ?? 'no commit'} ${glyph.arrow} ${preview.value.to.slice(0, 7)}  ${preview.value.truncated ? `${changes.length}+` : changes.length} ${count === 1 ? 'file changes' : 'files change'}`,
        '',
        ...changes.slice(0, 8).map(change => `  ${change.status} ${trim(change.path, text - 4)}`),
        ...(count > 8 ? [`  ${glyph.more} ${preview.value.truncated ? 'more' : `${changes.length - 8} more`}`] : []),
        '',
        local ? `${local} local ${local === 1 ? 'change stays' : 'changes stay'}; Git refuses to overwrite them or ignored files.` : 'Git refuses to overwrite ignored files.',
      ];
      save({ ...state, notice: null, branch: target, preview: { kind: 'switch', paths: changes.map(change => change.path).slice(0, 64), fingerprint, lines, target } });
      return null;
    },
    confirm: () => {
      const state = saved();
      const preview = state.preview;
      if (!preview) return { display: 'nothing to confirm' };
      if (preview.kind === 'discard') {
        const result = api.host.tryCall('git.discard', { paths: preview.paths, fingerprint: preview.fingerprint });
        if (!result.ok) return fail(state, result.error);
        save({ ...refresh({ ...state, preview: null }), notice: `discarded; backup at ${result.value.backup}` });
        return { display: `discarded ${preview.paths.join(', ')}; backup at ${result.value.backup}` };
      }
      if (preview.kind === 'commit') {
        const result = api.host.tryCall('git.commit', { message: state.message, fingerprint: preview.fingerprint });
        if (!result.ok) return fail(state, result.error);
        save({ ...refresh({ ...state, preview: null, message: '' }), notice: `committed ${result.value.oid.slice(0, 7)}` });
        return { display: `committed ${result.value.oid.slice(0, 7)}` };
      }
      const result = api.host.tryCall('git.switch', { branch: preview.target, fingerprint: preview.fingerprint });
      if (!result.ok) return fail(state, result.error);
      save({ ...refresh({ ...state, preview: null, branch: null }), notice: `switched to ${preview.target}` });
      return { display: `switched to ${preview.target}` };
    },
    cancel: () => {
      save({ ...saved(), preview: null, notice: 'cancelled' });
      return null;
    },
  };

  const descriptions: Record<string, string> = {
    refresh: 'Refresh the Git sidebar', status: 'Show the current branch and changed files', log: 'Show the recent commit graph',
    file: 'Select a changed file in the Git sidebar', branch: 'Select a branch to switch to', message: 'Set the commit message',
    diff: 'Show the diff of the selected file', stage: 'Stage the selected file', unstage: 'Unstage the selected file',
    discard: 'Preview discarding the selected file', commit: 'Preview a commit of the staged files', staged_diff: 'Show the staged diff for the commit preview',
    switch: 'Preview switching to the selected branch', confirm: 'Confirm the previewed Git action', cancel: 'Cancel the previewed Git action',
  };
  for (const [name, handler] of Object.entries(commands)) {
    api.command(name, argument => handler(typeof argument === 'string' ? argument.trim() : '') ?? null, { description: descriptions[name] });
  }

  for (const event of ['start', 'resume', 'turn_start', 'turn_end', 'idle'] as const) {
    api.on(event, () => {
      refresh();
    });
  }
  api.on('terminal', () => view());
}
