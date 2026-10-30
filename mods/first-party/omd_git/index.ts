import type { CommandResult, Json, KeyContext, ModAPI, TerminalComponent, TerminalPatch, TerminalSpan, TerminalTone } from '../../api.d.ts';

type Change = { path: string; x: string; y: string };
type Branch = { name: string; head: boolean; track: string };
type Commit = { sha: string; subject: string; author: string; at: number };
type Stash = { ref: string; subject: string };
type Hunk = { staged: boolean; header: string; line: number };
type Repo = {
  top: string; panel: number; sel: number[]; head: string; files: Change[]; branches: Branch[]; commits: Commit[]; stash: Stash[];
  hunks: { path: string; list: Hunk[] } | null; hunk: number; main: string; scroll: number; notice: string | null; error: string | null; signin?: string;
};
type State = { placed: boolean; repos: Record<string, Repo> };
type Run = { ok: boolean; out: string; err: string; truncated: boolean };

const PANELS = ['Status', 'Files', 'Local branches', 'Commits', 'Stash'];
const HINTS = [
  'Push: P | Pull: p | Refresh: R | Keybindings: ?',
  'Stage: Space | All: a | Hunks: Enter | Commit: c | Amend: A | Stash: s | Discard: d | Edit: e | Keybindings: ?',
  'Checkout: Space | New: n | Delete: d | Push: P | Pull: p | Keybindings: ?',
  'Reword: r | Amend: A | Add to prompt: @ | Keybindings: ?',
  'Apply: Space | Pop: g | Drop: d | Keybindings: ?',
];
const WIDE = 240;
const MAX_HEIGHT = 40;
const WINDOW = 80;
const TALL = 10;
const SHORT = 3;
const SITE = 'omd_git/main';
const LIST = 'omd_git_list';
const MAIN = 'omd_git_main';
const SIGNIN = 'omd_git_signin';
const AUTH = /could not read (username|password)|terminal prompts disabled|permission denied \(publickey|passphrase|authentication failed|host key verification failed/i;
const REPOS = 2;
const ROWS = 200;
const COMMITS = 100;
const MAIN_BYTES = 28_000;
const MAIN_LINES = 1_000;
const LINE_BYTES = 200;
const NOTICE_BYTES = 240;
const STEP = 10;
const BUDGET = 56_000;
const READ = ['--no-optional-locks'];
const DIFF = ['diff', '--no-ext-diff', '--no-textconv', '--src-prefix=a/', '--dst-prefix=b/'];
const encoder = new TextEncoder();

const size = (value: unknown) => encoder.encode(JSON.stringify(value)).length;
const cut = (text: string, bytes: number) => {
  const clean = text.replace(/\t/g, '    ').replace(/[\u0000-\u001f\u007f-\u009f]/g, '?');
  return encoder.encode(clean).length <= bytes ? clean : clean.slice(0, encoder.encodeInto(clean, new Uint8Array(bytes)).read);
};
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
const ago = (at: number) => {
  const seconds = Math.max(0, Math.floor(Date.now() / 1000 - at));
  const [count, unit] = ([[31_536_000, 'year'], [2_592_000, 'month'], [604_800, 'week'], [86_400, 'day'], [3_600, 'hour'], [60, 'minute'], [1, 'second']] as const)
    .map(([size, name]) => [Math.floor(seconds / size), name] as const).find(([value]) => value > 0) ?? [0, 'second'];
  return `${count} ${unit}${count === 1 ? '' : 's'} ago`;
};
const quote = (text: string) => "'" + text.replaceAll("'", "'\\''") + "'";
const tone = (line: string): TerminalTone | undefined => {
  if (/^(diff --git|index |--- |\+\+\+ |commit |stash@)/.test(line)) return 'muted';
  if (line.startsWith('@@')) return 'accent';
  if (line.startsWith('+')) return 'success';
  if (line.startsWith('-')) return 'failure';
  return undefined;
};

export default function activate(api: ModAPI) {
  const load = (): State => ({ placed: false, repos: {}, ...(api.state.get() as Partial<State> | null) });
  const changed = <T>(change: (state: State) => T): T => {
    const state = load();
    const before = JSON.stringify(state);
    const result = change(state);
    if (JSON.stringify(state) !== before) api.state.set(state as unknown as Json);
    return result;
  };
  const cwd = () => api.session().cwd;
  const thread = () => api.session().thread_id ?? '';

  const git = (top: string, argv: string[], timeout_ms = 10_000): Run => {
    const run = api.host.tryCall('exec.run', { program: 'git', argv: ['--no-pager', '--literal-pathspecs', '-C', top, '-c', 'color.ui=false', ...argv], sandbox: 'none', timeout_ms });
    if (!run.ok) return { ok: false, out: '', err: run.error, truncated: false };
    return { ok: run.value.exit_code === 0, out: run.value.stdout, err: (run.value.stderr || run.value.stdout).trim(), truncated: Boolean(run.value.stdout_preview_truncated) };
  };
  const apply = (top: string, patch: string, argv: string[]) => {
    const run = api.host.tryCall('exec.run', { program: 'git', argv: ['--literal-pathspecs', '-C', top, 'apply', ...argv, '-'], stdin: patch, sandbox: 'none', timeout_ms: 10_000 });
    return !run.ok ? run.error : run.value.exit_code === 0 ? null : run.value.stderr.trim() || 'git apply failed';
  };

  const repo = (state: State, dir: string): Repo | null => {
    const known = state.repos[dir];
    if (known) {
      delete state.repos[dir];
      state.repos[dir] = known;
      return known;
    }
    const top = api.host.tryCall('exec.run', { program: 'git', argv: ['rev-parse', '--show-toplevel'], sandbox: 'none', cwd: dir, timeout_ms: 5_000 });
    if (!top.ok || top.value.exit_code !== 0) return null;
    state.repos[dir] = {
      top: top.value.stdout.trim(), panel: 1, sel: [0, 0, 0, 0, 0], head: '', files: [], branches: [], commits: [], stash: [],
      hunks: null, hunk: 0, main: '', scroll: 0, notice: null, error: null,
    };
    for (const old of Object.keys(state.repos).slice(0, -REPOS)) delete state.repos[old];
    return state.repos[dir];
  };

  const status = (r: Repo) => {
    const run = git(r.top, [...READ, 'status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all']);
    if (!run.ok) {
      r.error = cut(run.err.split('\n')[0] || 'git status failed', NOTICE_BYTES);
      return;
    }
    const kept = r.files[Math.min(r.sel[1], r.files.length - 1)]?.path;
    const records = run.out.split('\0');
    const field = (key: string) => records.find(record => record.startsWith(`# branch.${key} `))?.slice(key.length + 10) ?? '';
    const [ahead = '0', behind = '0'] = field('ab').split(' ').filter(Boolean).map(part => part.replace(/^[+-]/, ''));
    const upstream = field('upstream');
    r.head = `${field('head')}${upstream ? ` → ${upstream}${field('ab') ? ahead !== '0' || behind !== '0' ? ` ↑${ahead} ↓${behind}` : '' : ' (gone)'}` : ''}`;
    r.files = [];
    for (let index = 0; index < records.length; index++) {
      const record = records[index];
      const kind = record[0];
      if (kind === '?') r.files.push({ path: record.slice(2), x: '?', y: '?' });
      else if (kind === '1' || kind === '2' || kind === 'u') {
        const at = { '1': 8, '2': 9, u: 10 }[kind];
        r.files.push({ path: record.split(' ').slice(at).join(' '), x: record[2].replace('.', ' '), y: record[3].replace('.', ' ') });
        if (kind === '2') index++;
      }
    }
    r.files = r.files.slice(0, ROWS);
    const found = r.files.findIndex(change => change.path === kept);
    if (found >= 0) r.sel[1] = found;
    r.error = null;
  };
  const list = (r: Repo, panel: number) => {
    if (panel === 2) {
      const run = git(r.top, [...READ, 'for-each-ref', '--sort=-committerdate', `--count=${ROWS}`, '--format=%(HEAD)%00%(refname:short)%00%(upstream:short) %(upstream:track)', 'refs/heads']);
      r.branches = run.out.split('\n').filter(Boolean).map(line => {
        const [head, name, track] = line.split('\0');
        return { name, head: head === '*', track: track.trim() };
      });
    } else if (panel === 3) {
      const run = git(r.top, [...READ, 'log', `-n${COMMITS}`, '--format=%h%x00%s%x00%an%x00%at']);
      r.commits = run.out.split('\n').filter(Boolean).map(line => {
        const [sha, subject, author, at] = line.split('\0');
        return { sha, subject, author, at: Number(at) };
      });
    } else if (panel === 4) {
      const run = git(r.top, [...READ, 'stash', 'list', '--format=%gd%x00%s']);
      r.stash = run.out.split('\n').filter(Boolean).map(line => {
        const [ref, subject] = line.split('\0');
        return { ref, subject };
      });
    }
  };
  const rows = (r: Repo): unknown[] => [[r.head], r.files, r.branches, r.commits, r.stash][r.panel];
  const selected = (r: Repo) => Math.min(r.sel[r.panel], Math.max(0, rows(r).length - 1));
  const file = (r: Repo) => (r.panel === 1 ? r.files[selected(r)] : undefined);
  const relative = (r: Repo, path: string) => {
    const prefix = `${cwd()}/`.slice(r.top.length + 1);
    return `${cwd()}/`.startsWith(`${r.top}/`) && path.startsWith(prefix) ? path.slice(prefix.length) : `${r.top}/${path}`;
  };

  const patches = (r: Repo, path: string, staged: boolean) => {
    const run = git(r.top, [...READ, ...DIFF, ...(staged ? ['--cached'] : []), '--', path]);
    const [head, ...parts] = run.out.split(/^(?=@@ )/m);
    if (run.truncated) parts.pop();
    return { head, parts: parts.map(part => (part.endsWith('\n') ? part : `${part}\n`)), truncated: run.truncated };
  };
  const loadHunks = (r: Repo, path: string) => {
    const sides = [patches(r, path, false), patches(r, path, true)];
    const list: Hunk[] = [];
    const text: string[] = [];
    let line = 0;
    sides.forEach((side, staged) => side.parts.forEach(part => {
      list.push({ staged: Boolean(staged), header: part.split('\n')[0], line });
      text.push(part);
      line += part.split('\n').length - 1;
    }));
    r.hunks = { path, list };
    r.hunk = Math.min(r.hunk, Math.max(0, list.length - 1));
    r.main = list.length ? clip(text.join('')) : 'No hunks left in this file';
    if (sides.some(side => side.truncated)) r.notice = 'The diff is too large: the last hunks are left out';
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
    let text = '';
    if (r.panel === 0) text = git(r.top, [...READ, 'log', '--graph', '--oneline', '--decorate', '-n60']).out;
    else if (r.panel === 1) {
      const change = r.files[at];
      if (change?.x === '?') text = git(r.top, [...READ, ...DIFF, '--no-index', '--', '/dev/null', change.path]).out;
      else if (change) {
        const diff = (base: string[]) => git(r.top, [...READ, ...DIFF, ...base, '--', change.path]);
        const head = diff(['HEAD']);
        text = head.ok ? head.out : diff(['--cached']).out;
      }
    } else if (r.panel === 2 && r.branches[at]) text = git(r.top, [...READ, 'log', '--graph', '--oneline', '--decorate', '-n60', r.branches[at].name, '--']).out;
    else if (r.panel === 3 && r.commits[at]) text = git(r.top, [...READ, 'show', '--stat', '--patch', '--format=fuller', r.commits[at].sha]).out;
    else if (r.panel === 4 && r.stash[at]) text = git(r.top, [...READ, 'stash', 'show', '--stat', '--patch', r.stash[at].ref]).out;
    r.main = clip(text || (r.panel === 1 ? 'Working tree clean' : ''));
  };
  const refresh = (r: Repo) => {
    if (r.signin !== undefined && r.signin === thread()) {
      const read = api.host.tryCall('terminal.pty', { action: 'read', session: 'signin' });
      const done = read.ok && 'running' in read.value && !read.value.running ? read.value : null;
      if (done || (!read.ok && /^pty_(session_unknown|context_changed)/.test(read.error))) {
        delete r.signin;
        api.host.tryCall('terminal.pty', { action: 'stop', session: 'signin' });
        const last = done?.text.split('\n').map(part => part.trim()).filter(Boolean).at(-1);
        r.notice = !done ? null : done.exit_code === 0 ? 'git finished' : cut(`git exited with ${done.exit_code}${last ? `: ${last}` : ''}`, NOTICE_BYTES);
      }
    }
    status(r);
    for (const panel of [2, 3, 4]) list(r, panel);
    if (r.hunks) loadHunks(r, r.hunks.path);
    if (r.hunks && !r.hunks.list.length) r.hunks = null;
    view(r);
  };

  const confirm = (title: string, message: string) => {
    const answer = api.host.tryCall('terminal.prompt', { kind: 'confirm', title, message });
    return answer.ok && answer.value.status === 'accepted';
  };
  const ask = (title: string, message: string): string | null => {
    const answer = api.host.tryCall('terminal.prompt', { kind: 'text', title, message });
    return answer.ok && answer.value.status === 'accepted' ? answer.value.value?.trim() ?? '' : null;
  };
  const attach = (text: string) => {
    const draft = api.host.tryCall('composer.read', null);
    if (!draft.ok) return draft.error;
    const write = api.host.tryCall('composer.write', { revision: draft.value.revision, edit: { kind: 'insert', text } });
    return write.ok ? 'Added to the prompt' : write.error;
  };
  const result = (run: Run, done: string) => (run.ok ? done : run.err || 'git failed');
  const remote = (r: Repo, argv: string[], done: string) => {
    const run = git(r.top, argv, 120_000);
    if (run.ok || !AUTH.test(run.err)) return result(run, done);
    if (!confirm('Sign in', `git ${argv[0]} needs a password, passphrase or host key answer. Run it in a terminal here?`)) return run.err;
    api.host.tryCall('terminal.pty', { action: 'stop', session: 'signin' });
    const pty = api.host.tryCall('terminal.pty', { action: 'start', session: 'signin', program: 'git', argv: ['-C', r.top, ...argv], sandbox: 'none' });
    if (!pty.ok) return pty.error;
    if (!('running' in pty.value)) return 'Terminal start declined';
    r.signin = thread();
    return 'Answer git in the terminal below: i types in it, Ctrl+] leaves it, R refreshes once git exits';
  };
  const rebase = (r: Repo, base: string, sequence: string, editor?: string): Run => {
    if (git(r.top, [...READ, 'rev-list', '--merges', '-n1', `${base}..HEAD`]).out.trim()) {
      return { ok: false, out: '', err: 'Merges follow this commit: rebase it by hand', truncated: false };
    }
    const parent = git(r.top, [...READ, 'rev-parse', '--verify', '-q', `${base}^`]).ok;
    const run = git(r.top, [
      '-c', `sequence.editor=${sequence}`, ...(editor ? ['-c', `core.editor=${editor}`] : []), 'rebase', '-i', '--autostash', '--autosquash', ...(parent ? [`${base}^`] : ['--root']),
    ], 60_000);
    if (!run.ok) git(r.top, ['rebase', '--abort']);
    return run;
  };

  const actions = (r: Repo): Record<string, [string, () => string | null]> => {
    const at = selected(r);
    const change = file(r);
    const branch = r.panel === 2 ? r.branches[at] : undefined;
    const commit = r.panel === 3 ? r.commits[at] : undefined;
    const stash = r.panel === 4 ? r.stash[at] : undefined;
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
    const common: Record<string, [string, () => string | null]> = {
      j: ['Next item', move(1)],
      k: ['Previous item', move(-1)],
      J: ['Scroll the main view down', () => { r.scroll = Math.min(r.scroll + STEP, Math.max(0, r.main.split('\n').length - 1)); return null; }],
      K: ['Scroll the main view up', () => { r.scroll = Math.max(0, r.scroll - STEP); return null; }],
      R: ['Refresh', () => { r.notice = null; refresh(r); return r.notice; }],
      P: ['Push', () => {
        const upstream = r.head.includes(' → ');
        const name = r.head.split(' ')[0];
        if (!confirm('Push', upstream ? `Push ${name} to its upstream?` : `Push ${name} to origin and track it?`)) return null;
        return remote(r, upstream ? ['push'] : ['push', '-u', 'origin', name], 'Pushed');
      }],
      p: ['Pull', () => (confirm('Pull', `Pull into ${r.head.split(' ')[0]}?`) ? remote(r, ['pull'], 'Pulled') : null)],
      '@': ['Add the selection to the prompt', () => {
        const hunk = r.hunks?.list[r.hunk];
        const patch = hunk && patchOf(r, hunk);
        if (hunk) return patch ? attach(`\n\`\`\`diff\n${patch}\`\`\`\n`) : 'The file changed: look again';
        if (change) return attach(`@${relative(r, change.path)} `);
        if (branch) return attach(`branch ${branch.name} `);
        if (commit) return attach(`commit ${commit.sha} (${commit.subject}) `);
        if (stash) return attach(`${stash.ref} (${stash.subject}) `);
        return 'Nothing selected';
      }],
    };
    if (r.hunks) {
      const { path } = r.hunks;
      const hunk = r.hunks.list[r.hunk];
      return {
        ...common,
        Space: [hunk?.staged ? 'Unstage the hunk' : 'Stage the hunk', () => {
          const patch = hunk && patchOf(r, hunk);
          return hunk ? patch ? apply(r.top, patch, hunk.staged ? ['--cached', '-R'] : ['--cached']) : 'The file changed: look again' : null;
        }],
        d: ['Discard the hunk', () => {
          if (!hunk || hunk.staged) return hunk ? 'Unstage the hunk before discarding it' : null;
          if (!confirm('Discard hunk', `Discard this change in ${path}? It cannot be undone.`)) return null;
          const patch = patchOf(r, hunk);
          return patch ? apply(r.top, patch, ['-R']) : 'The file changed: look again';
        }],
        Enter: ['Back to the files', () => { r.hunks = null; view(r); return null; }],
        h: ['Back to the files', () => { r.hunks = null; view(r); return null; }],
      };
    }
    const panels = Object.fromEntries(PANELS.map((title, index) => [String(index + 1), [`${title} panel`, panel(index)]]));
    const own: Record<string, [string, () => string | null]> = {
      ...common, ...panels,
      h: ['Previous panel', panel(r.panel - 1)],
      l: ['Next panel', panel(r.panel + 1)],
    };
    if (r.panel === 1) Object.assign(own, {
      Space: [change && change.x !== ' ' && change.x !== '?' && change.y === ' ' ? 'Unstage the file' : 'Stage the file', () => {
        if (!change) return null;
        const staged = change.x !== ' ' && change.x !== '?' && change.y === ' ';
        return result(git(r.top, staged ? ['reset', '-q', '--', change.path] : ['add', '--', change.path]), staged ? 'Unstaged' : 'Staged');
      }],
      a: ['Stage or unstage everything', () => {
        const all = r.files.every(item => item.x !== ' ' && item.x !== '?' && item.y === ' ');
        return result(git(r.top, all ? ['reset', '-q'] : ['add', '-A']), all ? 'Unstaged everything' : 'Staged everything');
      }],
      d: ['Discard the file’s changes', () => {
        if (!change || !confirm('Discard', `Discard every change to ${change.path}? It cannot be undone.`)) return null;
        if (change.x === '?') return result(git(r.top, ['clean', '-f', '--', change.path]), 'Deleted');
        if (change.x === 'A' || change.y === 'A') return result(git(r.top, ['rm', '-f', '--', change.path]), 'Deleted');
        return result(git(r.top, ['checkout', 'HEAD', '--', change.path]), 'Discarded');
      }],
      Enter: ['Stage hunks of the file', () => {
        if (!change) return null;
        if (change.x === '?') return 'An untracked file has no hunks: Space stages it whole';
        r.hunk = 0;
        loadHunks(r, change.path);
        view(r);
        return r.notice;
      }],
      c: ['Commit the staged changes', () => {
        const message = ask('Commit', 'Message for the staged changes');
        return message ? result(git(r.top, ['commit', '-m', message], 60_000), 'Committed') : null;
      }],
      A: ['Amend the last commit', () => (confirm('Amend', 'Add the staged changes to the last commit?') ? result(git(r.top, ['commit', '--amend', '--no-edit'], 60_000), 'Amended') : null)],
      s: ['Stash every change', () => {
        const message = ask('Stash', 'Message for the stash');
        return message ? result(git(r.top, ['stash', 'push', '--include-untracked', '-m', message, '--', '.']), 'Stashed') : null;
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
        if (at === 0) return result(git(r.top, ['commit', '--amend', '--no-edit'], 60_000), 'Amended');
        const fixup = git(r.top, ['commit', `--fixup=${commit.sha}`]);
        if (!fixup.ok) return fixup.err;
        const run = rebase(r, commit.sha, 'true');
        if (!run.ok) git(r.top, ['reset', '-q', '--soft', 'HEAD~1']);
        return result(run, 'Amended');
      }],
      r: ['Reword this commit', () => {
        if (!commit) return null;
        const message = ask('Reword', `New message for ${commit.sha} ${commit.subject}`);
        if (!message) return null;
        if (at === 0) return result(git(r.top, ['commit', '--amend', '--only', '-m', message], 60_000), 'Reworded');
        const editor = `sh -c 'printf "%s\\n" "$0" > "$1"' ${quote(message)}`;
        return result(rebase(r, commit.sha, `sh -c 'sed "1s/^pick /reword /" "$1" > "$1.omd" && mv "$1.omd" "$1"' sh`, editor), 'Reworded');
      }],
    });
    if (r.panel === 4) Object.assign(own, {
      Space: ['Apply the stash', () => (stash ? result(git(r.top, ['stash', 'apply', stash.ref]), 'Applied') : null)],
      g: ['Pop the stash', () => (stash ? result(git(r.top, ['stash', 'pop', stash.ref]), 'Popped') : null)],
      d: ['Drop the stash', () => (stash && confirm('Drop stash', `Drop ${stash.ref} ${stash.subject}? It cannot be undone.`) ? result(git(r.top, ['stash', 'drop', stash.ref]), 'Dropped') : null)],
    });
    return own;
  };
  const WRITES = new Set(['Space', 'a', 'd', 'c', 'A', 's', 'n', 'r', 'g', 'P', 'p']);

  const line = (text: string, spans: TerminalSpan[]): TerminalComponent => ({ type: 'line', id: `omd_git_${text}`, label: text, spans });
  const span = (text: string, extra: Partial<TerminalSpan> = {}): TerminalSpan => ({ text: cut(text, LINE_BYTES), ...extra });
  const listLines = (r: Repo, panel: number): TerminalSpan[][] => {
    const active = panel === r.panel;
    const mark = (index: number) => span(active && index === (r.hunks ? r.hunk : selected(r)) ? '▶ ' : '  ', { tone: 'accent' });
    if (panel === 1 && r.hunks) return r.hunks.list.map((h, index) => [mark(index), span(h.staged ? 'staged   ' : 'unstaged ', { tone: h.staged ? 'success' : 'attention' }), span(h.header)]);
    if (panel === 0) return [[span(`${r.top.split('/').at(-1)} → `, { tone: 'muted' }), span(r.head || '(no branch)', { bold: true })]];
    if (panel === 1) return r.files.map((f, index) => [mark(index), span(f.x, { tone: f.x === '?' ? 'failure' : 'success' }), span(f.y, { tone: 'failure' }), span(` ${f.path}`)]);
    if (panel === 2) return r.branches.map((b, index) => [mark(index), span(b.head ? '* ' : '  ', { tone: 'success' }), span(b.name, { bold: b.head }), span(b.track ? ` ${b.track}` : '', { tone: 'muted' })]);
    if (panel === 3) return r.commits.map((c, index) => [mark(index), span(`${c.sha} `, { tone: 'attention' }), span(c.subject), span(`  ${c.author}, ${ago(c.at)}`, { tone: 'muted' })]);
    return r.stash.map((s, index) => [mark(index), span(`${s.ref} `, { tone: 'attention' }), span(s.subject)]);
  };
  const frame = (id: string, title: string, active: boolean, children: TerminalComponent[], flex?: number): TerminalComponent => ({
    type: 'box', id: `omd_git_${id}_box`, label: cut(title, 120), title: cut(title, 120), style: { border: active ? 'thick' : 'rounded' }, children, ...(flex ? { flex } : {}),
  });
  const side = (r: Repo, panel: number, wide: boolean, tall: number): [TerminalComponent, number] => {
    const active = panel === r.panel;
    const lines = listLines(r, panel);
    const empty = [[span(['', 'No changes', 'No branches', 'No commits', 'No stashes'][panel], { tone: 'muted' })]];
    const title = `[${panel + 1}] ${panel === 1 && r.hunks ? `Hunks of ${r.hunks.path}` : PANELS[panel]}`;
    if (!active) {
      const rows = panel === 0 ? 1 : wide ? SHORT : 1;
      const at = Math.max(0, Math.min(r.sel[panel], lines.length - 1));
      const from = Math.max(0, Math.min(at - 1, lines.length - rows));
      const shown = lines.slice(from, from + rows);
      return [frame(`side${panel}`, title, false, [{ type: 'document', id: `omd_git_side${panel}`, label: PANELS[panel], lines: shown.length ? shown : empty, keys: true, height: Math.max(1, shown.length) }]), Math.max(1, shown.length) + 2];
    }
    const at = r.hunks ? r.hunk : selected(r);
    const height = panel === 0 ? 1 : Math.max(SHORT, Math.min(lines.length, tall, MAX_HEIGHT));
    const from = Math.max(0, Math.min(at - WINDOW / 2, lines.length - WINDOW));
    const shown = lines.slice(from, from + WINDOW);
    return [frame(`side${panel}`, title, true, [{ type: 'document', id: LIST, label: PANELS[panel], lines: shown.length ? shown : empty, keys: true, height, selected: { start: at - from, end: at - from } }]), height + 2];
  };
  const site = (r: Repo | undefined, thread: string, columns: number, height: number): TerminalComponent[] => {
    if (!r) return [line('missing', [span('Not a Git repository', { tone: 'muted' })])];
    const wide = columns >= WIDE;
    const others = PANELS.reduce((total, _, panel) => total + (panel === r.panel ? 0 : panel === 0 || !wide ? 3 : SHORT + 2), 0);
    const sides = PANELS.map((_, panel) => side(r, panel, wide, Math.max(SHORT, wide ? height - 1 - others - 2 : Math.min(TALL, height - 1 - others - 2 - (SHORT + 2)))));
    const used = sides.reduce((total, [, rows]) => total + rows, 0);
    const rows = Math.min(MAX_HEIGHT, Math.max(SHORT, wide ? used - 2 : height - 1 - used - 2));
    const all = r.main.split('\n');
    let room = BUDGET - size(sides.map(([component]) => component));
    const main: TerminalSpan[][] = [];
    for (const text of all.slice(Math.min(r.scroll, Math.max(0, all.length - 1)))) {
      const row = [span(text || ' ', tone(text) ? { tone: tone(text) } : {})];
      room -= size(row) + 1;
      if (room < 0) break;
      main.push(row);
    }
    const signin = r.signin === thread;
    const title = signin ? 'Sign in' : r.hunks ? 'Patch' : ['Log', r.files[selected(r)]?.x === '?' ? 'Untracked file' : 'Diff', 'Log', 'Patch', 'Stash'][r.panel];
    const body: TerminalComponent = signin
      ? { type: 'terminal', id: SIGNIN, label: 'Sign in', session: 'signin', height: 10 }
      : { type: 'document', id: MAIN, label: 'Main view', lines: [...main, ...Array.from({ length: Math.max(0, rows - main.length) }, () => [span(' ')])], keys: true, height: rows };
    const panels = sides.map(([component]) => component);
    const hint = r.hunks ? 'Stage hunk: Space | Discard hunk: d | Back: Enter | Add to prompt: @ | Keybindings: ?' : HINTS[r.panel];
    return [
      wide
        ? { type: 'box', id: 'omd_git_layout', label: 'Git', style: { direction: 'row' }, children: [{ type: 'box', id: 'omd_git_sides', label: 'Panels', flex: 2, children: panels }, frame('main', title, false, [body], 3)] }
        : { type: 'box', id: 'omd_git_layout', label: 'Git', children: [...panels, frame('main', title, false, [body])] },
      r.error || r.notice ? line('notice', [span(r.error ?? r.notice ?? '', { tone: r.error ? 'failure' : 'attention' })]) : line('hints', [span(hint, { tone: 'muted' })]),
    ];
  };
  const contexts = (r: Repo | undefined, thread: string): KeyContext[] => {
    if (!r) return [];
    const keys: KeyContext['keys'] = {};
    for (const [key, [label]] of Object.entries(actions(r))) keys[key] = { action: { command: 'git', args: `key ${key}` }, label: cut(label, 64) };
    if (r.signin === thread) keys.i = { action: { focus: SIGNIN }, label: 'Type in the sign-in terminal' };
    return [{ when: { focus: SITE }, keys }];
  };

  api.on('terminal', ({ ledger, client }): TerminalPatch | null => {
    const state = load();
    if (!state.placed) return null;
    const r = state.repos[ledger?.cwd ?? ''] ?? (ledger ? undefined : Object.values(state.repos).at(-1));
    const thread = ledger?.thread_id ?? '';
    return { sites: { [SITE]: { components: site(r, thread, client?.columns ?? 160, (client?.columns ?? 160) >= 100 ? Math.max(24, (client?.rows ?? 46) - 3) : Math.max(16, Math.floor((client?.rows ?? 40) * 0.4))) } }, key_contexts: contexts(r, thread) };
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
      const r = repo(state, cwd());
      if (r) refresh(r);
    });
  };
  api.on('start', start);
  api.on('mods_changed', start);
  const reload = () => changed(state => {
    const r = state.repos[cwd()];
    if (r) refresh(r);
  });
  api.on('workspace_change', reload);
  api.on('turn_end', reload);

  api.command('git', (args): CommandResult => {
    const [op = '', key = ''] = String(args ?? '').trim().split(/\s+/);
    const display = changed(state => {
      const r = repo(state, cwd());
      if (!r) return 'Not a Git repository';
      if (op === 'refresh') {
        refresh(r);
        return null;
      }
      if (op !== 'key') return `Git panel: ${r.head} in ${r.top}, ${r.files.length} changed. Open it from the workspace dock (/workspace); ? there lists its keys. Usage: /git refresh`;
      const action = actions(r)[key];
      if (!action) return null;
      const notice = action[1]();
      r.notice = notice && cut(notice.split('\n').map(part => part.trim()).filter(Boolean).join(' '), NOTICE_BYTES);
      if (WRITES.has(key)) refresh(r);
      return null;
    });
    return display === null ? null : { display };
  }, { description: 'Git panel: status, or refresh', args_hint: 'refresh' });
}
