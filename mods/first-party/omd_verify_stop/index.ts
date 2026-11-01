import type { Json, ModAPI } from '../../api.d.ts';

type State = { seq: number; edited: number; passed: number; failed: number; failure: string; blocked: boolean; probed: boolean; files: string[]; added: string[]; continued: number; pending: Record<string, boolean> };

const fresh = (): State => ({ seq: 0, edited: 0, passed: 0, failed: 0, failure: '', blocked: false, probed: false, files: [], added: [], continued: 0, pending: {} });
const LIST = 16;
const FAILURE_CHARS = 1500;
const NOT_CODE = /\.(md|mdx|rst|txt|adoc|log|out)$/i;
const CHECK = /^(pytest|py\.test|tox|nox|python3?\s+-m\s+(pytest|unittest)|(python3?\s+)?\S*(runtests\.py|manage\.py\s+test)|cargo\s+(test|check|clippy|build|nextest)|go\s+(test|vet|build)|(pnpm|npm|yarn|bun)\s+(run\s+)?(test|check|typecheck|build)\b|npx\s+(jest|vitest|mocha|tsc)|jest|vitest|mocha|tsc|make\s+(test|check)|ctest|mvn\s+\S*(test|verify)|\S*gradlew?\s+\S*(test|check)|rspec|rake\s+test|phpunit|dotnet\s+test|swift\s+(test|build)|sbt\s+\S*test|mix\s+test)(?![\w-])/;
const PREFIX = /^(?:\(|(?:ba|z)?sh\s+-l?c\s+|['"]|\w+=\S*\s+|(?:timeout\s+\S+|time|nice|env|uv\s+run|poetry\s+run|pipenv\s+run|pdm\s+run|hatch\s+run|bundle\s+exec)\s+)+/;
const FAILED = /\b[1-9]\d* (?:failed|errors?)\b|^(?:FAILED|FAIL|ERROR)\b|Traceback \(most recent call last\)|panicked at|^error(?:\[E\d+\])?:|npm ERR!/m;
const BLOCKED = /No module named|ModuleNotFoundError|command not found|: not found$|Could not find a version that satisfies|Temporary failure in name resolution|Could not resolve host|ENOTFOUND|Network is unreachable/m;
const RUN = /^(python3?|node|ruby|php|go\s+run|cargo\s+run|bash|sh)\s+[\w./-]+/;
const EXIT = /^(?:Process exited with code|Exit code:) (\d+)/m;
const RUNNING = /^Process running with session ID (\d+)/m;
const PATCH = /^\*\*\* (Add|Update|Delete) File: (.+)$|^\*\*\* Move to: (.+)$/gm;
const HEADER = /^(?:Chunk ID:|Wall time:|Original token count:|Output:|Process exited with code |Exit code:).*\n?/gm;
const RUNNERS: [RegExp, string, string][] = [
  [/\.py$/, 'tests/runtests.py', 'python tests/runtests.py <module>'],
  [/\.py$/, 'pyproject.toml', 'python -m pytest <test files>'], [/\.py$/, 'setup.py', 'python -m pytest <test files>'],
  [/\.py$/, 'pytest.ini', 'python -m pytest <test files>'], [/\.py$/, 'tox.ini', 'python -m pytest <test files>'],
  [/\.rs$/, 'Cargo.toml', 'cargo test <filter>'], [/\.go$/, 'go.mod', 'go test ./<package>/...'],
  [/\.[cm]?[jt]sx?$/, 'pnpm-lock.yaml', 'pnpm test'], [/\.[cm]?[jt]sx?$/, 'yarn.lock', 'yarn test'], [/\.[cm]?[jt]sx?$/, 'package.json', 'npm test'],
  [/\.rb$/, 'Gemfile', 'bundle exec rspec <spec>'], [/\.php$/, 'composer.json', 'vendor/bin/phpunit <test>'],
  [/\.(java|kt)$/, 'pom.xml', 'mvn test'], [/\.(java|kt)$/, 'build.gradle', './gradlew test'], [/./, 'Makefile', 'make test'],
];

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
const add = (list: string[], path: string) => { if (!list.includes(path)) list.push(path); list.splice(0, list.length - LIST); };

const segments = (cmd: string) => cmd.split(/&&|\|\||;|\n/).map(part => part.trim().replace(PREFIX, ''));

function command(args: Json): string | null {
  const value = field(args, 'cmd') ?? field(args, 'command');
  return typeof value === 'string' ? value : Array.isArray(value) ? value.join(' ') : null;
}

export default function activate(api: ModAPI) {
  const cap = Math.min(Math.max(Math.round(Number(api.settings.max_continuations ?? 2)) || 0, 0), 2);
  const load = (): State => ({ ...fresh(), ...(api.state.get() as Partial<State> | null) });
  const save = (state: State) => api.state.set(state as unknown as Json);

  const edit = (state: State, path: string, kind = 'Update') => {
    if (kind === 'Delete' && state.added.includes(path)) return void state.added.splice(state.added.indexOf(path), 1);
    if (NOT_CODE.test(path)) return;
    state.edited = ++state.seq;
    if (kind === 'Add') add(state.added, path);
    if (kind !== 'Delete') add(state.files, path);
  };
  const checked = (state: State, code: number, output: string) => {
    state.blocked = false;
    if (code === 0) return void (state.passed = ++state.seq);
    state.failed = ++state.seq;
    state.failure = [...output.replace(HEADER, '').trim()].slice(-FAILURE_CHARS).join('');
    state.blocked = BLOCKED.test(output);
  };

  api.on('turn_start', () => save(fresh()));

  api.on('tool_output', event => {
    const state = load();
    const text = event.tail ?? event.text;
    if (event.tool === 'apply_patch') {
      if (event.success) for (const match of strings(event.arguments).join('\n').matchAll(PATCH)) edit(state, (match[2] ?? match[3]).trim(), match[1] ?? 'Update');
    } else if (EDIT_TOOL.test(event.tool)) {
      const files = field(event.arguments, 'files');
      const paths = [field(event.arguments, 'path'), field(event.arguments, 'file_path'), ...(Array.isArray(files) ? files.map(file => field(file, 'path')) : [])];
      if (event.success) paths.forEach(path => typeof path === 'string' && edit(state, path));
    } else if (event.tool === 'write_stdin') {
      const session = String(field(event.arguments, 'session_id'));
      const code = EXIT.exec(event.text)?.[1];
      if (!(session in state.pending) || code === undefined) return null;
      if (state.pending[session]) checked(state, Number(code), text);
      delete state.pending[session];
    } else {
      const cmd = command(event.arguments);
      if (cmd === null) return null;
      const parts = segments(cmd);
      const check = parts.some(part => CHECK.test(part));
      if (!state.edited && (check || parts.some(part => RUN.test(part)))) state.probed = true;
      const { created, changed } = writes(cmd);
      created.filter(path => !path.startsWith('/') && /\.\w+$/.test(path)).forEach(path => edit(state, path, 'Add'));
      changed.filter(path => !path.startsWith('/')).forEach(path => edit(state, path));
      if (!created.length && !changed.length && /\b(?:sed|perl)\s+(?:\S+\s+)*?-[a-zA-Z]*i[\w.]*(?:\s|$)/.test(cmd.replace(QUOTED, "''"))) state.edited = ++state.seq;
      const code = EXIT.exec(event.text)?.[1];
      const session = RUNNING.exec(event.text)?.[1];
      if (session) state.pending[session] = check;
      else if (check) checked(state, (code === undefined ? !event.success : Number(code) !== 0) || (cmd.includes('|') && FAILED.test(text)) ? 1 : 0, text);
    }
    save(state);
    return null;
  });

  const runners = (files: string[]) => {
    const stat = api.host.tryCall('workspace.stat', { paths: [...new Set(RUNNERS.map(([, marker]) => marker))] });
    if (!stat.ok) return [];
    const seen = new Set<string>();
    return RUNNERS.filter(([lang, marker]) => {
      if (!stat.value.files[marker] || !files.some(file => lang.test(file)) || seen.has(lang.source)) return false;
      seen.add(lang.source);
      return true;
    }).map(([, , runner]) => runner);
  };

  const checklist = (state: State) => {
    const hint = runners(state.files);
    return [
      `[omd_verify_stop] You edited ${state.files.join(', ') || 'files'} but no test or check has passed since the last edit. Before finishing:`,
      ...(state.probed ? [] : ['- Reproduce the issue first if you have not: a minimal script or test that fails without your fix and passes with it.']),
      `- Run the most relevant existing tests for the edited files${hint.length ? ` (likely: ${hint.join('; ')})` : ' with the project\'s runner (pytest, cargo test, go test, pnpm/npm test, make check ...)'}; fix any failure your change caused.`,
      '- Check nearby behavior for regressions.',
      `- Delete scratch, debug or reproduction files that do not belong in the final diff${state.added.length ? ` (created: ${state.added.join(', ')})` : ''}.`,
      '- Do not modify existing tests unless the task requires it.',
      ...(state.failed > state.edited ? [`The last check failed:\n${state.failure}`] : []),
    ].join('\n');
  };

  api.intercept('turn_stop', (event, next) => {
    const state = load();
    if (event.outcome !== 'completed' || state.continued >= cap || !state.edited || state.passed > state.edited || state.blocked) return next(event);
    const prompt = state.continued === 0 ? checklist(state)
      : state.failed > state.edited ? `[omd_verify_stop] Your last test/check run after the final edit failed:\n${state.failure}\nFix the cause (not the tests, unless the task requires it), rerun it until it passes, then finish.`
        : null;
    if (!prompt) return next(event);
    state.continued++;
    save(state);
    return { continue: prompt };
  });
}
