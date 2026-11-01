import type { Json, ModAPI } from '../../api.d.ts';

type State = { known: string[]; held: string[] };

const SEEN = 512;
const FILES = 8;
const FILE_BYTES = 800;
const FEEDBACK_BYTES = 4000;
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
// $1 file, $2 extension, $3 1 when the file parsed before or was already reported; exit 3 reports, 4 skips.
const SCRIPT = `f=$1 x=$2 t=$3; shift 3
[ -f "$f" ] && [ "$(wc -c < "$f")" -le 1048576 ] && command -v "$1" >/dev/null 2>&1 || exit 4
out=$("$@" "$f" 2>&1) && exit 0
if [ "$t" != 1 ]; then
  b="\${TMPDIR:-/tmp}/omd_edit_guard_base$x"
  git show "HEAD:./$f" > "$b" 2>/dev/null || exit 4
  "$@" "$b" >/dev/null 2>&1 || exit 4
fi
printf '%s' "$out"; exit 3`;
const NOISE = /^\s+at .*$|^Node\.js v.*$|^\(Use `node .*$|^\(node:\d+\) Warning:.*$|^Errors parsing .*$|^No syntax errors.*$/gm;

const strings = (value: Json): string[] => typeof value === 'string' ? [value] : Array.isArray(value) ? value.flatMap(strings) : value && typeof value === 'object' ? Object.values(value).flatMap(strings) : [];
const field = (value: Json, key: string): Json => value && typeof value === 'object' && !Array.isArray(value) ? value[key] ?? null : null;
const clip = (text: string, bytes: number) => {
  while (new TextEncoder().encode(text).length > bytes) text = text.slice(0, Math.floor(text.length * 0.9));
  return text;
};

function edits(tool: string, args: Json): [string, boolean][] {
  if (tool === 'apply_patch') {
    const found = new Map<string, boolean>();
    for (const match of strings(args).join('\n').matchAll(PATCH)) found.set((match[2] ?? match[3]).trim(), match[1] !== 'Update');
    return [...found];
  }
  if (!/(^|_)(edit|write|create)(_file)?$/.test(tool)) return [];
  const files = field(args, 'files');
  const paths = [field(args, 'path'), field(args, 'file_path'), ...(Array.isArray(files) ? files.map(file => field(file, 'path')) : [])];
  return paths.filter((path): path is string => typeof path === 'string').map(path => [path, false]);
}

function relative(path: string, root: string, cwd: string): string | null {
  if (path.split('/').includes('..')) return null;
  if (path.startsWith('/')) return path.startsWith(`${root}/`) ? path.slice(root.length + 1) : null;
  const local = path.replace(/^\.\//, '');
  if (cwd === root) return local;
  return cwd.startsWith(`${root}/`) ? `${cwd.slice(root.length + 1)}/${local}` : null;
}

export default function activate(api: ModAPI) {
  const check = (tool: string, args: Json, state: State) => {
    const found = edits(tool, args);
    if (!found.length) return [];
    const { root, cwd } = api.session();
    const reports: string[] = [];
    for (const [given, added] of found.slice(0, FILES)) {
      const path = relative(given, root, cwd);
      const checker = path && CHECKERS.find(([pattern]) => pattern.test(path))?.[1];
      if (!path || !checker) continue;
      const known = added || state.known.includes(path);
      const run = api.host.tryCall('exec.run', { program: 'sh', argv: ['-c', SCRIPT, 'sh', path, path.slice(path.lastIndexOf('.')), known ? '1' : '0', ...checker], timeout_ms: 3000, max_output_bytes: 16_384 });
      if (!run.ok || run.value.timed_out) continue;
      state.known = state.known.filter(entry => entry !== path);
      if (run.value.exit_code === 0 || run.value.exit_code === 3) state.known = [...state.known, path].slice(-SEEN);
      if (run.value.exit_code === 3) reports.push(clip(run.value.stdout.replaceAll(`${root}/`, '').replace(NOISE, '').replace(/\n{2,}/g, '\n').trim(), FILE_BYTES));
    }
    return reports;
  };

  // A code-mode cell gets the executed result, so errors from its edits are appended to the model-visible cell output.
  api.intercept('tool', async (e, next) => {
    const result = await next(e);
    const caller = next.origin?.caller;
    if (caller !== 'model' && caller !== 'code_mode') return result;
    const state: State = { known: [], held: [], ...(api.state.get() as Partial<State> | null) };
    const reports = result.success ? check(e.tool, e.arguments, state) : [];
    const held = caller === 'code_mode' ? [...state.held, ...reports].slice(-FILES) : [];
    api.state.set({ ...state, held } as unknown as Json);
    const all = caller === 'model' ? [...state.held, ...reports] : [];
    if (!all.length) return result;
    return { ...result, output: `${result.output}\n\n${clip(`[omd_edit_guard] This edit introduced a syntax error. Fix it now, before anything else:\n${all.join('\n')}`, FEEDBACK_BYTES)}` };
  });
}
