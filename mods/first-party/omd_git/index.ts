import type { CommandResult, Json, KeyContext, ModAPI, TerminalPatch } from '../../api.d.ts';
import { AUTH, COMMITS, DIFF, DOING, OPERATIONS, READ, REJECTED, ROWS, cut, mention, operationOf, parseBranches, parseCommits, parseStash, parseStatus, quote, size, splitPatch, summary } from './git.ts';
import type { Change } from './git.ts';
import { PANELS, SIGNIN, SITE, area, draw, rows, selected } from './view.ts';
import type { Hunk, Repo } from './view.ts';

type State = { placed: boolean; repo: Repo | null };
type Run = { ok: boolean; out: string; err: string; truncated: boolean };
type Action = [string, () => string | null];

const MAIN_BYTES = 28_000;
const MAIN_LINES = 1_000;
const NOTICE_BYTES = 240;
const STEP = 10;
const ECHO_MS = 5_000;
const GIT_MS = 10_000;
const WRITE_MS = 60_000;
const REMOTE_MS = 120_000;

const clip = (text: string) => {
  const kept: string[] = [];
  let used = 0;
  for (const line of text.split('\n')) {
    used += size(line) + 40;
    if (used > MAIN_BYTES || kept.length >= MAIN_LINES) break;
    kept.push(line);
  }
  return kept.join('\n');
};
const staged = (change: Change) => change.x !== ' ' && change.x !== '?' && change.y === ' ';

export default function activate(api: ModAPI) {
  const load = (): State => ({ placed: false, repo: null, ...(api.state.get() as Partial<State> | null) });
  const changed = <T>(change: (state: State) => T): T => {
    const state = load();
    const before = JSON.stringify(state);
    const result = change(state);
    if (JSON.stringify(state) !== before) api.state.set(state as unknown as Json);
    return result;
  };
  const cwd = () => api.session().cwd;
  let wrote = false;

  const git = (top: string, argv: string[], timeout_ms = GIT_MS): Run => {
    if (argv[0] !== READ[0]) wrote = true;
    const run = api.host.tryCall('exec.run', { program: 'git', argv: ['--no-pager', '--literal-pathspecs', '-C', top, '-c', 'color.ui=false', ...argv], sandbox: 'none', timeout_ms });
    if (!run.ok) return { ok: false, out: '', err: run.error, truncated: false };
    return { ok: run.value.exit_code === 0, out: run.value.stdout, err: (run.value.stderr || run.value.stdout).trim(), truncated: Boolean(run.value.stdout_preview_truncated) };
  };
  const fail = (err: string): Run => ({ ok: false, out: '', err, truncated: false });
  const apply = (top: string, patch: string, argv: string[]) => {
    wrote = true;
    const run = api.host.tryCall('exec.run', { program: 'git', argv: ['--literal-pathspecs', '-C', top, 'apply', ...argv, '-'], stdin: patch, sandbox: 'none', timeout_ms: GIT_MS });
    if (!run.ok) return run.error;
    return run.value.exit_code === 0 ? null : run.value.stderr.trim() || 'git apply failed';
  };

  const detect = (dir: string): Repo => {
    const run = api.host.tryCall('exec.run', { program: 'git', argv: ['rev-parse', '--show-toplevel', '--absolute-git-dir'], sandbox: 'none', cwd: dir, timeout_ms: 5_000 });
    const found = run.ok && run.value.exit_code === 0;
    const [top = '', gitdir = ''] = found ? run.value.stdout.trim().split('\n') : [];
    let error: string | null = null;
    if (!run.ok) error = run.error.startsWith('exec_program_unavailable') ? 'git not found on PATH' : cut(run.error, NOTICE_BYTES);
    else if (!found) error = 'Not a Git repository';
    return {
      dir, top, gitdir, error, notice: null, panel: 1, sel: [0, 0, 0, 0, 0], head: { branch: '', upstream: '', ab: null }, op: null,
      files: [], branches: [], commits: [], stash: [], hunks: null, hunk: 0, main: '', scroll: 0,
    };
  };
  const operation = (r: Repo) => operationOf(git(r.top, [...READ, '-C', r.gitdir, 'grep', '--no-index', '-l', '-e', '', '--', ...OPERATIONS.map(([name]) => name)]).out);
  const busy = (r: Repo) => {
    const op = operation(r);
    return op ? `A ${op} is in progress: finish it first (m)` : null;
  };

  const status = (r: Repo) => {
    const run = git(r.top, [...READ, 'status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all']);
    if (!run.ok) {
      r.error = cut(run.err.split('\n')[0] || 'git status failed', NOTICE_BYTES);
      return;
    }
    const kept = r.files[Math.min(r.sel[1], r.files.length - 1)]?.path;
    const { head, files } = parseStatus(run.out);
    r.head = head;
    r.files = files;
    const found = r.files.findIndex(change => change.path === kept);
    if (found >= 0) r.sel[1] = found;
    r.op = operation(r);
    r.error = null;
  };
  const list = (r: Repo, panel: number) => {
    if (panel === 2) r.branches = parseBranches(git(r.top, [...READ, 'for-each-ref', '--sort=-committerdate', `--count=${ROWS}`, '--format=%(HEAD)%00%(refname:short)%00%(upstream:short) %(upstream:track)', 'refs/heads']).out);
    else if (panel === 3) r.commits = parseCommits(git(r.top, [...READ, 'log', '--no-color', `-n${COMMITS}`, '--format=%h%x00%s%x00%an%x00%at']).out);
    else if (panel === 4) r.stash = parseStash(git(r.top, [...READ, 'stash', 'list', '--no-color', '--format=%gd%x00%s']).out);
  };
  const file = (r: Repo) => (r.panel === 1 ? r.files[selected(r)] : undefined);
  const relative = (r: Repo, path: string) => {
    const here = `${cwd()}/`;
    const prefix = here.slice(r.top.length + 1);
    return here.startsWith(`${r.top}/`) && path.startsWith(prefix) ? path.slice(prefix.length) : `${r.top}/${path}`;
  };

  const patches = (r: Repo, path: string, cached: boolean) => {
    const run = git(r.top, [...READ, ...DIFF, ...(cached ? ['--cached'] : []), '--', path]);
    return { ...splitPatch(run.out, run.truncated), truncated: run.truncated };
  };
  const loadHunks = (r: Repo, path: string) => {
    const sides = [patches(r, path, false), patches(r, path, true)];
    const list: Hunk[] = [];
    const text: string[] = [];
    let line = 0;
    sides.forEach((side, index) => side.parts.forEach(part => {
      list.push({ staged: index === 1, header: part.split('\n')[0], line });
      text.push(part);
      line += part.split('\n').length - 1;
    }));
    r.hunks = { path, list };
    r.hunk = Math.min(r.hunk, Math.max(0, list.length - 1));
    r.main = clip(text.join(''));
    return {
      binary: sides.some(side => side.binary),
      notice: sides.some(side => side.truncated) ? 'The diff is too large: the last hunks are left out' : null,
    };
  };
  const patchOf = (r: Repo, hunk: Hunk) => {
    if (!r.hunks) return null;
    const side = patches(r, r.hunks.path, hunk.staged);
    const index = r.hunks.list.filter(item => item.staged === hunk.staged).indexOf(hunk);
    const part = side.parts[index];
    return part?.split('\n')[0] === hunk.header ? side.head + part : null;
  };
  const view = (r: Repo) => {
    const at = selected(r);
    if (r.hunks) {
      r.scroll = r.hunks.list[r.hunk]?.line ?? 0;
      return;
    }
    r.scroll = 0;
    const graph = (...refs: string[]) => git(r.top, [...READ, 'log', '--no-color', '--graph', '--oneline', '--decorate', '-n60', ...refs]).out;
    let text = '';
    if (r.panel === 0) text = graph();
    else if (r.panel === 1) {
      const change = r.files[at];
      if (change?.kind === '?') text = git(r.top, [...READ, ...DIFF, '--no-index', '--', '/dev/null', change.path]).out;
      else if (change) {
        const diff = (base: string[]) => git(r.top, [...READ, ...DIFF, ...base, '--', change.path]);
        const head = diff(['HEAD']);
        text = head.ok ? head.out : diff(['--cached']).out;
      }
    } else if (r.panel === 2 && r.branches[at]) text = graph(r.branches[at].name, '--');
    else if (r.panel === 3 && r.commits[at]) text = git(r.top, [...READ, 'show', '--no-color', '--stat', '--patch', '--format=fuller', r.commits[at].sha]).out;
    else if (r.panel === 4 && r.stash[at]) text = git(r.top, [...READ, 'stash', 'show', '--no-color', '--stat', '--patch', r.stash[at].ref]).out;
    r.main = clip(text || (r.panel === 1 ? 'Working tree clean' : ''));
  };
  const closeSignin = (r: Repo) => {
    const read = api.host.tryCall('terminal.pty', { action: 'read', session: 'signin' });
    const done = read.ok && 'running' in read.value && !read.value.running ? read.value : null;
    if (!done && (read.ok || !/^pty_(session_unknown|context_changed)/.test(read.error))) return;
    delete r.signin;
    api.host.tryCall('terminal.pty', { action: 'stop', session: 'signin' });
    if (!done) return;
    const last = done.text.split('\n').map(part => part.trim()).filter(Boolean).at(-1);
    r.notice = done.exit_code === 0 ? 'git finished' : cut(`git exited with ${done.exit_code}${last ? `: ${last}` : ''}`, NOTICE_BYTES);
  };
  const refresh = (r: Repo) => {
    if (r.signin) closeSignin(r);
    status(r);
    for (const panel of [2, 3, 4]) list(r, panel);
    if (r.hunks) loadHunks(r, r.hunks.path);
    if (r.hunks && !r.hunks.list.length) r.hunks = null;
    view(r);
  };
  const repo = (state: State, dir: string, reload: boolean): Repo => {
    const known = state.repo?.dir === dir && state.repo.top ? state.repo : null;
    const r = known ?? detect(dir);
    if (r.top && (reload || !known)) refresh(r);
    state.repo = r;
    return r;
  };

  const confirm = (title: string, message: string) => {
    const answer = api.host.tryCall('terminal.prompt', { kind: 'confirm', title, message });
    return answer.ok && answer.value.status === 'accepted';
  };
  const ask = (title: string, message: string): string | null => {
    const answer = api.host.tryCall('terminal.prompt', { kind: 'text', title, message });
    return answer.ok && answer.value.status === 'accepted' ? answer.value.value?.trim() ?? '' : null;
  };
  const choose = (title: string, message: string, options: { value: string; label: string }[]) => {
    const answer = api.host.tryCall('terminal.prompt', { kind: 'choice', title, message, options });
    return answer.ok && answer.value.status === 'accepted' ? answer.value.value ?? answer.value.values?.[0] ?? null : null;
  };
  const attach = (text: string) => {
    const draft = api.host.tryCall('composer.read', null);
    if (!draft.ok) return draft.error;
    const write = api.host.tryCall('composer.write', { revision: draft.value.revision, edit: { kind: 'insert', text } });
    return write.ok ? 'Added to the prompt' : write.error;
  };
  const result = (run: Run, done: string) => (run.ok ? done : run.err || 'git failed');
  const remote = (r: Repo, argv: string[], done: string, run = git(r.top, argv, REMOTE_MS)) => {
    if (run.ok || !AUTH.test(run.err)) return result(run, done);
    if (!confirm('Sign in', `git ${argv[0]} needs a password, passphrase or host key answer. Run it in a terminal here?`)) return run.err;
    api.host.tryCall('terminal.pty', { action: 'stop', session: 'signin' });
    const pty = api.host.tryCall('terminal.pty', { action: 'start', session: 'signin', program: 'git', argv: ['-C', r.top, ...argv], sandbox: 'none' });
    if (!pty.ok) return pty.error;
    if (!('running' in pty.value)) return 'Terminal start declined';
    r.signin = true;
    return 'Answer git in the terminal below: i types in it, Ctrl+] leaves it, R refreshes once git exits';
  };
  const push = (r: Repo) => {
    const { branch, upstream } = r.head;
    if (!branch) return 'HEAD is detached: check out a branch to push it';
    if (!confirm('Push', upstream ? `Push ${branch} to its upstream?` : `Push ${branch} to origin and track it?`)) return null;
    const argv = upstream ? ['push'] : ['push', '-u', 'origin', branch];
    const run = git(r.top, argv, REMOTE_MS);
    if (run.ok || !REJECTED.test(run.err)) return remote(r, argv, 'Pushed', run);
    if (!confirm('Force push', `The remote ${branch} has commits yours doesn't, as after an amend or reword. Force push with lease?`)) return summary(run.err);
    return remote(r, ['push', '--force-with-lease', ...argv.slice(1)], 'Force pushed');
  };
  const rebase = (r: Repo, base: string, sequence: string, editor: string | null, squash: boolean): Run => {
    const refused = busy(r);
    if (refused) return fail(refused);
    if (git(r.top, [...READ, 'rev-list', '--merges', '-n1', `${base}..HEAD`]).out.trim()) return fail('Merges follow this commit: rebase it by hand');
    const parent = git(r.top, [...READ, 'rev-parse', '--verify', '-q', `${base}^`]).ok;
    const run = git(r.top, [
      '-c', 'rebase.abbreviateCommands=false', '-c', `sequence.editor=${sequence}`, ...(editor ? ['-c', `core.editor=${editor}`] : []),
      'rebase', '-i', '--autostash', squash ? '--autosquash' : '--no-autosquash', ...(parent ? [`${base}^`] : ['--root']),
    ], WRITE_MS);
    if (!run.ok && operation(r) === 'rebase') git(r.top, ['rebase', '--abort']);
    return run;
  };
  const headSha = (r: Repo) => git(r.top, [...READ, 'rev-parse', 'HEAD']).out.trim();

  const actions = (r: Repo): Record<string, Action> => {
    if (!r.top) return {};
    const at = selected(r);
    const change = file(r);
    const branch = r.panel === 2 ? r.branches[at] : undefined;
    const commit = r.panel === 3 ? r.commits[at] : undefined;
    const stash = r.panel === 4 ? r.stash[at] : undefined;
    const back = () => {
      r.hunks = null;
      view(r);
      return null;
    };
    const move = (step: number) => () => {
      if (r.hunks) r.hunk = Math.max(0, Math.min(r.hunks.list.length - 1, r.hunk + step));
      else r.sel[r.panel] = Math.max(0, Math.min(rows(r).length - 1, at + step));
      view(r);
      return null;
    };
    const panel = (index: number) => () => {
      r.panel = (index + PANELS.length) % PANELS.length;
      r.hunks = null;
      list(r, r.panel);
      view(r);
      return null;
    };
    const common: Record<string, Action> = {
      j: ['Next item', move(1)],
      k: ['Previous item', move(-1)],
      J: ['Scroll the main view down', () => { r.scroll = Math.min(r.scroll + STEP, Math.max(0, r.main.split('\n').length - 1)); return null; }],
      K: ['Scroll the main view up', () => { r.scroll = Math.max(0, r.scroll - STEP); return null; }],
      P: ['Push', () => push(r)],
      p: ['Pull', () => (confirm('Pull', `Pull into ${r.head.branch || 'HEAD'}?`) ? remote(r, ['pull'], 'Pulled') : null)],
      '@': ['Add the selection to the prompt', () => {
        const hunk = r.hunks?.list[r.hunk];
        if (hunk) {
          const patch = patchOf(r, hunk);
          return patch ? attach(`\n\`\`\`diff\n${patch}\`\`\`\n`) : 'The file changed: look again';
        }
        if (change) return attach(mention(relative(r, change.path)));
        if (branch) return attach(`branch ${branch.name} `);
        if (commit) return attach(`commit ${commit.sha} (${commit.subject}) `);
        if (stash) return attach(`${stash.ref} (${stash.subject}) `);
        return 'Nothing selected';
      }],
    };
    const op = r.op;
    if (op) common.m = [`${DOING[op]}: continue or abort`, () => {
      const choice = choose(DOING[op], `A ${op} is in progress`, [{ value: 'continue', label: 'Continue' }, { value: 'abort', label: 'Abort' }]);
      if (choice !== 'continue' && choice !== 'abort') return null;
      return result(git(r.top, ['-c', 'core.editor=true', op, `--${choice}`], WRITE_MS), choice === 'continue' ? 'Continued' : 'Aborted');
    }];
    if (r.hunks) {
      const { path } = r.hunks;
      const hunk = r.hunks.list[r.hunk];
      return {
        ...common,
        Space: [hunk?.staged ? 'Unstage the hunk' : 'Stage the hunk', () => {
          if (!hunk) return null;
          const patch = patchOf(r, hunk);
          return patch ? apply(r.top, patch, hunk.staged ? ['--cached', '-R'] : ['--cached']) : 'The file changed: look again';
        }],
        d: ['Discard the hunk', () => {
          if (!hunk) return null;
          if (hunk.staged) return 'Unstage the hunk before discarding it';
          if (!confirm('Discard hunk', `Discard this change in ${path}? It cannot be undone.`)) return null;
          const patch = patchOf(r, hunk);
          return patch ? apply(r.top, patch, ['-R']) : 'The file changed: look again';
        }],
        Enter: ['Back to the files', back],
        h: ['Back to the files', back],
      };
    }
    const own: Record<string, Action> = {
      ...common,
      ...Object.fromEntries(PANELS.map((title, index) => [String(index + 1), [`${title} panel`, panel(index)]])),
      h: ['Previous panel', panel(r.panel - 1)],
      l: ['Next panel', panel(r.panel + 1)],
    };
    if (r.panel === 1) Object.assign(own, {
      Space: [change?.kind === 'u' ? 'Mark the file resolved' : change && staged(change) ? 'Unstage the file' : 'Stage the file', () => {
        if (!change) return null;
        if (change.kind === 'u') return confirm('Resolved', `Mark ${change.path} as resolved?`) ? result(git(r.top, ['add', '--', change.path]), 'Marked resolved') : null;
        if (staged(change)) return result(git(r.top, ['reset', '-q', '--', change.path]), 'Unstaged');
        return result(git(r.top, ['add', '--', change.path]), 'Staged');
      }],
      a: ['Stage or unstage everything', () => {
        if (!r.files.length) return 'Nothing to stage';
        const all = r.files.every(staged);
        return result(git(r.top, all ? ['reset', '-q'] : ['add', '-A']), all ? 'Unstaged everything' : 'Staged everything');
      }],
      d: ['Discard the file’s changes', () => {
        if (!change) return null;
        const untracked = change.kind === '?';
        if (!confirm('Discard', untracked ? `Delete untracked ${change.path}?` : `Discard every change to ${change.path}? It cannot be undone.`)) return null;
        if (untracked) return result(git(r.top, ['clean', '-f', '--', change.path]), 'Deleted');
        if (change.orig) return result(git(r.top, ['restore', '--staged', '--worktree', '--source=HEAD', '--', change.orig, change.path]), 'Discarded');
        if (change.x === 'A' || change.y === 'A') return result(git(r.top, ['rm', '-f', '--', change.path]), 'Deleted');
        return result(git(r.top, ['checkout', 'HEAD', '--', change.path]), 'Discarded');
      }],
      Enter: ['Stage hunks of the file', () => {
        if (!change) return null;
        if (change.kind === '?') return 'An untracked file has no hunks: Space stages it whole';
        r.hunk = 0;
        const { binary, notice } = loadHunks(r, change.path);
        if (r.hunks?.list.length) return notice;
        back();
        return binary ? 'A binary file has no text hunks: Space stages it whole' : 'This file has no text hunks';
      }],
      c: ['Commit the staged changes', () => {
        const message = ask('Commit', 'Message for the staged changes');
        return message ? result(git(r.top, ['commit', '-m', message], WRITE_MS), 'Committed') : null;
      }],
      A: ['Amend the last commit', () => (confirm('Amend', 'Add the staged changes to the last commit?') ? result(git(r.top, ['commit', '--amend', '--no-edit'], WRITE_MS), 'Amended') : null)],
      s: ['Stash every change', () => {
        const message = ask('Stash', 'Message for the stash (optional)');
        if (message === null) return null;
        return result(git(r.top, ['stash', 'push', '--include-untracked', ...(message ? ['-m', message] : []), '--', '.']), 'Stashed');
      }],
      e: ['Open in the editor', () => {
        if (!change) return null;
        const root = `${api.session().root}/`;
        const full = `${r.top}/${change.path}`;
        const open = api.host.tryCall('terminal.open', { path: full.startsWith(root) ? full.slice(root.length) : full, editor: true });
        return open.ok ? null : open.error;
      }],
    });
    if (r.panel === 2) Object.assign(own, {
      Space: ['Check out the branch', () => (branch ? result(git(r.top, ['switch', branch.name], 30_000), `On ${branch.name}`) : null)],
      n: ['New branch from this one', () => {
        const name = ask('New branch', `Name of the branch to create from ${branch?.name ?? 'HEAD'}`);
        return name ? result(git(r.top, ['switch', '-c', name, ...(branch ? [branch.name] : [])], 30_000), `On ${name}`) : null;
      }],
      d: ['Delete the branch', () => {
        if (!branch || !confirm('Delete branch', `Delete ${branch.name}?`)) return null;
        const run = git(r.top, ['branch', '-d', branch.name]);
        if (run.ok || !/not fully merged/.test(run.err)) return result(run, 'Deleted');
        return confirm('Force delete', `${branch.name} is not fully merged. Delete it anyway?`) ? result(git(r.top, ['branch', '-D', branch.name]), 'Deleted') : null;
      }],
    });
    if (r.panel === 3) Object.assign(own, {
      A: ['Amend this commit with the staged changes', () => {
        if (!commit || !confirm('Amend', `Add the staged changes to ${commit.sha} ${commit.subject}?`)) return null;
        if (at === 0) return result(git(r.top, ['commit', '--amend', '--no-edit'], WRITE_MS), 'Amended');
        const refused = busy(r);
        if (refused) return refused;
        const fixup = git(r.top, ['commit', `--fixup=${commit.sha}`]);
        if (!fixup.ok) return fixup.err;
        const made = headSha(r);
        const run = rebase(r, commit.sha, 'true', null, true);
        if (!run.ok && headSha(r) === made) git(r.top, ['reset', '-q', '--soft', 'HEAD~1']);
        return result(run, 'Amended');
      }],
      r: ['Reword this commit', () => {
        if (!commit) return null;
        const message = ask('Reword', `New message for ${commit.sha} ${commit.subject}`);
        if (!message) return null;
        if (at === 0) return result(git(r.top, ['commit', '--amend', '--only', '-m', message], WRITE_MS), 'Reworded');
        const editor = `sh -c 'printf "%s\\n" "$0" > "$1"' ${quote(message)}`;
        const sequence = `sh -c 'sed "1s/^pick /reword /" "$1" > "$1.omd" && mv "$1.omd" "$1"' sh`;
        return result(rebase(r, commit.sha, sequence, editor, false), 'Reworded');
      }],
    });
    if (r.panel === 4) Object.assign(own, {
      Space: ['Apply the stash', () => (stash ? result(git(r.top, ['stash', 'apply', stash.ref]), 'Applied') : null)],
      g: ['Pop the stash', () => (stash ? result(git(r.top, ['stash', 'pop', stash.ref]), 'Popped') : null)],
      d: ['Drop the stash', () => (stash && confirm('Drop stash', `Drop ${stash.ref} ${stash.subject}? It cannot be undone.`) ? result(git(r.top, ['stash', 'drop', stash.ref]), 'Dropped') : null)],
    });
    return own;
  };

  const contexts = (r: Repo | undefined): KeyContext[] => {
    const bind = (key: string, label: string) => ({ action: { command: 'git', args: `key ${key}` }, label: cut(label, 64) });
    const keys: KeyContext['keys'] = { R: bind('R', 'Refresh') };
    for (const [key, [label]] of Object.entries(r ? actions(r) : {})) keys[key] = bind(key, label);
    if (r?.signin) keys.i = { action: { focus: SIGNIN }, label: 'Type in the sign-in terminal' };
    return [{ when: { focus: SITE }, keys }];
  };

  api.on('terminal', ({ ledger, client }): TerminalPatch | null => {
    const state = load();
    if (!state.placed) return null;
    const r = state.repo && (!ledger || state.repo.dir === ledger.cwd) ? state.repo : undefined;
    return { sites: { [SITE]: { components: draw(r, area(client), Date.now()) } }, key_contexts: contexts(r) };
  });

  const place = () => {
    try {
      api.services.call('omd.workspace', 'register', { id: 'git', title: 'Git', site: SITE, order: 10 });
      const shown = api.services.call('omd.workspace', 'panels', null) as { panels?: { id: string }[] };
      return Boolean(shown.panels?.some(panel => panel.id === 'git'));
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      return false;
    }
  };
  const start = () => {
    api.host.tryCall('workspace.watch', { paths: ['.'], key: 'omd_git', debounce_ms: 300, git: true });
    changed(state => {
      state.placed = place();
      if (state.placed) repo(state, cwd(), true);
    });
  };
  const reload = () => changed(state => {
    if (!state.placed) state.placed = place();
    if (state.placed) repo(state, cwd(), true);
  });
  api.on('start', start);
  api.on('resume', start);
  api.on('mods_changed', start);
  api.on('turn_end', reload);
  api.on('thread_settings', ({ cwd: dir }) => {
    if (dir.before !== dir.after) reload();
  });
  api.on('workspace_change', ({ source }) => changed(state => {
    if (!state.placed) return;
    const echo = source === 'external' ? state.repo?.echo : undefined;
    if (echo !== undefined && state.repo) {
      delete state.repo.echo;
      if (Date.now() - echo < ECHO_MS) return;
    }
    repo(state, cwd(), true);
  }));
  api.on('component_event', ({ kind, events }) => {
    if (kind !== 'input' || !events?.some(event => 'key' in event && event.key === 'Esc')) return;
    changed(state => {
      const r = state.repo;
      if (!r?.hunks) return;
      r.hunks = null;
      view(r);
    });
  });

  api.command('git', (args): CommandResult => {
    const [op = '', key = ''] = String(args ?? '').trim().split(/\s+/);
    wrote = false;
    const display = changed(state => {
      if (op === 'refresh' || (op === 'key' && key === 'R')) {
        if (state.repo) state.repo.notice = null;
        repo(state, cwd(), true);
        return null;
      }
      const r = repo(state, cwd(), false);
      if (!r.top) return r.error;
      if (op !== 'key') return `Git panel: ${r.head.branch || 'HEAD (detached)'} in ${r.top}, ${r.files.length} changed. Open it from the workspace dock (/workspace); ? there lists its keys. Usage: /git refresh`;
      const action = actions(r)[key];
      if (!action) return null;
      const notice = action[1]();
      r.notice = notice && cut(summary(notice), NOTICE_BYTES);
      if (wrote) {
        refresh(r);
        r.echo = Date.now();
      }
      return null;
    });
    return display === null ? null : { display };
  }, { description: 'Git panel: status, or refresh', args_hint: 'refresh' });
}
