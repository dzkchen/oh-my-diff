import type { FileStat, Json, ModAPI } from '../../api.d.ts';

type Language = 'rust' | 'typescript' | 'javascript' | 'python' | 'java';
type Check = { language: Language; program: string; program_sha256: string | null; arguments: string[]; working_directory: string; scope: string[]; input_sha256: string; candidate_sha256: string };
type Unsupported = { language: Language; reason: string; fallback: string };

const FALLBACK = 'Run a repository-configured executable check through the ordinary command tool and bind its result to the current inputs; unavailable evidence is not success.';
const CONFIG: Record<Language, string[]> = {
  rust: ['Cargo.toml', 'Cargo.lock'],
  typescript: ['package.json', 'pnpm-lock.yaml', 'tsconfig.json'],
  javascript: ['package.json', 'pnpm-lock.yaml', 'tsconfig.json'],
  python: ['pyproject.toml', 'setup.cfg', 'mypy.ini'],
  java: ['build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts', 'pom.xml', 'gradlew', 'mvnw'],
};
const LANGUAGE_ORDER: Language[] = ['rust', 'typescript', 'javascript', 'python', 'java'];
const SHA256 = /^[0-9a-f]{64}$/;

function language(path: string): Language | null {
  if (path.endsWith('.rs')) return 'rust';
  if (/\.tsx?$/.test(path)) return 'typescript';
  if (/\.jsx?$/.test(path)) return 'javascript';
  if (/\.pyi?$/.test(path)) return 'python';
  if (path.endsWith('.java')) return 'java';
  return null;
}

function validPath(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 1024
    && !value.startsWith('/') && !value.includes('\\')
    && value.split('/').every(part => part.length > 0 && part !== '.' && part !== '..' && part !== '.git');
}

const ROOT_CONFIG: Partial<Record<Language, string>> = { rust: 'Cargo.toml', typescript: 'tsconfig.json', javascript: 'tsconfig.json' };
const STAT_BATCH = 64;
const INPUT_FILE_LIMIT = 4096;
const INPUT_BYTE_LIMIT = 32 * 1024 * 1024;

type Command = { program: string; program_sha256: string | null; arguments: string[]; working_directory: string };
type Program = { path: string; sha256: string };

function directories(path: string): string[] {
  const parts = path.split('/').slice(0, -1);
  return Array.from({ length: parts.length + 1 }, (_, depth) => parts.slice(0, parts.length - depth).join('/'));
}

function within(directory: string, name: string): string {
  return directory ? `${directory}/${name}` : name;
}

async function digest(entries: [string, string][]): Promise<string> {
  const data = Uint8Array.from(encodeURIComponent(JSON.stringify(entries)).replace(/%([0-9A-F]{2})/g, (_, byte) => String.fromCharCode(parseInt(byte, 16))), character => character.charCodeAt(0));
  const hash = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
}

function command(kind: Language, root: string, scope: string[], present: (path: string) => boolean, programs: Map<string, Program>): Command | string {
  const installed = (name: string) => programs.get(name);
  if (kind === 'rust') {
    const cargo = installed('cargo');
    return cargo ? { program: cargo.path, program_sha256: cargo.sha256, arguments: ['check', '--quiet'], working_directory: root } : 'cargo is not installed';
  }
  if (kind === 'typescript' || kind === 'javascript') {
    const pnpm = installed('pnpm');
    return pnpm ? { program: pnpm.path, program_sha256: pnpm.sha256, arguments: ['exec', 'tsc', '--noEmit', '--pretty', 'false', '-p', within(root, 'tsconfig.json')], working_directory: '' } : 'pnpm is not installed';
  }
  if (kind === 'python') {
    for (const name of ['pyright', 'mypy', 'ruff']) {
      const program = installed(name);
      if (program) return { program: program.path, program_sha256: program.sha256, arguments: name === 'ruff' ? ['check', ...scope] : scope, working_directory: '' };
    }
    return 'pyright, mypy, and ruff are not installed';
  }
  if (present('gradlew')) return { program: './gradlew', program_sha256: null, arguments: ['compileJava'], working_directory: '' };
  if (present('mvnw')) return { program: './mvnw', program_sha256: null, arguments: ['-q', '-DskipTests', 'compile'], working_directory: '' };
  for (const [name, args] of [['gradle', ['compileJava']], ['mvn', ['-q', '-DskipTests', 'compile']]] as const) {
    const program = installed(name);
    if (program) return { program: program.path, program_sha256: program.sha256, arguments: [...args], working_directory: '' };
  }
  return 'Gradle or Maven is not installed or configured';
}

export default function activate(api: ModAPI) {
  const stat = (paths: string[], hash: boolean): Map<string, FileStat | null> => {
    const found = new Map<string, FileStat | null>();
    const unique = [...new Set(paths)];
    for (let index = 0; index < unique.length; index += STAT_BATCH) {
      const batch = unique.slice(index, index + STAT_BATCH);
      const files = api.host.call('workspace.stat', { paths: batch, hash }).files;
      for (const path of batch) found.set(path, files[path] ?? null);
    }
    return found;
  };
  const inputs = (kind: Language, root: string, scope: string[], configs: string[]): string[] => {
    if (kind === 'python') return [...scope, ...configs];
    const listed = api.host.call('workspace.list', { path: root, recursive: true, include_ignored: false });
    if (listed.truncated) throw new Error('check_input_listing_truncated');
    const names = new Set(CONFIG[kind]);
    const found = listed.entries.filter(entry => entry.kind === 'file' && validPath(entry.path)
      && (language(entry.path) === kind || names.has(entry.path.split('/').at(-1) ?? ''))).map(entry => entry.path);
    return [...found, ...configs];
  };

  api.tool({ name: 'select', description: 'Select bounded, source-bound intermediate checks for changed repository files without running them.',
    parameters: { type: 'object', properties: { paths: { type: 'array', items: { type: 'string' } } }, required: ['paths'], additionalProperties: false } }, async input => {
    const raw = input !== null && typeof input === 'object' && !Array.isArray(input) ? input.paths : null;
    if (!Array.isArray(raw) || raw.length === 0 || raw.length > 128 || !raw.every(validPath)) throw new Error('changed_paths_invalid');
    const paths = [...new Set(raw as string[])];
    if (paths.some(path => !language(path))) throw new Error('unsupported_source_path');
    const before = api.host.call('workspace.fingerprint', {});
    const configCandidates = paths.flatMap(path => directories(path).flatMap(directory => CONFIG[language(path)!].map(name => within(directory, name))));
    const stats = stat([...paths, ...configCandidates], false);
    if (paths.some(path => stats.get(path)?.kind !== 'file')) throw new Error('changed_source_missing');
    const present = (path: string) => stats.get(path)?.kind === 'file';
    const found = api.host.call('process.which', { names: ['cargo', 'pnpm', 'pyright', 'mypy', 'ruff', 'gradle', 'mvn'] });
    const programs = new Map(found.found.filter(item => SHA256.test(item.sha256)).map(item => [item.name, { path: item.path, sha256: item.sha256 }]));
    const checks: Check[] = [];
    const unsupported: Unsupported[] = [];
    for (const kind of LANGUAGE_ORDER) {
      const groups = new Map<string, string[]>();
      for (const path of paths.filter(path => language(path) === kind).sort()) {
        const marker = ROOT_CONFIG[kind];
        const root = marker ? directories(path).find(directory => present(within(directory, marker))) : '';
        if (root === undefined) {
          unsupported.push({ language: kind, reason: `no ${marker} encloses ${path}`, fallback: FALLBACK });
          continue;
        }
        groups.set(root, [...(groups.get(root) ?? []), path]);
      }
      for (const [root, scope] of groups) {
        const selected = command(kind, root, scope, present, programs);
        if (typeof selected === 'string') {
          unsupported.push({ language: kind, reason: selected, fallback: FALLBACK });
          continue;
        }
        const configs = scope.flatMap(path => directories(path).flatMap(directory => CONFIG[kind].map(name => within(directory, name)))).filter(present);
        const relevant = [...new Set(inputs(kind, root, scope, configs))].sort();
        if (relevant.length > INPUT_FILE_LIMIT) throw new Error('check_inputs_exceed_file_limit');
        const hashed = stat(relevant, true);
        let bytes = 0;
        const entries: [string, string][] = relevant.map(path => {
          const file = hashed.get(path);
          if (!file || file.kind !== 'file' || !file.sha256 || !SHA256.test(file.sha256)) throw new Error('check_input_stale');
          bytes += file.size;
          if (bytes > INPUT_BYTE_LIMIT) throw new Error('check_inputs_exceed_byte_limit');
          return [path, file.sha256];
        });
        checks.push({ language: kind, ...selected, scope, input_sha256: await digest(entries), candidate_sha256: before.candidate_sha256 });
      }
    }
    api.host.call('workspace.fingerprint', { expected: before.candidate_sha256 });
    return { checks, unsupported, candidate_sha256: before.candidate_sha256 } as Json;
  });
}
