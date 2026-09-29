import type { Json, ModAPI } from '../../api.d.ts';

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

function ancestor(path: string, name: string, files: Set<string>): string | null {
  const parts = path.split('/');
  parts.pop();
  while (true) {
    const prefix = parts.length ? `${parts.join('/')}/` : '';
    if (files.has(`${prefix}${name}`)) return parts.join('/');
    if (!parts.length) return null;
    parts.pop();
  }
}

async function digest(entries: [string, string][]): Promise<string> {
  const data = Uint8Array.from(encodeURIComponent(JSON.stringify(entries)).replace(/%([0-9A-F]{2})/g, (_, byte) => String.fromCharCode(parseInt(byte, 16))), character => character.charCodeAt(0));
  const hash = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
}

function command(kind: Language, scope: string[], files: Set<string>, programs: Map<string, { path: string; sha256: string }>): { program: string; program_sha256: string | null; arguments: string[]; working_directory: string } | string {
  const installed = (name: string) => programs.get(name);
  if (kind === 'rust') {
    const cargo = installed('cargo');
    const directory = ancestor(scope[0], 'Cargo.toml', files);
    return cargo && directory !== null
      ? { program: cargo.path, program_sha256: cargo.sha256, arguments: ['check', '--quiet'], working_directory: directory }
      : 'cargo or a repository Cargo.toml is unavailable';
  }
  if (kind === 'typescript' || kind === 'javascript') {
    const pnpm = installed('pnpm');
    const directory = ancestor(scope[0], 'tsconfig.json', files);
    return pnpm && directory !== null
      ? { program: pnpm.path, program_sha256: pnpm.sha256, arguments: ['exec', 'tsc', '--noEmit', '--pretty', 'false', '-p', `${directory ? `${directory}/` : ''}tsconfig.json`], working_directory: '' }
      : 'pnpm or a repository tsconfig.json is unavailable';
  }
  if (kind === 'python') {
    for (const name of ['pyright', 'mypy', 'ruff']) {
      const program = installed(name);
      if (program) return { program: program.path, program_sha256: program.sha256, arguments: name === 'ruff' ? ['check', ...scope] : scope, working_directory: '' };
    }
    return 'pyright, mypy, and ruff are not installed';
  }
  if (files.has('gradlew')) return { program: './gradlew', program_sha256: null, arguments: ['compileJava'], working_directory: '' };
  if (files.has('mvnw')) return { program: './mvnw', program_sha256: null, arguments: ['-q', '-DskipTests', 'compile'], working_directory: '' };
  for (const [name, args] of [['gradle', ['compileJava']], ['mvn', ['-q', '-DskipTests', 'compile']]] as const) {
    const program = installed(name);
    if (program) return { program: program.path, program_sha256: program.sha256, arguments: [...args], working_directory: '' };
  }
  return 'Gradle or Maven is not installed or configured';
}

export default function activate(api: ModAPI) {
  api.tool({ name: 'select', description: 'Select bounded, source-bound intermediate checks for changed repository files without running them.',
    parameters: { type: 'object', properties: { paths: { type: 'array', items: { type: 'string' } } }, required: ['paths'], additionalProperties: false } }, async input => {
    const raw = input !== null && typeof input === 'object' && !Array.isArray(input) ? input.paths : null;
    if (!Array.isArray(raw) || raw.length === 0 || raw.length > 128 || !raw.every(validPath)) throw new Error('changed_paths_invalid');
    const paths = [...new Set(raw as string[])];
    if (paths.some(path => !language(path))) throw new Error('unsupported_source_path');
    const before = api.host.call('workspace.snapshot', {});
    const listed = api.host.call('workspace.list', { recursive: true, include_ignored: false, max_entries: 2048 });
    if (listed.truncated) throw new Error('check_input_listing_truncated');
    const files = new Set(listed.entries.filter(entry => entry.kind === 'file' && validPath(entry.path)).map(entry => entry.path));
    if (paths.some(path => !files.has(path))) throw new Error('changed_source_missing');
    const found = api.host.call('process.which', { names: ['cargo', 'pnpm', 'pyright', 'mypy', 'ruff', 'gradle', 'mvn'] });
    const programs = new Map(found.found.filter(item => SHA256.test(item.sha256)).map(item => [item.name, { path: item.path, sha256: item.sha256 }]));
    const checks: Check[] = [];
    const unsupported: Unsupported[] = [];
    for (const kind of LANGUAGE_ORDER) {
      const scope = paths.filter(path => language(path) === kind).sort();
      if (!scope.length) continue;
      const selected = command(kind, scope, files, programs);
      if (typeof selected === 'string') {
        unsupported.push({ language: kind, reason: selected, fallback: FALLBACK });
        continue;
      }
      const names = new Set(CONFIG[kind]);
      const relevant = [...files].filter(path => language(path) === kind || names.has(path.split('/').at(-1) ?? '')).sort();
      if (relevant.length > 1024) throw new Error('check_inputs_exceed_file_limit');
      const hashed: [string, string][] = [];
      let bytes = 0;
      for (let index = 0; index < relevant.length; index += 64) {
        const batch = relevant.slice(index, index + 64);
        const stat = api.host.call('workspace.stat', { paths: batch, hash: true });
        for (const path of batch) {
          const file = stat.files[path];
          if (!file || file.kind !== 'file' || !file.sha256 || !SHA256.test(file.sha256)) throw new Error('check_input_stale');
          bytes += file.size;
          if (bytes > 8 * 1024 * 1024) throw new Error('check_inputs_exceed_byte_limit');
          hashed.push([path, file.sha256]);
        }
      }
      checks.push({ language: kind, ...selected, scope, input_sha256: await digest(hashed), candidate_sha256: before.candidate_sha256 });
    }
    api.host.call('workspace.snapshot', { expected: before.candidate_sha256 });
    return { checks, unsupported, candidate_sha256: before.candidate_sha256 } as Json;
  });
}
