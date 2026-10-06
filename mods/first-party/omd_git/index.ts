import type { ExecGuard, Fingerprint, Json, ModAPI, ResourceRef, TerminalComponent, TerminalPatch, TerminalRenderSite, TerminalTone } from '../../api.d.ts';

type Entry = { path: string; original: string | null; index: string; worktree: string; conflicted: boolean };
type Commit = { oid: string; parents: string[]; subject: string };
type Head = { branch: string | null; oid: string | null; upstream: string | null; ahead: number; behind: number };
type Preview = { kind: 'discard' | 'commit' | 'switch'; tracked: boolean; target: string; from: string | null; destination: string | null; restoreHash?: string; status: string; lines: string[]; guards: ExecGuard[]; paths: string[]; expected: Record<string, Fingerprint> | null };
type Checks = { total: number; pass: number; fail: number; pending: number; req: number[]; failing: string[] };
type Run = { id: number; name: string; attempt: number; state: string; verified: boolean };
type Pr = { title: string; state: string; draft: boolean; merge: string; review: string; updated: string; head: string; ref: string; base: string };
type Page = { cursor: string | null; head: string; loaded: number; checks: Checks; runs: Record<string, string[]> };
type Watch = { key: string; added: number; owner: string; repo: string; number: number; branch: string | null; pr: Pr | null; checks: Checks | null; runs: Run[]; more: number; page: Page | null; incomplete: string | null; error: string | null; fail: number; next: number; at: number | null; final: boolean };
type Github = { watches: Watch[]; until: number; token: string | null; view: string | null };
type Saved = { error: string | null; head: Head | null; entries: Entry[]; total: number; rows: string[]; more: boolean; branches: string[]; selected: string | null; branch: string | null; message: string; preview: Preview | null; notice: string | null; status: string; guards: ExecGuard[]; backup: { path: string; reference: ResourceRef; expected: Fingerprint } | null; github: Github };
type Result<T> = { ok: true; value: T } | { ok: false; error: string };

const EMPTY: Saved = { error: 'Git status not loaded', head: null, entries: [], total: 0, rows: [], more: false, branches: [], selected: null, branch: null, message: '', preview: null, notice: null, status: '', guards: [], backup: null, github: { watches: [], until: 0, token: null, view: null } };
const GH = 'https://api.github.com';
const WATCH_LIMIT = 5;
const RUN_LIMIT = 20;
const BYTE_BUDGET = 58_000;
const PR_QUERY = 'query($o:String!,$r:String!,$n:Int!,$c:String){repository(owner:$o,name:$r){pullRequest(number:$n){title state isDraft mergeStateStatus reviewDecision updatedAt headRefName headRefOid baseRefName commits(last:1){nodes{commit{oid statusCheckRollup{contexts(first:50,after:$c){totalCount pageInfo{hasNextPage endCursor}nodes{__typename ...on CheckRun{databaseId name status conclusion isRequired(pullRequestNumber:$n) checkSuite{workflowRun{databaseId workflow{name}}}}...on StatusContext{context state isRequired(pullRequestNumber:$n)}}}}}}}}}}';
const BRANCH_QUERY = 'query($o:String!,$r:String!,$b:String!){repository(owner:$o,name:$r){nameWithOwner pullRequests(headRefName:$b,states:OPEN,first:5){nodes{number headRepository{nameWithOwner}}}parent{nameWithOwner pullRequests(headRefName:$b,states:OPEN,first:5){nodes{number headRepository{nameWithOwner}}}}}}';
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
  type Read = { text: string; program: string; guard: ExecGuard };
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
    return { ok: true, value: { text: output.stdout, program: output.program.path, guard: { program: 'git', sha256: output.program.sha256, argv: gitArgs(argv), env: { GIT_OPTIONAL_LOCKS: '0' }, stdout_sha256: output.stdout_sha256 } } };
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
      const next = { ...EMPTY, error: result.error, message: previous.message, backup: previous.backup, github: previous.github };
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
  const button = (id: string, label: string, text: string, command: string, args?: string): TerminalComponent => ({ type: 'button', id, label: trim(label, 128), text: trim(text, 200), action: { command: `omd_git:${command}`, ...(args ? { args } : {}) } });
  const sidebar = (state: Saved): TerminalComponent[] => {
    if (state.error) return [line('omd_git_error', 'Git status', trim(state.error.replace(/_/g, ' ')), 'failure'), ...(state.backup ? [button('omd_git_restore', `Restore ${state.backup.path} from its backup`, 'Restore backup', 'restore')] : [])];
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
      { type: 'pane', id: 'omd_git_changes', label: 'Changed files', title: `Changes  ${state.total}`, children: changes.length ? changes : [line('omd_git_clean', 'Working tree clean', 'working tree clean', 'success')] },
      { type: 'pane', id: 'omd_git_graph', label: 'Git commit graph', title: trim(`Git  ${headline(state.head)}`), collapsed: true, children: [line('omd_git_commits', 'Recent commits', state.rows.length ? state.rows.map(row => trim(row)).join('\n') : 'no commits yet', 'accent')] },
    ];
    const actions: TerminalComponent[] = [];
    const options = state.entries.filter(entry => bytes(entry.path) <= 128).slice(0, 16);
    const selected = options.find(entry => entry.path === state.selected) ?? options[0];
    if (selected) {
      actions.push({ type: 'select', id: 'omd_git_file', label: 'Selected file', value: selected.path, options: options.map(entry => ({ value: entry.path, label: trim(describe(entry), 128) })), action: { command: 'omd_git:choose' } });
      actions.push(button('omd_git_diff', `Show diff of ${selected.path}`, 'Diff', 'show'));
      if (!selected.conflicted && (selected.worktree !== ' ' || selected.index === '?')) actions.push(button('omd_git_stage', `Stage ${selected.path}`, 'Stage', 'act', 'stage'));
      if (!selected.conflicted && selected.index !== ' ' && selected.index !== '?') actions.push(button('omd_git_unstage', `Unstage ${selected.path}`, 'Unstage', 'act', 'unstage'));
      if (!selected.conflicted && (selected.worktree !== ' ' || selected.index === '?')) actions.push(button('omd_git_discard', `Back up and discard ${selected.path}`, `Discard${glyph.more}`, 'act', 'discard'));
    }
    actions.push({ type: 'input', id: 'omd_git_message', label: 'Commit message', value: state.message, placeholder: 'type a commit message', action: { command: 'omd_git:message' } });
    if (state.entries.some(entry => !entry.conflicted && entry.index !== ' ' && entry.index !== '?')) actions.push(button('omd_git_commit', 'Preview staged commit', `Preview commit${glyph.more}`, 'commit'));
    const targets = state.branches.filter(branch => branch !== state.head?.branch).slice(0, 16);
    if (targets.length) {
      actions.push({ type: 'select', id: 'omd_git_branch', label: 'Branch to preview', value: state.branch && targets.includes(state.branch) ? state.branch : targets[0], options: targets.map(value => ({ value, label: trim(value, 128) })), action: { command: 'omd_git:branch' } });
      actions.push(button('omd_git_switch', 'Preview the selected branch', `Preview switch${glyph.more}`, 'checkout'));
    }
    components.push({ type: 'pane', id: 'omd_git_actions', label: 'Git file, commit and branch actions', title: 'Actions', collapsed: true, children: actions });
    if (state.notice) components.push(line('omd_git_notice', 'Git notice', trim(state.notice, width * 2), 'muted'));
    if (state.backup) components.push(button('omd_git_restore', `Restore ${state.backup.path} from its backup`, 'Restore backup', 'restore'));
    return components;
  };
  const dialog = (preview: Preview): TerminalRenderSite => ({ mode: 'replace', components: [{ type: 'dialog', id: 'omd_git_dialog', label: 'Git preview', title: trim(preview.kind === 'switch' ? `Switch to ${preview.target}?` : preview.kind === 'commit' ? 'Commit staged files?' : `Discard ${preview.target}?`, 128), children: [{ type: 'pane', id: 'omd_git_preview_pane', label: 'Scrollable exact preview', title: 'Preview · up/down to inspect all paths', collapsed: false, scroll: 0, children: [line('omd_git_preview', 'Preview', preview.lines.join('\n'))] }, ...(preview.kind === 'discard' || preview.kind === 'commit' || preview.kind === 'switch' && preview.expected ? [button('omd_git_confirm', 'Confirm guarded Git action', 'Confirm', 'confirm')] : [line('omd_git_read_only', 'Git write status', WRITE_UNAVAILABLE, 'attention')]), ...(preview.kind === 'commit' ? [button('omd_git_staged_diff', 'Show staged diff', 'Staged diff', 'show', 'staged')] : []), button('omd_git_cancel', 'Close preview', 'Close', 'dismiss')] }] });
  type Failure = { ok: false; kind: 'token' | 'rate' | 'denied' | 'retry'; error: string; until?: number };
  type Answer = { ok: true; json: any; at: number } | Failure;
  const RANK = ['pass', 'pending', 'fail'];
  const ICON: Record<string, string> = ascii ? { passing: '+', failing: 'x', pending: '~', merged: 'M', closed: '-' } : { passing: '✓', failing: '✗', pending: '◌', merged: '⊕', closed: '⊘' };
  const TONE: Record<string, TerminalTone> = { passing: 'success', failing: 'failure', pending: 'attention', merged: 'accent' };
  const HEADERS = { accept: 'application/vnd.github+json', 'user-agent': 'omd_git', 'x-github-api-version': '2022-11-28' };
  const schedule = (key: string, ms: number) => api.host.tryCall('events.schedule', { key, delay_ms: Math.min(86_400_000, Math.max(1_000, Math.round(ms))) });
  const publish = (data: object) => api.host.tryCall('events.publish', { channel: 'github', data: data as Json });
  const bucket = (w: Watch) => {
    if (w.pr?.state === 'MERGED' || w.pr?.state === 'CLOSED') return w.pr.state.toLowerCase();
    const c = w.checks;
    if (!c) return 'unknown';
    const [pass, fail, pending] = c.req[0] + c.req[1] + c.req[2] ? c.req : [c.pass, c.fail, c.pending];
    const value = fail ? 'failing' : pending ? 'pending' : pass ? 'passing' : 'no checks';
    return value === 'passing' && w.incomplete ? 'partial' : value;
  };
  const active = (w: Watch) => !!w.checks?.pending || w.runs.some(run => run.state === 'pending') || w.pr?.merge === 'UNKNOWN';
  const stale = (w: Watch, gh: Github) => !w.final && (gh.token !== 'ready' || !!w.error || !w.at || Date.now() - w.at > (active(w) ? 120_000 : 900_000));
  const summary = (w: Watch, gh: Github) => {
    const c = w.checks;
    const required = c ? c.req[0] + c.req[1] + c.req[2] : 0;
    return `${w.key} ${bucket(w)}${c ? ` ${c.pass}/${c.total}${required ? ` req ${c.req[0]}/${required}` : ''}` : ''}${w.pr?.draft ? ' draft' : ''}${w.pr?.merge === 'BLOCKED' ? ' blocked' : ''}${w.pr && w.pr.review !== 'NONE' ? ` ${w.pr.review.toLowerCase().replace(/_/g, ' ')}` : ''}${stale(w, gh) ? ` stale${w.at ? ` ${Math.max(0, Math.round((Date.now() - w.at) / 60_000))}m` : ''}` : ''}${w.incomplete ? ' incomplete' : ''}`;
  };
  let used = 0;
  const github = (token: string, path: string, body?: object): Answer => {
    const result = api.host.tryCall('http.request', { url: `${GH}${path}`, credential: token, timeout_ms: 20_000, max_bytes: 65_536, ...(body ? { method: 'POST', body: JSON.stringify(body), headers: { ...HEADERS, 'content-type': 'application/json' } } : { headers: HEADERS }) });
    if (!result.ok) return { ok: false, kind: /^(credential_|grant_expired|capability_denied|http_origin_denied)/.test(result.error) ? 'token' : 'retry', error: visible(result.error, 160) };
    const response = result.value;
    used += Math.ceil(response.bytes * 1.3) + 4_096;
    const header = response.headers;
    const at = Date.parse(header.date ?? '') || Date.now();
    const wait = Number(header['retry-after'] ?? 0) * 1000 || (header['x-ratelimit-remaining'] === '0' ? Number(header['x-ratelimit-reset']) * 1000 - at : 0);
    const until = Date.now() + Math.min(Math.max(wait || 0, 60_000), 3_600_000);
    if (response.status === 401) return { ok: false, kind: 'token', error: 'GitHub rejected the token' };
    if ((response.status === 403 || response.status === 429) && wait > 0) return { ok: false, kind: 'rate', error: 'GitHub rate limit', until };
    if (response.status === 403 || response.status === 404) return { ok: false, kind: 'denied', error: `GitHub ${response.status}: not found or not readable with this token` };
    if (response.status !== 200 || response.truncated || typeof response.body !== 'string') return { ok: false, kind: 'retry', error: response.truncated ? 'GitHub response exceeded the read limit' : `GitHub ${response.status}` };
    let json: any;
    try { json = JSON.parse(response.body); } catch { return { ok: false, kind: 'retry', error: 'GitHub response unreadable' }; }
    const problem = json?.errors?.[0];
    if (problem) return { ok: false, kind: problem.type === 'RATE_LIMITED' ? 'rate' : problem.type === 'NOT_FOUND' || problem.type === 'FORBIDDEN' ? 'denied' : 'retry', error: visible(String(problem.message ?? 'GitHub query failed'), 160), until };
    return { ok: true, json, at };
  };
  const fresh = (): Page => ({ cursor: null, head: '', loaded: 0, checks: { total: 0, pass: 0, fail: 0, pending: 0, req: [0, 0, 0], failing: [] }, runs: {} });
  const absorb = (page: Page, nodes: any[]) => {
    for (const node of nodes) {
      const state = node.__typename === 'StatusContext' ? node.state === 'SUCCESS' ? 'pass' : node.state === 'PENDING' || node.state === 'EXPECTED' ? 'pending' : 'fail' : node.status !== 'COMPLETED' ? 'pending' : ['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(node.conclusion) ? 'pass' : 'fail';
      const c = page.checks;
      c.total += 1;
      c[state as 'pass' | 'fail' | 'pending'] += 1;
      if (node.isRequired) c.req[['pass', 'fail', 'pending'].indexOf(state)] += 1;
      if (state === 'fail' && c.failing.length < 8) c.failing.push(`${node.isRequired ? 'required ' : ''}${visible(String(node.name ?? node.context), 80)}${node.databaseId ? ` (check ${node.databaseId})` : ''}`);
      const run = node.checkSuite?.workflowRun;
      const prior = run?.databaseId ? page.runs[run.databaseId] : undefined;
      if (run?.databaseId && (prior || Object.keys(page.runs).length < 100)) page.runs[run.databaseId] = [visible(String(run.workflow?.name ?? 'workflow'), 80), prior && RANK.indexOf(prior[1]) > RANK.indexOf(state) ? prior[1] : state];
    }
  };
  const load = (token: string, w: Watch): Failure | null => {
    if (!w.number) {
      const found = github(token, '/graphql', { query: BRANCH_QUERY, variables: { o: w.owner, r: w.repo, b: w.branch } });
      if (!found.ok) return found;
      const own = `${w.owner}/${w.repo}`.toLowerCase();
      const repository = found.json.data?.repository;
      const match = [repository?.parent, repository].flatMap(base => (base?.pullRequests?.nodes ?? []).filter((pr: any) => String(pr.headRepository?.nameWithOwner).toLowerCase() === own).map((pr: any) => [String(base.nameWithOwner), Number(pr.number)] as const))[0];
      if (!match) return { ok: false, kind: 'denied', error: `no open pull request from ${own}:${w.branch}` };
      [w.owner, w.repo] = match[0].split('/');
      w.number = match[1];
      w.key = `${w.owner}/${w.repo}#${w.number}`;
    }
    const page = w.page ?? fresh();
    let done = !w.page && !!w.checks && w.runs.some(run => !run.verified);
    for (let pages = done ? 4 : 0; pages < 4 && used < BYTE_BUDGET; pages += 1) {
      const answer = github(token, '/graphql', { query: PR_QUERY, variables: { o: w.owner, r: w.repo, n: w.number, c: page.cursor } });
      if (!answer.ok) return answer;
      const node = answer.json.data?.repository?.pullRequest;
      if (!node) return { ok: false, kind: 'denied', error: 'pull request not found' };
      const commit = node.commits?.nodes?.[0]?.commit;
      if (commit && commit.oid !== node.headRefOid || page.head && page.head !== node.headRefOid) { Object.assign(page, fresh()); continue; }
      page.head = node.headRefOid;
      if (w.pr && w.pr.head !== node.headRefOid) Object.assign(w, { checks: null, runs: [], more: 0 });
      w.pr = { title: visible(String(node.title), 200), state: String(node.state), draft: !!node.isDraft, merge: String(node.mergeStateStatus ?? 'UNKNOWN'), review: String(node.reviewDecision ?? 'NONE'), updated: String(node.updatedAt), head: String(node.headRefOid), ref: visible(String(node.headRefName), 128), base: visible(String(node.baseRefName), 128) };
      w.at = answer.at;
      const contexts = commit?.statusCheckRollup?.contexts;
      absorb(page, contexts?.nodes ?? []);
      page.loaded = Number(contexts?.totalCount ?? page.checks.total);
      page.cursor = contexts?.pageInfo?.hasNextPage ? String(contexts.pageInfo.endCursor) : null;
      if (page.cursor) continue;
      const prior = new Map(w.runs.map(run => [run.id, run]));
      const ids = Object.keys(page.runs).sort((left, right) => RANK.indexOf(page.runs[right][1]) - RANK.indexOf(page.runs[left][1]));
      w.runs = ids.slice(0, RUN_LIMIT).map(id => {
        const [name, state] = page.runs[id];
        const old = prior.get(Number(id));
        return old?.verified && old.state === state && state !== 'pending' ? old : { id: Number(id), name, attempt: old?.attempt ?? 0, state, verified: false };
      });
      w.more = Math.max(0, ids.length - RUN_LIMIT);
      w.checks = page.checks;
      done = true;
      break;
    }
    w.page = done ? null : page;
    for (const run of w.page ? [] : w.runs.filter(item => !item.verified)) {
      if (used >= BYTE_BUDGET) break;
      const answer = github(token, `/repos/${w.owner}/${w.repo}/actions/runs/${run.id}?exclude_pull_requests=true`);
      if (!answer.ok && answer.kind !== 'denied') return answer;
      if (!answer.ok) { w.runs = w.runs.map(item => item.verified ? item : { ...item, verified: true, attempt: 0 }); w.incomplete = 'workflow runs not readable with this token'; return null; }
      if (answer.json.head_sha !== w.pr?.head) { w.runs = w.runs.filter(item => item.id !== run.id); continue; }
      Object.assign(run, { name: visible(String(answer.json.name), 80), attempt: Number(answer.json.run_attempt) || 1, state: answer.json.status !== 'completed' ? 'pending' : ['success', 'neutral', 'skipped'].includes(answer.json.conclusion) ? 'pass' : 'fail', verified: true });
    }
    const unverified = w.runs.filter(run => !run.verified).length;
    w.incomplete = w.page ? `checks ${w.page.checks.total}/${w.page.loaded} loaded` : unverified ? `${unverified} of ${w.runs.length} runs not yet fetched` : null;
    return null;
  };
  const tick = (turn: boolean) => {
    const gh = saved().github;
    const now = Date.now();
    const open = gh.watches.filter(w => !w.final);
    if (!open.length) return;
    if (gh.until > now) { schedule('github', gh.until - now); return; }
    const profiles = api.host.tryCall('credentials.list', null);
    const token = profiles.ok ? profiles.value.find(profile => profile.kind === 'secret' && profile.origin === GH && profile.status === 'ready')?.id : undefined;
    if (!token) { publish({ token: 'missing' }); return; }
    used = 0;
    let until = 0;
    let access = 'ready';
    const updates: (Watch & { from: string })[] = [];
    for (const original of [...open].sort((left, right) => left.next - right.next)) {
      if (used >= BYTE_BUDGET || until || access !== 'ready') break;
      if (original.next > now && !(turn && !original.error && now - (original.at ?? 0) >= 30_000)) continue;
      const w: Watch = JSON.parse(JSON.stringify(original));
      const failed = load(token, w);
      if (failed) {
        if (failed.kind === 'token') access = 'invalid';
        if (failed.kind === 'rate') until = failed.until ?? now + 60_000;
        w.fail = failed.kind === 'retry' ? w.fail + 1 : w.fail;
        w.error = failed.error;
        w.next = failed.kind === 'denied' ? now + 900_000 : failed.kind === 'retry' ? now + Math.min(30_000 * 2 ** w.fail, 900_000) : until || now + 60_000;
      } else {
        w.error = null;
        w.fail = 0;
        w.final = !!w.pr && w.pr.state !== 'OPEN';
        w.next = w.page || w.runs.some(run => !run.verified) ? now + 1_000 : now + (active(w) ? 30_000 : 300_000);
      }
      updates.push({ ...w, from: original.key });
    }
    publish({ watches: updates, until, token: access });
    if (access !== 'ready') return;
    const next = new Map(open.map(w => [w.key, w.next]));
    for (const update of updates) next.set(update.from, update.final ? Infinity : update.next);
    const soonest = until || Math.min(...next.values());
    if (soonest !== Infinity) schedule('github', soonest - now);
  };
  const announce = (before: Watch, after: Watch) => {
    if (api.settings.notices !== true || !before.pr || !after.pr) return;
    const was = bucket(before);
    const now = bucket(after);
    const review = before.pr.review !== after.pr.review && after.pr.review !== 'NONE';
    if (!review && (was === now || !['passing', 'failing', 'merged', 'closed'].includes(now))) return;
    api.host.tryCall('terminal.notify', { title: trim(after.key, 120), body: trim(`${now}${review ? `, review ${after.pr.review.toLowerCase().replace(/_/g, ' ')}` : ''}: ${after.pr.title}`, 200) });
  };
  const details = (w: Watch, gh: Github) => {
    const c = w.checks;
    const pr = w.pr;
    const lines = [
      pr ? pr.title : `branch ${w.branch ?? '?'}, not loaded yet`,
      ...(pr ? [`${pr.state.toLowerCase()}${pr.draft ? ' draft' : ''} · merge ${pr.merge.toLowerCase()} · review ${pr.review.toLowerCase().replace(/_/g, ' ')}`, `head ${pr.head.slice(0, 12)} ${pr.ref} ${glyph.arrow} ${pr.base}`] : []),
      ...(c ? [`checks ${c.total}: ${c.pass} pass, ${c.fail} fail, ${c.pending} pending`, `required ${c.req[0]} pass, ${c.req[1]} fail, ${c.req[2]} pending`, ...c.failing.map(name => `  ${ICON.failing} ${name}`)] : []),
      ...w.runs.map(run => `  ${ICON[run.state === 'pass' ? 'passing' : run.state === 'fail' ? 'failing' : 'pending']} ${run.name} run ${run.id}${run.attempt ? ` attempt ${run.attempt}` : ''}${run.verified ? '' : ' (not yet fetched)'}`),
      ...(w.more ? [`  ${glyph.more} ${w.more} more runs, counted in checks`] : []),
      `source ${w.at ? new Date(w.at).toISOString() : 'never fetched'}${pr ? ` · PR updated ${pr.updated}` : ''}${stale(w, gh) ? ' · stale' : ''}`,
      ...(w.incomplete ? [`incomplete: ${w.incomplete}`] : []),
      ...(w.error ? [`error: ${w.error}`] : []),
      ...(gh.token === 'missing' ? ['no GitHub token: /omd_git:github token adds one'] : gh.token === 'invalid' ? ['GitHub token rejected or revoked: /omd_git:github token'] : []),
    ].map(text => trim(text, 200));
    let size = 0;
    return lines.filter(text => (size += bytes(text) + 1) <= DIALOG_TEXT_LIMIT).join('\n');
  };
  const pulls = (gh: Github): TerminalComponent[] => gh.watches.length ? [{ type: 'pane', id: 'omd_git_github', label: 'GitHub pull requests', title: `GitHub  ${gh.watches.length}`, children: [
    { type: 'list', id: 'omd_git_prs', label: 'Watched pull requests', height: gh.watches.length, rows: gh.watches.map(w => ({ value: w.key, label: trim(summary(w, gh), 200), spans: [{ text: `${ICON[bucket(w)] ?? '?'} `, tone: TONE[bucket(w)] ?? 'muted' }, { text: trim(summary(w, gh), width - 6), tone: stale(w, gh) ? 'muted' : 'normal' }] })), action: { command: 'omd_git:pr' } },
    ...(gh.token === 'missing' || gh.token === 'invalid' ? [line('omd_git_token', 'GitHub token', trim(gh.token === 'missing' ? 'no token: /omd_git:github token' : 'token rejected: /omd_git:github token'), 'attention')] : []),
  ] }] : [];
  const inspector = (w: Watch, gh: Github): TerminalRenderSite => ({ mode: 'replace', components: [{ type: 'dialog', id: 'omd_git_pr', label: 'Pull request details', title: trim(w.key, 128), children: [{ type: 'pane', id: 'omd_git_pr_pane', label: 'Pull request status', title: 'Status', collapsed: false, scroll: 0, children: [line('omd_git_pr_details', 'Details', details(w, gh))] }, button('omd_git_unwatch', `Stop watching ${w.key}`, 'Unwatch', 'github', `unwatch ${w.key}`), button('omd_git_pr_close', 'Close details', 'Close', 'dismiss')] }] });
  const view = (): TerminalPatch => {
    const state = saved();
    const inspected = state.github.watches.find(w => w.key === state.github.view);
    return { sidebar_side: api.settings.side === 'right' ? 'right' : 'left', sidebar_width: width, sites: { sidebar: { mode: 'wrap', components: [{ type: 'slot' }, ...sidebar(state), ...pulls(state.github)] }, ...(state.preview ? { dialog: dialog(state.preview) } : inspected ? { dialog: inspector(inspected, state.github) } : {}) }, status: state.error ? [] : [trim(`git: ${state.head?.branch ?? 'detached'}${state.total ? ` ${ascii ? '*' : '✱'}${state.total}` : ''}`, 40)], keybindings: { 'Alt+g': { command: 'omd_git:refresh' } } };
  };
  api.command('refresh', () => { const state = refresh({ ...saved(), notice: null }); return { display: state.error ? `Git: ${state.error}` : `Git: ${headline(state.head)}, ${state.total} changed` }; }, { description: 'Refresh the Git sidebar' });
  api.command('changes', () => { const state = refresh(); return { display: state.error ? `Git: ${state.error}` : [trim(headline(state.head), 200), ...state.entries.map(entry => trim(describe(entry), 200)), ...(state.more ? [`${glyph.more} ${state.total - state.entries.length} more`] : [])].join('\n') }; }, { description: 'Show the current branch and changed files' });
  api.command('log', () => { const result = commits(50); return { display: result.ok ? graph(result.value).map(row => trim(row, 200)).join('\n') || 'no commits yet' : result.error }; }, { description: 'Show recent commits' });
  api.command('choose', value => { const state = saved(); const path = typeof value === 'string' ? value : ''; if (!state.entries.some(entry => entry.path === path)) return { display: 'select a changed file first' }; save({ ...state, selected: path, notice: null }); return null; }, { description: 'Select a changed file' });
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
  const stagedDiff = () => {
    const preview = saved().preview;
    if (preview?.kind !== 'commit') return { display: 'open a commit preview first' };
    const result = run(['diff', '--cached', '--no-ext-diff', '--no-textconv', '--ignore-submodules=all'], 65_536);
    return { display: result.ok ? `${result.value.slice(0, 12_000)}${result.value.length > 12_000 ? `\n${glyph.more} truncated` : ''}` : result.error };
  };
  api.command('show', value => {
    if (value === 'staged') return stagedDiff();
    const state = refresh();
    if (state.error) return { display: `Git: ${state.error}` };
    const path = typeof value === 'string' && value ? value : state.selected;
    const entry = state.entries.find(item => item.path === path);
    if (!entry) return { display: 'select a changed file first' };
    if (entry.index === '?') return { display: 'untracked file; no Git diff is available' };
    const staged = entry.worktree === ' ' && entry.index !== ' ';
    const result = diff(entry.path, staged);
    return { display: result.ok ? `${staged ? 'staged' : 'unstaged'} diff · ${trim(entry.path, 200)}\n${result.value.slice(0, 12_000)}${result.value.length > 12_000 ? `\n${glyph.more} truncated` : ''}` : result.error };
  }, { description: 'Show a changed file diff, or `staged` for the commit preview' });
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
    const index = tracked ? read(['ls-files', '-s', '-z']) : null;
    if (index && !index.ok) return { display: index.error };
    const indexed = index?.ok ? index.value.text.split('\0').find(record => record.slice(record.indexOf('\t') + 1) === entry.path) : null;
    const blob = indexed && /^100(?:644|755) ([0-9a-f]{40,64}) 0\t/.exec(indexed)?.[1];
    if (tracked && !blob) return { display: 'discard requires a regular file in the index' };
    const restored = blob && index?.ok ? api.host.tryCall('exec.run', {
      program: 'node', argv: ['--input-type=module', '-', index.value.program, index.value.guard.sha256!, ...gitArgs(['cat-file', '--filters', `--path=${entry.path}`, blob])],
      stdin: api.assets.read('fingerprint.mjs').text, timeout_ms: 10_000, max_output_bytes: 65_536, write: false, network: 'none',
    }) : null;
    if (restored && !restored.ok) return { display: restored.error };
    if (restored?.ok && (restored.value.exit_code !== 0 || restored.value.timed_out || restored.value.stdout_truncated || restored.value.stderr_truncated || !/^[0-9a-f]{64}\n$/.test(restored.value.stdout))) return { display: restored.value.stderr.trim().slice(0, 200) || 'Git file fingerprint unavailable' };
    const content = tracked ? read(['hash-object', '--no-filters', '--', entry.path], 256) : null;
    if (content && (!content.ok || !/^[0-9a-f]{40,64}\n$/.test(content.value.text))) return { display: content.ok ? 'Git file fingerprint unavailable' : content.error };
    const lines = [`  ${trim(entry.path, width - 4)}`, '', ...(change?.ok ? [visible(change.value.text.slice(0, 8_000)), ''] : []), 'The current file will be backed up outside this repository before the change.', 'Confirmation refuses a changed file or Git status.'];
    save({ ...state, preview: { kind: 'discard', tracked, target: entry.path, from: state.head?.oid ?? null, destination: null, ...(restored?.ok ? { restoreHash: restored.value.stdout.trim() } : {}), status: state.status, lines, guards: tracked && index?.ok && content?.ok ? [...state.guards, index.value.guard, content.value.guard] : state.guards, paths: [entry.path], expected: { [entry.path]: file.sha256 } } });
    return null;
  };
  api.command('act', value => {
    const [action, ...rest] = String(value ?? '').trim().split(' ');
    const path = rest.join(' ');
    if (!['stage', 'unstage', 'discard'].includes(action)) return { display: 'usage: /omd_git:act stage|unstage|discard [PATH]' };
    if (path) {
      const state = refresh({ ...saved(), selected: path, notice: null });
      if (!state.entries.some(entry => entry.path === path)) return { display: `${trim(path, 80)} has no Git change` };
    }
    return action === 'discard' ? discard() : changeIndex(action as 'stage' | 'unstage');
  }, { description: 'Select a changed file and stage, unstage or preview discarding it' });
  api.command('checkout', () => {
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
      if (!preview.restoreHash) return { display: WRITE_UNAVAILABLE };
      const backup = api.host.tryCall('workspace.backup', { expected: preview.expected });
      if (!backup.ok) { save({ ...previous, preview: null, notice: backup.error }); return { display: backup.error }; }
      const result = write(['restore', '--worktree', '--', preview.target], preview.guards, preview.paths);
      const retained = { path: preview.target, reference: backup.value.backup, expected: preview.restoreHash };
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
  }, { description: 'Confirm a Git action with checked preconditions' });
  api.command('restore', () => {
    const state = saved();
    if (!state.backup) return { display: 'no Git discard backup to restore' };
    const restored = api.host.tryCall('workspace.restore', { backup: state.backup.reference, expected: { [state.backup.path]: state.backup.expected } });
    if (!restored.ok) return { display: restored.error };
    const next = refresh({ ...state, backup: null, preview: null });
    const notice = `restored ${trim(state.backup.path, 80)}`;
    save({ ...next, notice });
    return { display: notice };
  }, { description: 'Restore the last discarded file if its expected content is unchanged' });
  api.command('dismiss', () => { const state = saved(); save({ ...state, preview: null, github: { ...state.github, view: null } }); return null; }, { description: 'Close the Git preview or pull request details' });
  const find = (watches: Watch[], key: string) => watches.find(w => w.key.toLowerCase() === key.toLowerCase());
  const remote = (name: string): Result<string[]> => {
    const url = run(['remote', 'get-url', name], 1024);
    if (!url.ok) return url;
    const match = /github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(url.value.trim());
    return match ? { ok: true, value: [match[1], match[2]] } : { ok: false, error: `remote ${name} is not a github.com repository` };
  };
  const target = (value: string): Result<Pick<Watch, 'owner' | 'repo' | 'number' | 'branch'>> => {
    const direct = /^(?:https:\/\/github\.com\/)?([\w.-]+)\/([\w.-]+?)(?:#|\/pull\/)(\d+)\/?$/.exec(value);
    if (direct) return { ok: true, value: { owner: direct[1], repo: direct[2], number: Number(direct[3]), branch: null } };
    const number = /^#?(\d+)$/.exec(value);
    if (number) {
      const upstream = remote('upstream');
      const repo = upstream.ok ? upstream : remote('origin');
      return repo.ok ? { ok: true, value: { owner: repo.value[0], repo: repo.value[1], number: Number(number[1]), branch: null } } : repo;
    }
    if (value) return { ok: false, error: 'usage: /omd_git:github watch [OWNER/REPO#N | PR URL | #N]' };
    const branch = run(['symbolic-ref', '--short', '-q', 'HEAD'], 1024);
    if (!branch.ok || !branch.value.trim()) return { ok: false, error: 'check out a branch to watch its pull request' };
    const local = branch.value.trim();
    const refs = run(['for-each-ref', '--format=%(push:remotename) %(upstream:remotename) %(upstream:remoteref)', `refs/heads/${local}`], 1024);
    const [push, fetch, merge] = refs.ok ? refs.value.trim().split(' ') : [];
    const repo = remote(push || 'origin');
    return repo.ok ? { ok: true, value: { owner: repo.value[0], repo: repo.value[1], number: 0, branch: push === fetch && merge ? merge.replace(/^refs\/heads\//, '') : local } } : repo;
  };
  const watch = (value: string) => {
    const parsed = target(value);
    if (!parsed.ok) return { display: parsed.error };
    const state = saved();
    const key = parsed.value.number ? `${parsed.value.owner}/${parsed.value.repo}#${parsed.value.number}` : `${parsed.value.owner}/${parsed.value.repo}:${parsed.value.branch}`;
    if (find(state.github.watches, key)) return { display: `already watching ${key}` };
    if (state.github.watches.length >= WATCH_LIMIT) return { display: `at most ${WATCH_LIMIT} pull requests can be watched; unwatch one first` };
    save({ ...state, github: { ...state.github, watches: [...state.github.watches, { ...parsed.value, key, added: Date.now(), pr: null, checks: null, runs: [], more: 0, page: null, incomplete: null, error: null, fail: 0, next: 0, at: null, final: false }] } });
    publish({ poll: true });
    return { display: `watching ${key}${state.github.token === 'missing' ? '; add a token with /omd_git:github token' : ''}` };
  };
  const unwatch = (value: string) => {
    const state = saved();
    const all = state.github.watches;
    const key = value || state.github.view || (all.length === 1 ? all[0].key : '');
    const gone = find(all, key);
    if (!gone) return { display: key ? 'not watching that pull request' : 'usage: /omd_git:github unwatch KEY' };
    save({ ...state, github: { ...state.github, watches: all.filter(w => w !== gone), view: null } });
    return { display: `stopped watching ${gone.key}` };
  };
  api.command('pr', value => {
    const state = saved();
    const key = String(value ?? '').trim();
    if (!key) return { display: state.github.watches.map(w => trim(summary(w, state.github), 200)).join('\n') || 'no watched pull requests; /omd_git:github watch adds one' };
    const shown = find(state.github.watches, key);
    if (!shown) return { display: 'not watching that pull request' };
    save({ ...state, github: { ...state.github, view: shown.key } });
    return null;
  }, { description: 'Show pull request and CI details, or list watched pull requests' });
  const token = (value: string) => {
    const profiles = api.host.tryCall('credentials.list', null);
    if (!profiles.ok) return { display: profiles.error };
    const profile = profiles.value.find(item => item.kind === 'secret' && item.origin === GH);
    if (profile && value === 'remove') {
      const removed = api.host.tryCall('credentials.request', { action: 'remove', profile: profile.id });
      return { display: !removed.ok ? removed.error : removed.value.status === 'completed' ? 'GitHub token removed; watches pause until a token is added' : 'kept the GitHub token' };
    }
    if (value || profile?.status === 'ready' && saved().github.token !== 'invalid') return { display: profile ? `GitHub token ${profile.id} is ${profile.status === 'ready' ? 'enrolled' : 'empty'}; /omd_git:github token remove deletes it` : 'no GitHub token is enrolled' };
    const enrolled = api.host.tryCall('credentials.request', profile ? { action: 'refresh', profile: profile.id } : { action: 'enroll', kind: 'secret', label: 'GitHub (omd_git)', origin: GH });
    if (!enrolled.ok || enrolled.value.status !== 'completed') return { display: enrolled.ok ? 'GitHub token not added' : enrolled.error };
    publish({ poll: true });
    return { display: 'GitHub token added. Use a fine-grained token with read-only Metadata, Pull requests, Checks, Actions and Commit statuses access.' };
  };
  api.command('github', value => {
    const [action, ...rest] = String(value ?? '').trim().split(/\s+/);
    const argument = rest.join(' ');
    return action === 'watch' ? watch(argument) : action === 'unwatch' ? unwatch(argument) : action === 'token' ? token(argument) : { display: 'usage: /omd_git:github watch [OWNER/REPO#N | PR URL | #N] | unwatch [KEY] | token [remove]' };
  }, { description: 'Watch or unwatch a GitHub pull request read-only, or add or remove the GitHub token' });
  api.on('channel', ({ channel, data }) => {
    if (channel !== 'omd_git/github') return;
    const message = (data ?? {}) as { poll?: boolean; watches?: (Watch & { from: string })[]; until?: number; token?: string };
    if (message.poll) { schedule('github', 1_000); return; }
    const state = saved();
    const watches = [...state.github.watches];
    for (const { from, ...update } of message.watches ?? []) {
      const index = watches.findIndex(w => w.key === from && w.added === update.added);
      if (index < 0) continue;
      if (update.key !== from && find(watches, update.key)) { watches.splice(index, 1); continue; }
      announce(watches[index], update);
      watches[index] = update;
    }
    save({ ...state, github: { ...state.github, watches, until: message.until || state.github.until, token: message.token ?? state.github.token, view: watches.some(w => w.key === state.github.view) ? state.github.view : null } });
  });
  api.on('timer', ({ key }) => { if (key === 'github' || key === 'github_turn') tick(key === 'github_turn'); });
  for (const event of ['start', 'resume', 'turn_start', 'turn_end', 'idle'] as const) api.on(event, () => {
    refresh();
    if ((event === 'start' || event === 'resume' || event === 'turn_end') && saved().github.watches.some(w => !w.final)) schedule(event === 'turn_end' ? 'github_turn' : 'github', event === 'turn_end' ? 10_000 : 1_000);
  });
  api.on('terminal', () => view());
}
