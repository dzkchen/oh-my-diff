export type Change = { path: string; orig?: string; kind: '1' | '2' | 'u' | '?'; x: string; y: string };
export type Head = { branch: string; upstream: string; ab: { ahead: number; behind: number } | null };
export type Branch = { name: string; head: boolean; track: string };
export type Commit = { sha: string; subject: string; author: string; at: number };
export type Stash = { ref: string; subject: string };
export type Operation = 'rebase' | 'merge' | 'cherry-pick' | 'revert';

export const ROWS = 200;
export const COMMITS = 100;
export const READ = ['--no-optional-locks'];
export const DIFF = ['diff', '--no-color', '--no-ext-diff', '--no-textconv', '--src-prefix=a/', '--dst-prefix=b/'];
export const AUTH = /could not read (username|password)|terminal prompts disabled|permission denied \(publickey|passphrase|authentication failed|host key verification failed/i;
export const REJECTED = /\(non-fast-forward\)|tip of your current branch is behind/;
export const OPERATIONS: [string, Operation][] = [
  ['rebase-merge', 'rebase'], ['rebase-apply', 'rebase'], ['MERGE_HEAD', 'merge'], ['CHERRY_PICK_HEAD', 'cherry-pick'], ['REVERT_HEAD', 'revert'],
];
export const DOING: Record<Operation, string> = { rebase: 'Rebasing', merge: 'Merging', 'cherry-pick': 'Cherry-picking', revert: 'Reverting' };

const PATH_FIELD = { '1': 8, '2': 9, u: 10 } as const;
const UNITS = [[31_536_000, 'year'], [2_592_000, 'month'], [604_800, 'week'], [86_400, 'day'], [3_600, 'hour'], [60, 'minute'], [1, 'second']] as const;
const encoder = new TextEncoder();

export const size = (value: unknown) => encoder.encode(JSON.stringify(value)).length;
export const cut = (text: string, bytes: number) => {
  const clean = text.replace(/\r/g, '').replace(/\t/g, '    ').replace(/[\u0000-\u001f\u007f-\u009f]/g, '?');
  return encoder.encode(clean).length <= bytes ? clean : clean.slice(0, encoder.encodeInto(clean, new Uint8Array(bytes)).read);
};
export const quote = (text: string) => "'" + text.replaceAll("'", "'\\''") + "'";

export const ago = (at: number, now: number) => {
  const seconds = Math.max(0, Math.floor(now / 1000 - at));
  for (const [length, unit] of UNITS) {
    const count = Math.floor(seconds / length);
    if (count > 0) return `${count} ${unit}${count === 1 ? '' : 's'} ago`;
  }
  return '0 seconds ago';
};

export const mention = (path: string) => {
  const quoted = /\s|["\\]/.test(path) || /[,.;:!?)\]}'"`]$/.test(path);
  return `@${quoted ? JSON.stringify(path) : path} `;
};

export const summary = (text: string) => {
  const lines = text.split('\n').map(line => line.trim()).filter(Boolean);
  const errors = lines.filter(line => /^(error|fatal):/.test(line));
  const hints = lines.filter(line => line.startsWith('hint:'));
  const rest = lines.filter(line => !errors.includes(line) && !hints.includes(line));
  return [...errors, ...rest, ...hints].join(' ');
};

export const parseStatus = (out: string, truncated = false): { head: Head; files: Change[]; more: boolean } => {
  const records = out.split('\0');
  if (truncated) records.pop();
  const field = (key: string) => records.find(record => record.startsWith(`# branch.${key} `))?.slice(`# branch.${key} `.length) ?? '';
  const branch = field('head');
  const ab = field('ab');
  const [ahead = 0, behind = 0] = ab.split(' ').filter(Boolean).map(part => Number(part.replace(/^[+-]/, '')));
  const head: Head = { branch: branch === '(detached)' ? '' : branch, upstream: field('upstream'), ab: ab ? { ahead, behind } : null };
  const files: Change[] = [];
  for (let index = 0; index < records.length; index++) {
    const record = records[index];
    const kind = record[0];
    if (kind === '?') files.push({ path: record.slice(2), kind, x: '?', y: '?' });
    else if (kind === '1' || kind === 'u' || (kind === '2' && index + 1 < records.length)) {
      const change: Change = { path: record.split(' ').slice(PATH_FIELD[kind]).join(' '), kind, x: record[2].replace('.', ' '), y: record[3].replace('.', ' ') };
      if (kind === '2') change.orig = records[++index];
      files.push(change);
    }
  }
  return { head, files: files.slice(0, ROWS), more: truncated || files.length > ROWS };
};

export const headline = ({ branch, upstream, ab }: Head) => {
  const name = branch || 'HEAD (detached)';
  if (!upstream) return name;
  if (!ab) return `${name} → ${upstream} (gone)`;
  const counts = ab.ahead || ab.behind ? ` ↑${ab.ahead} ↓${ab.behind}` : '';
  return `${name} → ${upstream}${counts}`;
};

export const parseBranches = (out: string): Branch[] => out.split('\n').filter(Boolean).map(line => {
  const [head, name, track = ''] = line.split('\0');
  return { name, head: head === '*', track: track.trim() };
});
export const parseCommits = (out: string): Commit[] => out.split('\n').filter(Boolean).map(line => {
  const [sha, subject, author, at] = line.split('\0');
  return { sha, subject, author, at: Number(at) };
});
export const parseStash = (out: string): Stash[] => out.split('\n').filter(Boolean).map(line => {
  const [ref, subject] = line.split('\0');
  return { ref, subject };
});

export const operationOf = (found: string): Operation | null => {
  const names = new Set(found.split('\n').map(path => path.split('/')[0]));
  return OPERATIONS.find(([name]) => names.has(name))?.[1] ?? null;
};

export const splitPatch = (out: string, truncated: boolean) => {
  const [head, ...parts] = out.split(/^(?=@@ )/m);
  if (truncated) parts.pop();
  return { head, parts: parts.map(part => (part.endsWith('\n') ? part : `${part}\n`)), binary: /^(Binary files |GIT binary patch)/m.test(head) };
};
