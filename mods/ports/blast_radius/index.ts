import type { ExecResult, ModAPI } from '@oh-my-diff/mod-api';

type Kind = 'rm' | 'reset' | 'clean' | 'push' | 'checkout' | 'migrate';
type Risk = { kind: Kind; label: string; args: string[]; dir: string | null; tool?: string };
type Report = { summary: string; lines: string[]; more: number; note: string };

const LIST_MAX = 10;
const ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/;
const PREFIXES = new Set(['command', 'exec', 'env', 'nohup', 'time', 'then', 'do', 'else', '!']);
const SUDO_VALUE = new Set(['-u', '-g', '-C', '-D', '-h', '-p', '-r', '-t', '-T', '-U']);
const READ_ONLY = new Set(['ls', 'cat', 'echo', 'printf', 'grep', 'rg', 'find', 'less', 'head', 'tail', 'cd', 'git']);

const RM_SCRIPT = [
  'shopt -s nullglob dotglob',
  'p=()',
  'for a; do',
  '  if [[ $a == *[*?[]* ]]; then while IFS= read -r m; do p+=("$m"); done < <(compgen -G "$a")',
  '  elif [[ -e $a || -L $a ]]; then p+=("$a"); fi',
  'done',
  '(( ${#p[@]} )) || { echo 0 0 0; exit; }',
  'for i in "${!p[@]}"; do [[ ${p[i]} == /* ]] || p[i]=./${p[i]}; done',
  'echo "$(find "${p[@]}" ! -type d | wc -l) $(du -skc "${p[@]}" 2>/dev/null | tail -n1 | cut -f1) ${#p[@]}"',
  `find "\${p[@]}" ! -type d 2>/dev/null | head -n ${LIST_MAX}`,
].join('\n');

const MIGRATIONS: Record<string, { argv: string[]; pending: (line: string) => boolean }> = {
  django: { argv: ['python3', 'manage.py', 'showmigrations', '--plan'], pending: line => line.startsWith('[ ]') },
  alembic: { argv: ['alembic', 'history', '-r', 'current:head'], pending: line => line.includes('->') },
  rails: { argv: ['bundle', 'exec', 'rails', 'db:migrate:status'], pending: line => /^\s*down\b/.test(line) },
  prisma: { argv: ['pnpm', 'exec', 'prisma', 'migrate', 'status'], pending: line => /^\s{2}\S/.test(line) },
};

const tokenize = (text: string) => Array.from(text.matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g), m => m[1] ?? m[2] ?? m[3]);

const joinDir = (dir: string | null, arg: string | undefined) =>
  arg === undefined || arg === '~' || arg.startsWith('/') || arg.startsWith('~/') ? arg ?? '~' : dir ? `${dir}/${arg}` : arg;

const normalize = (path: string) => {
  const parts: string[] = [];
  for (const part of path.split('/')) {
    if (part === '..') parts.pop();
    else if (part && part !== '.') parts.push(part);
  }
  return `/${parts.join('/')}`;
};

function segment(text: string, dir: string | null, pushed: (string | null)[]): Risk | { cd: string } | null {
  const words = tokenize(text.trim().replace(/^[({]+\s*/, '').replace(/\s*[)}]+$/, ''));
  while (ASSIGN.test(words[0] ?? '')) words.shift();
  if (words[0] === 'sudo') {
    words.shift();
    while (words[0]?.startsWith('-')) if (SUDO_VALUE.has(words.shift()!)) words.shift();
  }
  while (words.length && (PREFIXES.has(words[0]) || ASSIGN.test(words[0]))) words.shift();
  const [first, ...args] = words;
  if (first === undefined) return null;
  const cmd = first.replace(/^\\/, '');
  if (cmd === 'cd') return { cd: args[0] === '-' ? '-' : joinDir(dir, args[0]) };
  if (cmd === 'pushd') {
    pushed.push(dir);
    return { cd: joinDir(dir, args[0]) };
  }
  if (cmd === 'popd') return { cd: pushed.length ? pushed.pop() ?? '~' : '-' };
  if (cmd === 'rm' || cmd.endsWith('/rm')) {
    const flags = args.filter(a => a.startsWith('-'));
    const short = (letter: string) => flags.some(f => /^-[^-]/.test(f) && f.includes(letter));
    if (flags.includes('--recursive') || short('r') || short('R') || flags.includes('--force') || short('f')) {
      return { kind: 'rm', label: `rm ${flags.join(' ')}`.trim(), args: args.filter(a => !a.startsWith('-') || a === '-'), dir };
    }
  }
  if (cmd === 'git') {
    let gitDir = dir;
    let i = 0;
    while (i < args.length && args[i].startsWith('-')) {
      if (args[i] === '-C' && i + 1 < args.length) gitDir = joinDir(gitDir, args[i + 1]);
      i += (args[i] === '-C' || args[i] === '-c') && i + 1 < args.length ? 2 : 1;
    }
    const sub = args[i];
    const rest = args.slice(i + 1);
    if (sub === 'reset' && rest.includes('--hard')) return { kind: 'reset', label: 'git reset --hard', args: rest, dir: gitDir };
    if (sub === 'clean') return { kind: 'clean', label: 'git clean', args: rest, dir: gitDir };
    if (sub === 'push' && rest.some(a => a === '--force' || a === '-f' || a.startsWith('--force-with-lease') || a.startsWith('+'))) {
      return { kind: 'push', label: 'git push --force', args: rest, dir: gitDir };
    }
    const stagedOnly = sub === 'restore' && rest.includes('--staged') && !rest.includes('--worktree') && !rest.includes('-W');
    if ((sub === 'checkout' || sub === 'restore') && rest.includes('.') && !stagedOnly) {
      return { kind: 'checkout', label: `git ${sub} -- .`, args: rest, dir: gitDir };
    }
  }
  const joined = words.join(' ');
  const tool = /\balembic\s+upgrade\b/.test(joined) ? 'alembic'
    : /\bdb:migrate(?!:status\b)/.test(joined) ? 'rails'
    : /\bprisma\s+migrate\b/.test(joined) ? 'prisma'
    : /\bmanage\.py\s+migrate\b/.test(joined) ? 'django'
    : !READ_ONLY.has(cmd) && args.includes('migrate') ? 'unknown' : null;
  return tool ? { kind: 'migrate', label: `${tool} migrate`, args: [], dir, tool } : null;
}

function classify(command: string): Risk | null {
  let dir: string | null = null;
  const scopes: (string | null)[] = [];
  const pushed: (string | null)[] = [];
  for (const raw of command.split(/&&|\|\||;|\||\n/)) {
    const opens = raw.match(/^\s*\(+/)?.[0].trim().length ?? 0;
    const closes = raw.replace(/(?:\s*(?:\d*>>?|&>>?|<)\s*\S+|\s*&)+\s*$/, '').match(/\)+\s*$/)?.[0].trim().length ?? 0;
    for (let i = 0; i < opens; i += 1) scopes.push(dir);
    const found = segment(raw, dir, pushed);
    if (found && 'kind' in found) return found;
    if (found) dir = found.cd;
    for (let i = 0; i < closes && scopes.length; i += 1) dir = scopes.pop() ?? null;
  }
  return null;
}

const size = (kb: number) => {
  const units = ['KB', 'MB', 'GB', 'TB'];
  let n = kb;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i += 1;
  }
  return `${n.toFixed(n < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
};

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

export default function activate(api: ModAPI) {
  const run = (cwd: string | undefined, program: string, argv: string[], timeout_ms = 10_000): ExecResult =>
    api.host.call('exec.run', { program, argv, cwd, timeout_ms });
  const out = (result: ExecResult, program: string) => {
    if (result.exit_code !== 0) throw new Error(result.stderr.trim() || `${program} exited ${result.exit_code}`);
    return result.stdout;
  };
  const git = (cwd: string | undefined, ...argv: string[]) => out(run(cwd, 'git', ['--no-optional-locks', ...argv]), 'git');
  const listed = (items: string[], summary: string, note: string): Report =>
    ({ summary, lines: items.slice(0, LIST_MAX), more: Math.max(0, items.length - LIST_MAX), note });

  const folder = (workdir: string | undefined, dir: string | null) => {
    if (dir === '-' || dir?.startsWith('~')) throw new Error(`cannot follow cd ${dir}`);
    const root = out(run(undefined, 'pwd', []), 'pwd').trim();
    const step = (base: string, next: string | null | undefined) => normalize(next ? (next.startsWith('/') ? next : `${base}/${next}`) : base);
    const target = step(step(root, workdir), dir);
    if (target !== root && !target.startsWith(`${root}/`)) throw new Error(`${target} is outside the repository`);
    return target === root ? undefined : target.slice(root.length + 1);
  };

  const measureRm = (targets: string[], cwd: string | undefined): Report => {
    if (!targets.length) return { summary: 'rm with no paths', lines: [], more: 0, note: 'No paths to expand.' };
    if (targets.some(t => /^~|[$`]/.test(t))) throw new Error('a path uses ~ or a shell expansion');
    const [head, ...rest] = out(run(cwd, 'bash', ['-c', RM_SCRIPT, 'blast-radius', ...targets]), 'bash').split('\n').filter(Boolean);
    const [files, kb, found] = head.trim().split(/\s+/).map(Number);
    const note = `Paths: ${targets.join(' ')}`;
    if (!found) return { summary: `delete nothing: no file matches ${targets.join(' ')}`, lines: [], more: 0, note: "The paths don't exist, so rm has nothing to remove." };
    if (!files) return { summary: `delete ${plural(found, 'path')} with no files in ${found === 1 ? 'it' : 'them'}`, lines: [], more: 0, note };
    return { summary: `delete ${plural(files, 'file')} (about ${size(kb || 0)})`, lines: rest.map(l => l.replace(/^\.\//, '')), more: Math.max(0, files - rest.length), note };
  };

  const measureDiscard = (risk: Risk, cwd: string | undefined): Report => {
    const rows = git(cwd, 'status', '--porcelain').split('\n').filter(l => l.length > 3 && !l.startsWith('??'));
    const lost = risk.kind === 'reset' ? rows : rows.filter(l => l[1] !== ' ');
    const stat = run(cwd, 'git', ['diff', '--shortstat', risk.kind === 'reset' ? 'HEAD' : '--']).stdout.trim();
    return listed(
      lost.map(l => `${l.slice(0, 2)} ${l.slice(3)}`),
      lost.length ? `discard uncommitted changes in ${plural(lost.length, 'file')}` : 'discard nothing: no uncommitted changes',
      stat ? `${stat}. Uncommitted changes can't be recovered.` : 'From git status --porcelain.',
    );
  };

  const measureClean = (args: string[], cwd: string | undefined): Report => {
    const flags: string[] = [];
    const paths: string[] = [];
    for (let i = 0; i < args.length; i += 1) {
      const a = args[i];
      if (a === '--') {
        paths.push(...args.slice(i + 1));
        break;
      }
      if (a === '-e' || a === '--exclude') {
        flags.push(a, args[i + 1] ?? '');
        i += 1;
      } else if (a.startsWith('--exclude=') || /^-e./.test(a)) flags.push(a);
      else if (/^-[a-zA-Z]+$/.test(a)) {
        const kept = a.replace(/[finq]/g, '');
        if (kept !== '-') flags.push(kept);
      } else if (!a.startsWith('-')) paths.push(a);
    }
    const gone = git(cwd, 'clean', '-n', ...flags, '--', ...paths).split('\n').filter(l => l.startsWith('Would remove ')).map(l => l.slice(13));
    return listed(
      gone,
      gone.length ? `remove ${plural(gone.length, 'untracked path')}` : 'remove nothing: no untracked files match',
      "From git clean -n. Untracked files are not in git, so they can't be recovered.",
    );
  };

  const measurePush = (args: string[], cwd: string | undefined): Report => {
    const positional = args.filter(a => !a.startsWith('-'));
    const remote = positional[0] ?? 'origin';
    const spec = (positional[1] ?? '').replace(/^\+/, '');
    let [source, branch = spec] = spec.includes(':') ? spec.split(':') : [spec, spec];
    branch = branch.replace(/^refs\/heads\//, '');
    if (!branch || branch === 'HEAD') {
      branch = git(cwd, 'rev-parse', '--abbrev-ref', 'HEAD').trim();
      source = 'HEAD';
    }
    source ||= 'HEAD';
    const ref = `${remote}/${branch}`;
    if (run(cwd, 'git', ['rev-parse', '--verify', '--quiet', ref]).exit_code !== 0) {
      return { summary: `force-push to ${ref}`, lines: [], more: 0, note: `No local copy of ${ref}, so I can't tell which commits the push would drop. Run git fetch first.` };
    }
    const dropped = git(cwd, 'log', '--oneline', '--no-decorate', `${source}..${ref}`).split('\n').filter(Boolean);
    return listed(
      dropped,
      dropped.length ? `force-push to ${ref}: drops ${plural(dropped.length, 'commit')}` : `force-push to ${ref}: drops no commits`,
      `Commits on ${ref} that ${source} doesn't have, as of the last fetch.`,
    );
  };

  const measureMigrations = (risk: Risk, cwd: string | undefined): Report => {
    const lister = MIGRATIONS[risk.tool ?? ''];
    if (!lister) return { summary: 'run migrations', lines: [], more: 0, note: "I can't list the pending migrations for this tool, so the list is not shown." };
    const [program, ...argv] = lister.argv;
    const pending = out(run(cwd, program, argv, 20_000), program).split('\n').filter(lister.pending).map(l => l.replace(/^\[ \]\s*/, '').trim());
    return listed(
      pending,
      pending.length ? `apply ${plural(pending.length, 'pending migration')}` : `run ${risk.label}: nothing pending`,
      `From ${lister.argv.join(' ')}.`,
    );
  };

  const measure = (risk: Risk, workdir: string | undefined): Report => {
    try {
      const cwd = folder(workdir, risk.dir);
      if (risk.kind === 'rm') return measureRm(risk.args, cwd);
      if (risk.kind === 'migrate') return measureMigrations(risk, cwd);
      if (risk.kind === 'clean') return measureClean(risk.args, cwd);
      if (risk.kind === 'push') return measurePush(risk.args, cwd);
      return measureDiscard(risk, cwd);
    } catch (error) {
      return { summary: `${risk.label} (could not measure it)`, lines: [], more: 0, note: `Could not measure: ${String((error as Error)?.message ?? error).slice(0, 200)}` };
    }
  };

  api.intercept('tool', { match: { tool: 'exec_command' }, required: true }, async (e, next) => {
    const args = e.arguments as { cmd?: string; workdir?: string };
    const command = String(args.cmd ?? '');
    const risk = classify(command);
    if (!risk) return next(e);
    const report = measure(risk, args.workdir);
    const message = [
      `Command: ${command.replace(/\s+/g, ' ').slice(0, 200)}`,
      `Would ${report.summary}`,
      report.note,
      ...(report.lines.length ? [[...report.lines.map(line => line.trim().slice(0, 100)), ...(report.more ? [`+ ${report.more} more`] : [])].join(', ')] : []),
    ].filter(Boolean).map(part => part.replace(/[^\x20-\x7e]/g, '?')).join(' · ').slice(0, 1890);
    const answer = api.host.tryCall('terminal.prompt', { kind: 'confirm', title: `Blast Radius: proceed with ${risk.label}?`.slice(0, 100), message });
    if (answer.ok && answer.value.status === 'accepted') return next(e);
    const why = answer.ok ? 'the user declined' : 'the question could not be asked';
    return { deny: `Blast Radius held this command and did not run it: ${why}. It would have: ${report.summary}. Do not retry it unless the user asks you to.` };
  });
}
