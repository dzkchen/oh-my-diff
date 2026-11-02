import type { Json, ModAPI } from '../../api.d.ts';

type State = { known: string[]; held: string[] };
type Listing = Map<string, string>;

const SEEN = 512;
const FILES = 8;
const FILE_BYTES = 800;
const FEEDBACK_BYTES = 4000;
const NEW = 'new file: ';
const PATCH = /^\*\*\* (Add|Update) File: (.+)$|^\*\*\* Move to: (.+)$/gm;
const PY = 'import ast,sys\ntry: ast.parse(open(sys.argv[1],"rb").read(),sys.argv[1])\nexcept SyntaxError as e: print(f"{sys.argv[1]}:{e.lineno}:{e.offset}: SyntaxError: {e.msg}"); sys.exit(1)';
const JSON_PY = 'import json,sys\ntry: json.load(open(sys.argv[1],encoding="utf-8"))\nexcept ValueError as e: print(f"{sys.argv[1]}: {e}"); sys.exit(1)';
const CHECKERS: [RegExp, string[]][] = [
  [/\.pyw?$/, ['python3', '-c', PY]],
  [/\.json$/, ['python3', '-c', JSON_PY]],
  [/\.[cm]?js$/, ['node', '--check']],
  [/\.(sh|bash)$/, ['bash', '-n']],
  [/\.rb$/, ['ruby', '-c']],
  [/\.php$/, ['php', '-l']],
  [/\.go$/, ['gofmt', '-l', '-e']],
];
// $1 file, $2 extension; exit 0 parses, 3 fails while its HEAD version parses, 5 fails at HEAD too, 6 fails with no HEAD version, 4 skipped.
const SCRIPT = `f=$1 x=$2; shift 2
[ -f "$f" ] && [ "$(wc -c < "$f")" -le 1048576 ] && command -v "$1" >/dev/null 2>&1 || exit 4
out=$("$@" "$f" 2>&1) && exit 0
printf '%s' "$out"
d=$(mktemp -d "\${TMPDIR:-/tmp}/omd_edit_guard.XXXXXX") || exit 5
trap 'rm -rf "$d"' EXIT
git show "HEAD:./$f" > "$d/base$x" 2>/dev/null || exit 6
"$@" "$d/base$x" >/dev/null 2>&1 && exit 3
exit 5`;
const SHELL = /^(exec_command|shell|shell_command|local_shell)$/;
const CHANGED = `git rev-parse --git-dir >/dev/null 2>&1 || exit 4
l=$({ git -c core.quotepath=off ls-files -m | sed 's/^/M /'; git -c core.quotepath=off ls-files -o --exclude-standard | sed 's/^/A /'; } | grep -E '[.](pyw?|json|[cm]?js|sh|bash|rb|php|go)$' | head -200 | while IFS= read -r l; do [ -f "\${l#??}" ] && printf '%s\\n' "$l"; done)
[ -n "$l" ] || exit 0
printf '%s\\n--\\n' "$l"
printf '%s\\n' "$l" | cut -c3- | git hash-object --stdin-paths`;
const NOISE = /^\s+at .*$|^Node\.js v.*$|^\(Use `node .*$|^\(node:\d+\) Warning:.*$|^Errors parsing .*$|^No syntax errors.*$/gm;

const EDIT_TOOL = /^apply_patch$|(^|_)(edit|write|create|replace)(_file|_editor)?$/;
const QUOTED = /'[^']*'|"(?:[^"\\]|\\.)*"/g;
const REDIRECT = /(?<![\d=<>&-])>>?\s*(?!&)([^\s;&|<>()]+)/g;
const WRITER = /(?:^|\s)(tee|cp|mv|sed|perl)\s+(.*)$/s;
const IN_PLACE = /(?:^|\s)-[a-zA-Z]*i[\w.]*(?=\s|$)/;
const UNSEEN_WRITE = /<<|\.write\(|write_text\(|writeFile/;
function writes(cmd: string): { created: string[]; changed: string[]; unseen: boolean } {
  const plain = cmd.replace(QUOTED, "''");
  const created = [...plain.matchAll(REDIRECT)].map(match => match[1]).filter(path => path !== '/dev/null');
  const changed: string[] = [];
  let unseen = UNSEEN_WRITE.test(cmd);
  for (const part of plain.split(/&&|\|\||[;|\n]/)) {
    const [, tool, rest = ''] = WRITER.exec(part.trim()) ?? [];
    const words = rest.split(/\s+/).filter(word => word && !word.startsWith('-'));
    const files = (tool === 'sed' && !/(?:^|\s)-[ef]\b/.test(rest) ? words.slice(1) : words).filter(word => word !== "''");
    if (tool === 'tee') created.push(...files);
    else if ((tool === 'cp' || tool === 'mv') && files.length > 1) changed.push(files[files.length - 1]);
    else if ((tool === 'sed' || tool === 'perl') && IN_PLACE.test(rest)) { changed.push(...files); unseen ||= !files.length; }
  }
  const named = (paths: string[]) => paths.filter(path => /^[\w./-]+$/.test(path));
  unseen ||= named(created).length < created.length || named(changed).length < changed.length;
  return { created: named(created), changed: named(changed), unseen };
}

const strings = (value: Json): string[] => typeof value === 'string' ? [value] : Array.isArray(value) ? value.flatMap(strings) : value && typeof value === 'object' ? Object.values(value).flatMap(strings) : [];
const field = (value: Json, key: string): Json => value && typeof value === 'object' && !Array.isArray(value) ? value[key] ?? null : null;
const command = (args: Json) => {
  const value = typeof args === 'string' ? args : field(args, 'cmd') ?? field(args, 'command');
  return typeof value === 'string' ? value : Array.isArray(value) ? value.filter(item => typeof item === 'string').join(' ') : '';
};
const clip = (text: string, bytes: number) => {
  while (new TextEncoder().encode(text).length > bytes) text = text.slice(0, Math.floor(text.length * 0.9));
  return text;
};

function edits(tool: string, args: Json): string[] {
  if (tool === 'apply_patch') return [...new Set([...strings(args).join('\n').matchAll(PATCH)].map(match => (match[2] ?? match[3]).trim()))];
  if (!EDIT_TOOL.test(tool)) return [];
  const files = field(args, 'files');
  const paths = [field(args, 'path'), field(args, 'file_path'), ...(Array.isArray(files) ? files.map(file => field(file, 'path')) : [])];
  return paths.filter((path): path is string => typeof path === 'string');
}

function relative(path: string, root: string, cwd: string): string | null {
  if (path.split('/').includes('..')) return null;
  if (path.startsWith('/')) return path.startsWith(`${root}/`) ? path.slice(root.length + 1) : null;
  const local = path.replace(/^\.\//, '');
  if (cwd === root) return local;
  return cwd.startsWith(`${root}/`) ? `${cwd.slice(root.length + 1)}/${local}` : null;
}

export default function activate(api: ModAPI) {
  const listing = (): Listing | null => {
    const run = api.host.tryCall('exec.run', { program: 'sh', argv: ['-c', CHANGED], timeout_ms: 3000, max_output_bytes: 65_536 });
    if (!run.ok || run.value.timed_out || run.value.exit_code !== 0) return null;
    const [list = '', hashes = ''] = run.value.stdout.split('\n--\n');
    const ids = hashes.split('\n');
    return new Map(list.split('\n').filter(Boolean).map((line, index) => [line.slice(2), `${line[0]} ${ids[index] ?? ''}`]));
  };

  const check = (found: [string, boolean][], state: State) => {
    const { root, cwd } = api.session();
    const targets = found.flatMap(([given, rooted]) => {
      const path = rooted ? given : relative(given, root, cwd);
      const checker = path && CHECKERS.find(([pattern]) => pattern.test(path))?.[1];
      return path && checker ? [{ path, checker }] : [];
    }).slice(0, FILES);
    const reports: string[] = [];
    for (const { path, checker } of targets) {
      const run = api.host.tryCall('exec.run', { program: 'sh', argv: ['-c', SCRIPT, 'sh', path, path.slice(path.lastIndexOf('.')), ...checker], timeout_ms: 3000, max_output_bytes: 16_384 });
      if (!run.ok || run.value.timed_out) continue;
      const code = run.value.exit_code;
      const known = state.known.includes(path);
      const text = () => clip(run.value.stdout.replaceAll(`${root}/`, '').replace(NOISE, '').replace(/\n{2,}/g, '\n').trim(), FILE_BYTES);
      state.known = state.known.filter(entry => entry !== path);
      const failed = code === 5 || code === 6;
      if (code === 0 || code === 3 || (failed && known)) state.known = [...state.known, path].slice(-SEEN);
      if (code === 3 || (failed && known)) reports.push(text());
      else if (code === 6) reports.push(`${NEW}${text()}`);
    }
    return reports;
  };

  api.intercept('tool', async (e, next) => {
    const caller = next.origin?.caller;
    if (caller !== 'model' && caller !== 'code_mode') return next(e);
    const cmd = SHELL.test(e.tool) ? command(e.arguments) : null;
    const write = cmd === null ? null : writes(cmd);
    const elsewhere = cmd !== null && (/(?:^|[\s;&|(])(?:cd|pushd)\s/.test(cmd) || typeof field(e.arguments, 'workdir') === 'string');
    const named = write && !write.unseen && !elsewhere ? [...write.created, ...write.changed] : [];
    const before = write && (write.unseen || (elsewhere && write.created.length + write.changed.length > 0)) ? listing() : null;
    const result = await next(e);
    const after = before && result.success ? listing() : null;
    const found: [string, boolean][] = !result.success ? []
      : after && before ? [...after].filter(([path, id]) => before.get(path) !== id).map(([path]) => [path, true])
        : [...named, ...edits(e.tool, e.arguments)].map(path => [path, false]);
    const loaded: State = { known: [], held: [], ...(api.state.get() as Partial<State> | null) };
    const state = { ...loaded };
    const reports = found.length ? check(found, state) : [];
    const held = caller === 'code_mode' ? [...state.held, ...reports].slice(-FILES) : [];
    if (JSON.stringify([state.known, held]) !== JSON.stringify([loaded.known, loaded.held])) api.state.set({ known: state.known, held } as unknown as Json);
    const all = caller === 'model' ? [...state.held, ...reports] : [];
    const introduced = all.filter(entry => !entry.startsWith(NEW));
    const fresh = all.filter(entry => entry.startsWith(NEW)).map(entry => entry.slice(NEW.length));
    const notes = [
      ...(introduced.length ? [`[omd_edit_guard] This edit introduced a syntax error (the file parsed before). Fix it now, unless it is newer syntax than this checker's version accepts:\n${introduced.join('\n')}`] : []),
      ...(fresh.length ? [`[omd_edit_guard] A new file fails its syntax check. Fix it if the error is real; leave it if the file uses syntax this checker doesn't accept (JSONC, JSX, a newer language version):\n${fresh.join('\n')}`] : []),
    ];
    if (!notes.length) return result;
    return { ...result, output: `${result.output}\n\n${clip(notes.join('\n\n'), FEEDBACK_BYTES)}` };
  });
}
