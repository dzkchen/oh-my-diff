import type { TerminalSpan, TerminalTone } from '../../api.d.ts';
import { visible } from './segments.ts';
import type { Checks, Data, Git, Pull, Settings } from './segments.ts';

export const GIT_SCRIPT = [
  'export LC_ALL=C GIT_OPTIONAL_LOCKS=0',
  'git status --porcelain=v2 --branch -z || exit 3',
  'printf "\\n@@\\n"; git diff --shortstat HEAD 2>/dev/null',
  'printf "@@\\n"; git rev-parse --path-format=absolute --git-dir --git-common-dir --show-toplevel',
  'printf "@@\\n"; git remote get-url origin 2>/dev/null; true',
].join('\n');

export function remote(url: string): Git['remote'] {
  const match = url.trim().match(/^(?:https:\/\/(?:[^@/]+@)?github\.com\/|(?:ssh:\/\/)?git@github\.com[:/])([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/);
  return match ? { owner: match[1], repo: match[2] } : null;
}

export function parseGit(key: string, at: number, stdout: string): Git {
  const [status = '', shortstat = '', paths = '', origin = ''] = stdout.split(/\n?@@\n/);
  const git: Git = { key, at, branch: null, oid: null, ahead: 0, behind: 0, staged: 0, unstaged: 0, untracked: 0, conflicts: 0, added: 0, removed: 0, worktree: null, remote: remote(origin), error: null };
  const records = status.split('\0');
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (record.startsWith('# branch.oid ')) git.oid = /^[0-9a-f]{7,64}$/.test(record.slice(13)) ? record.slice(13) : null;
    else if (record.startsWith('# branch.head ')) git.branch = record.slice(14) === '(detached)' ? null : visible(record.slice(14), 120);
    else if (record.startsWith('# branch.ab ')) {
      const [ahead, behind] = record.slice(12).split(' ').map(part => Math.abs(Number(part)) || 0);
      Object.assign(git, { ahead, behind });
    } else if (record.startsWith('1 ') || record.startsWith('2 ')) {
      if (record[2] !== '.') git.staged += 1;
      if (record[3] !== '.') git.unstaged += 1;
      if (record.startsWith('2 ')) index += 1;
    } else if (record.startsWith('u ')) git.conflicts += 1;
    else if (record.startsWith('? ')) git.untracked += 1;
  }
  git.added = Number(shortstat.match(/(\d+) insertion/)?.[1] ?? 0);
  git.removed = Number(shortstat.match(/(\d+) deletion/)?.[1] ?? 0);
  const [dir, common, top] = paths.trim().split('\n');
  if (dir && common && top && dir !== common) git.worktree = visible(top.split('/').filter(Boolean).at(-1) ?? '', 40) || null;
  return git;
}

export const GITHUB_ORIGIN = 'https://api.github.com';
const ROLLUP = 'statusCheckRollup{state contexts(first:100){nodes{__typename ... on CheckRun{status conclusion} ... on StatusContext{state}}}}';
export const GITHUB_QUERY = `query($owner:String!,$name:String!,$branch:String!,$ref:String!){repository(owner:$owner,name:$name){`
  + `pullRequests(headRefName:$branch,first:1,orderBy:{field:CREATED_AT,direction:DESC}){nodes{number title url state isDraft reviewDecision mergeStateStatus commits(last:1){nodes{commit{${ROLLUP}}}}}}`
  + `ref(qualifiedName:$ref){target{... on Commit{${ROLLUP}}}}}}`;

const record = (value: unknown): Record<string, any> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};
const PASSED = ['SUCCESS', 'NEUTRAL', 'SKIPPED'];

function checks(rollup: unknown, url: string | null): Checks | null {
  const value = record(rollup);
  if (typeof value.state !== 'string') return null;
  const result: Checks = { state: value.state, passed: 0, failed: 0, pending: 0, url };
  for (const node of Array.isArray(record(value.contexts).nodes) ? record(value.contexts).nodes.map(record) : []) {
    const outcome = node.__typename === 'CheckRun' ? node.status === 'COMPLETED' ? String(node.conclusion) : 'PENDING' : String(node.state);
    if (PASSED.includes(outcome)) result.passed += 1;
    else if (['PENDING', 'EXPECTED', 'QUEUED', 'IN_PROGRESS', 'WAITING', 'REQUESTED'].includes(outcome)) result.pending += 1;
    else result.failed += 1;
  }
  if (!result.failed && !result.pending && value.state !== 'SUCCESS') value.state === 'PENDING' || value.state === 'EXPECTED' ? result.pending = 1 : result.failed = 1;
  return result;
}

export function parseGithub(body: string, owner: string, repo: string, branch: string): { pr: Pull | null; ci: Checks | null } | { error: string; rate_limited: boolean } {
  let parsed: Record<string, any>;
  try { parsed = record(JSON.parse(body)); } catch { return { error: 'invalid response', rate_limited: false }; }
  const errors = Array.isArray(parsed.errors) ? parsed.errors.map(record) : [];
  if (errors.length) return { error: visible(String(errors[0].message ?? errors[0].type ?? 'query failed'), 80), rate_limited: errors.some(error => error.type === 'RATE_LIMITED') };
  const repository = record(record(parsed.data).repository);
  const node = record(record(repository.pullRequests).nodes?.[0]);
  const safe = (url: unknown) => typeof url === 'string' && /^https:\/\/github\.com\//.test(url) && url.length <= 2048 ? url : null;
  const pr: Pull | null = typeof node.number === 'number' ? {
    number: node.number, title: visible(String(node.title ?? ''), 120), url: safe(node.url) ?? `https://github.com/${owner}/${repo}/pull/${node.number}`,
    state: String(node.state ?? 'OPEN'), draft: node.isDraft === true, review: typeof node.reviewDecision === 'string' ? node.reviewDecision : null,
    merge: typeof node.mergeStateStatus === 'string' ? node.mergeStateStatus : null,
  } : null;
  const rollup = pr ? record(record(node.commits).nodes?.[0]).commit?.statusCheckRollup : record(record(repository.ref).target).statusCheckRollup;
  return { pr, ci: checks(rollup, pr ? `${pr.url}/checks` : `https://github.com/${owner}/${repo}/commits/${encodeURIComponent(branch)}`) };
}

const TONE: Record<number, TerminalTone> = { 30: 'muted', 31: 'failure', 32: 'success', 33: 'attention', 34: 'accent', 35: 'accent', 36: 'accent', 37: 'normal', 90: 'muted', 91: 'failure', 92: 'success', 93: 'attention', 94: 'accent', 95: 'accent', 96: 'accent', 97: 'normal' };

export function ansi(output: string): TerminalSpan[] {
  const line = output.replace(/\r\n?/g, '\n').split('\n').find(part => part.replace(/\x1b\[[0-9;]*m/g, '').trim()) ?? '';
  const spans: TerminalSpan[] = [];
  let current: Omit<TerminalSpan, 'text'> = {};
  let text = '';
  const flush = () => {
    const clean = visible(text, 256);
    if (clean) spans.push({ ...current, text: clean });
    text = '';
  };
  const pattern = /\x1b\[([0-9;]*)m|\x1b\]8;[^;\x07\x1b]*;([^\x07\x1b]*)(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-_]?/g;
  let last = 0;
  for (const match of line.slice(0, 4096).matchAll(pattern)) {
    text += line.slice(last, match.index);
    last = match.index! + match[0].length;
    if (match[1] !== undefined) {
      flush();
      const codes = match[1] === '' ? [0] : match[1].split(';').map(Number);
      for (let index = 0; index < codes.length; index += 1) {
        const code = codes[index];
        if (code === 0) current = current.link ? { link: current.link } : {};
        else if (code === 1) current = { ...current, bold: true };
        else if (code === 3) current = { ...current, italic: true };
        else if (code === 4) current = { ...current, underline: true };
        else if (code === 22) current = { ...current, bold: undefined };
        else if (code === 23) current = { ...current, italic: undefined };
        else if (code === 24) current = { ...current, underline: undefined };
        else if (code === 39) current = { ...current, tone: undefined };
        else if (code === 38 || code === 48) index += codes[index + 1] === 5 ? 2 : codes[index + 1] === 2 ? 4 : 0;
        else if (TONE[code]) current = { ...current, tone: TONE[code] };
      }
    } else if (match[2] !== undefined) {
      flush();
      const url = match[2];
      current = { ...current, link: /^https?:\/\/[^\s]+$/.test(url) && url.length <= 2048 ? url : undefined };
    }
  }
  text += line.slice(last);
  flush();
  return spans.map(item => Object.fromEntries(Object.entries(item).filter(([, value]) => value !== undefined)) as TerminalSpan).slice(0, 12);
}

export function payload(data: Data, config: Settings, id: string, now: number, viewport: { columns: number; rows: number } | null) {
  const { context, tokens, cost, git, github } = data;
  return {
    schema: 1, segment: id, placement: config.placement, viewport, now_ms: now,
    session: { thread_id: data.thread, cwd: data.cwd, started_at_ms: data.started, duration_ms: data.started === null ? null : now - data.started },
    model: data.model,
    context: { used: context.used, window: context.window, remaining: context.used !== null && context.window ? Math.max(0, context.window - context.used) : null,
      used_percent: context.used !== null && context.window ? Math.round(context.used / context.window * 1000) / 10 : null, compactions: context.compactions },
    tokens: { input: tokens.input, output: tokens.output, reasoning: tokens.reasoning, cache_read: tokens.cached, cache_write: tokens.write, requests: tokens.requests },
    cost: { billed_usd: cost.billed, estimated_usd: cost.estimate, included_requests: cost.included, pending_requests: cost.pending, unknown_requests: cost.unknown },
    limits: data.limits.map(item => ({ window_minutes: item.minutes, used_percent: item.used, resets_at_ms: item.resets })),
    git: git && !git.error ? { branch: git.branch, oid: git.oid, ahead: git.ahead, behind: git.behind, staged: git.staged, unstaged: git.unstaged, untracked: git.untracked,
      conflicts: git.conflicts, added: git.added, removed: git.removed, worktree: git.worktree, remote: git.remote } : null,
    github: { status: github.status, pr: github.pr, ci: github.ci },
    plan: data.plan, tools_running: Object.keys(data.tools).length, agents: Object.keys(data.agents).length,
  };
}
