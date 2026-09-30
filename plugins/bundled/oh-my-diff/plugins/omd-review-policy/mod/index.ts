import type { ModAPI } from '@oh-my-diff/mod-api';

type Scope = { path: string; added: boolean; renamed: boolean; lines: [number, number][] };

const HEADERS = `d=$(git -c core.quotePath=false diff --unified=0 --no-color --no-ext-diff --find-renames --src-prefix=a/ --dst-prefix=b/ "$@") || exit
printf '%s\\n' "$d" | grep -E '^(diff --git |[+]{3} |@@ |new file mode|rename to )' || true`;

function parse(headers: string): Scope[] {
  const files: Scope[] = [];
  let added = false, renamed = false, current: Scope | undefined;
  for (const line of headers.split('\n')) {
    if (line.startsWith('diff --git ')) [added, renamed, current] = [false, false, undefined];
    else if (line.startsWith('new file mode')) added = true;
    else if (line.startsWith('rename to ')) renamed = true;
    else if (line.startsWith('+++ b/')) files.push(current = { path: line.slice(6).replace(/\t$/, ''), added, renamed, lines: [] });
    else if (current && line.startsWith('@@ ')) {
      const [, start, count = '1'] = /^@@ -\S+ \+(\d+)(?:,(\d+))? @@/.exec(line) ?? [];
      if (!start || count === '0') continue;
      const [from, to] = [Number(start), Number(start) + Number(count) - 1];
      const last = current.lines.at(-1);
      if (last && from <= last[1] + 1) last[1] = Math.max(last[1], to);
      else current.lines.push([from, to]);
    }
  }
  return files.filter(file => file.added || file.lines.length);
}

function describe(file: Scope): string {
  if (file.added) return `- ${file.path}: new file (all lines)`;
  const lines = file.lines.map(([from, to]) => from === to ? `${from}` : `${from}-${to}`).join(', ');
  return `- ${file.path}: ${file.renamed ? 'renamed; ' : ''}lines ${lines}`;
}

export default function activate(api: ModAPI) {
  const git = (program: string, argv: string[]): string | { display: string } => {
    const run = api.host.tryCall('exec.run', { program, argv, timeout_ms: 30_000 });
    if (!run.ok) return { display: `/simplify is unavailable: ${run.error}` };
    if (run.value.exit_code !== 0) return { display: `git failed: ${run.value.stderr.trim().split('\n')[0] || `exit ${run.value.exit_code}`}` };
    if (run.value.stdout_preview_truncated) return { display: 'The diff is too large for /simplify. Name files or choose a narrower scope.' };
    return run.value.stdout;
  };

  api.command('simplify', value => {
    const files: string[] = [];
    let staged = false, ref: string | undefined;
    for (const token of (typeof value === 'string' ? value : '').split(/\s+/).filter(Boolean)) {
      if (token === '--staged') staged = true;
      else if (token.startsWith('--ref=') && /^[\w./@^~][\w./@^~-]{0,127}$/.test(token.slice(6))) ref = token.slice(6);
      else if (token.startsWith('-')) return { display: 'Usage: /simplify [--staged | --ref=<branch>] [file ...]' };
      else files.push(token);
    }
    if (staged && ref) return { display: 'Use either --staged or --ref=<branch>, not both.' };
    const base = staged ? ['--cached'] : ref ? ['--merge-base', ref] : ['HEAD'];
    const headers = git('sh', ['-c', HEADERS, 'sh', ...base, '--', ...files]);
    if (typeof headers !== 'string') return headers;
    const scope = parse(headers);
    if (!staged) {
      const untracked = git('git', ['ls-files', '--others', '--exclude-standard', '-z', '--', ...files]);
      if (typeof untracked !== 'string') return untracked;
      scope.push(...untracked.split('\0').filter(Boolean).map(path => ({ path, added: true, renamed: false, lines: [] })));
    }
    const label = `${staged ? 'staged changes' : ref ? `changes since the merge base with ${ref}` : 'uncommitted changes'}${files.length ? ' in the named files' : ''}`;
    if (!scope.length) return { display: `No changed lines to simplify in ${label}.` };
    const listed = scope.slice(0, 40).map(describe);
    if (scope.length > 40) listed.push(`- ${scope.length - 40} more files; list them with git.`);
    return { submit: `$omd-review-policy:omd-simplify\n\nChanged lines in scope (${label}):\n${listed.join('\n')}` };
  }, { description: 'Simplify changed lines without changing behavior' });
}
