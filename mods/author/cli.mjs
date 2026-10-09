#!/usr/bin/env node
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, watch, writeFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createRequire, stripTypeScriptTypes } from 'node:module';

const sdkRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// Installed generations are pruned after updates, so projects depend on the SDK through the installer's current link.
const stableSdkRoot = (() => {
  const match = /^(.*)\/releases\/[0-9a-f]{32}(\/prefix\/author\/package)$/.exec(sdkRoot);
  const current = match ? `${match[1]}/current${match[2]}` : null;
  return current && existsSync(current) && realpathSync(current) === realpathSync(sdkRoot) ? current : sdkRoot;
})();
const apiVersion = JSON.parse(readFileSync(join(sdkRoot, 'package.json'), 'utf8')).version;
const engine = process.env.OMD_MOD_BIN || 'omd-mod';
const node = process.env.OMD_MOD_NODE || process.execPath;
const publicExamples = ['routing', 'coordination', 'recovery', 'terminal', 'kernel', 'workflow', 'workspace', 'virtual_reader', 'scoped_data', 'review_probe', 'service_request', 'release_check', 'snapshot_review', 'render_hooks', 'reactive_dashboard'];

function fail(message) {
  throw new Error(message);
}

function command(program, args, options = {}) {
  const result = spawnSync(program, args, { cwd: options.cwd, encoding: 'utf8', stdio: options.capture ? 'pipe' : 'inherit' });
  if (result.error?.code === 'ENOENT') fail(`${program} was not found on PATH; ${program === engine ? 'reinstall Oh My Diff or set OMD_MOD_BIN to the omd-mod binary' : 'install it first'}`);
  if (result.error) throw result.error;
  if (result.status !== 0) fail((result.stderr || result.stdout || `${program} failed`).trim());
  return options.capture ? result.stdout.trim() : '';
}

function engineJson(args) {
  return JSON.parse(command(engine, args, { capture: true }));
}

function packageJson(name) {
  return {
    name: `omd-mod-${name}`,
    version: '0.1.0',
    private: true,
    type: 'module',
    files: ['mod.json', 'index.ts'],
    scripts: {
      check: 'omd-mod-author check .',
      test: 'omd-mod-author test .',
      run: 'omd-mod-author run .',
      debug: 'omd-mod-author debug .',
      package: 'omd-mod-author package .',
      watch: 'omd-mod-author watch .',
    },
    devDependencies: {
      '@oh-my-diff/mod-api': process.env.OMD_MOD_SDK_SPEC || `file:${stableSdkRoot}`,
      ...(process.env.OMD_MOD_TYPESCRIPT_SPEC ? { typescript: process.env.OMD_MOD_TYPESCRIPT_SPEC } : {}),
    },
  };
}

function tsconfig() {
  return {
    compilerOptions: {
      target: 'ES2022',
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      strict: true,
      noEmit: true,
      jsx: 'react-jsx',
      jsxImportSource: '@oh-my-diff/mod-api',
      types: [],
    },
    include: ['index.ts', 'index.tsx', '.omd/*.d.ts'],
  };
}

function minimalSource() {
  return `import type { ModAPI } from '@oh-my-diff/mod-api';

export default function activate(api: ModAPI) {
  api.command('hello', input => {
    if (input === 'fail') throw new Error('INTENTIONAL_AUTHOR_FAILURE');
    return { display: \`Hello \${String(input || 'world')}\` };
  }, { description: 'Confirm the scaffold is running' });
}
`;
}

function scenarioFor(name) {
  const scenarios = {
    minimal: {
      schema: 1,
      virtual_time_ms: 1000,
      steps: [{ type: 'invoke', mod: name, event: 'command', name: 'hello', payload: 'author', expect: { display: 'Hello author' } }],
    },
    routing: {
      schema: 1,
      settings: { routing: { route: 'sol' } },
      steps: [{ type: 'event', event: 'routing', payload: { routes: [{ name: 'sol', model: 'm1', provider: 'p', available: true, billing: 'included_subscription' }, { name: 'astra', model: 'm2', provider: 'p', available: true, billing: 'included_subscription' }] }, expect: [{ mod: 'routing', value: { route: 'sol' } }] }],
    },
    coordination: {
      schema: 1,
      host_operations: {
        'routes.list': [{ result: [{ name: 'sol', model: 'm1', provider: 'p', available: true, billing: 'included_subscription', roles: ['worker'] }, { name: 'astra', model: 'm2', provider: 'p', available: true, billing: 'included_subscription', roles: ['worker'] }] }],
        'workspace.snapshot': [{ result: { snapshot: { id: 'fixture-snapshot', sha256: 'a'.repeat(64) } } }],
        'agents.spawn': [{ result: { handle: 'a', route: 'sol', permissions: 'read_only' } }, { result: { handle: 'b', route: 'astra', permissions: 'read_only' } }],
        'agents.wait': [{ result: { status: 'completed', text: 'one', consumed: true } }, { result: { status: 'completed', text: 'two', consumed: true } }],
      },
      steps: [{ type: 'invoke', mod: 'coordination', event: 'tool', name: 'compare', payload: { prompt: 'inspect' } }],
    },
    context: {
      schema: 1,
      steps: [{ type: 'event', event: 'context', payload: { thread_id: 't', turn_id: 'u' } }],
    },
    recovery: {
      schema: 1,
      steps: [
        { type: 'event', event: 'compaction', payload: { token_limit: 32000, context_window: 64000 } },
        { type: 'event', event: 'context', payload: { thread_id: 't', turn_id: 'u' } },
        { type: 'invoke', mod: 'recovery', event: 'tool', name: 'checkpoint', payload: {}, expect_error: 'unsupported_operation: checkpoint.read' },
      ],
    },
    kernel: {
      schema: 1,
      steps: [
        { type: 'event', event: 'model_request', payload: { routes: [{ name: 'sol', available: true, billing: 'included_subscription' }, { name: 'astra', available: true, billing: 'included_subscription' }] }, expect: [{ mod: 'kernel', value: { route: 'astra' } }] },
        { type: 'event', event: 'response_stream', payload: { protected: false, text: 'experimental API' }, expect: [{ mod: 'kernel', value: { text: 'preview API' } }] },
      ],
    },
    counter: {
      schema: 1,
      steps: [{ type: 'invoke', mod: 'counter', event: 'tool', name: 'count', payload: {}, expect: { count: 1 } }],
    },
    terminal: {
      schema: 1,
      steps: [
        { type: 'event', event: 'terminal', payload: { event: 'draw', ledger: null } },
        { type: 'invoke', mod: 'terminal', event: 'command', name: 'layout', payload: 'review', expect: { display: 'Layout request: review' } },
      ],
    },
    workflow: {
      schema: 1,
      host_operations: {
        'contract.status': [{ result: { id: 'paired_review', version: 1, assurance: 'independent-review-candidate' } }],
        'contract.restrict': [{ result: { restricted: true } }],
      },
      steps: [
        { type: 'invoke', mod: 'workflow', event: 'tool', name: 'workflow', payload: {}, expect: { id: 'paired_review', version: 1, assurance: 'independent-review-candidate' } },
        { type: 'invoke', mod: 'workflow', event: 'tool', name: 'no_delegation', payload: {}, expect: { restricted: true } },
      ],
    },
    'service-consumer': {
      schema: 1,
      packages: ['../service-provider'],
      steps: [{ type: 'invoke', mod: 'service_consumer', event: 'command', name: 'format', payload: '  typed service  ', expect: 'typed service' }],
    },
    'service-provider': { schema: 1, steps: [{ type: 'status' }] },
    workspace: { schema: 1, steps: [{ type: 'invoke', mod: 'workspace_author', event: 'tool', name: 'move', payload: null, expect_error: 'invalid_move' }] },
    virtual_reader: { schema: 1, steps: [{ type: 'invoke', mod: 'example_virtual_reader', event: 'virtual_read', name: 'fixture', payload: { uri: 'fixture://manual/intro' } }] },
    scoped_data: { schema: 1, host_operations: { 'store.get': [{ result: null }] }, steps: [{ type: 'invoke', mod: 'example_scoped_data', event: 'command', name: 'inspect', payload: null, expect: null }] },
    service_request: { schema: 1, host_operations: { 'sidecars.invoke': [{ result: { provider: 'example_echo', program_sha256: 'a'.repeat(64), source_hashes: {}, result: { echo: 'extension-owned request' }, untrusted: true } }] }, steps: [{ type: 'invoke', mod: 'example_service_request', event: 'tool', name: 'probe', payload: {} }] },
    review_probe: { schema: 1, steps: [{ type: 'invoke', mod: 'example_review_probe', event: 'turn_end', name: '', payload: { turn_id: 'fixture', outcome: 'aborted' } }] },
    snapshot_review: { schema: 1, host_operations: { 'task.status': [{ result: { ledger: { thread_id: 'author-preview' } } }], 'store.get': [{ result: null }] }, steps: [{ type: 'invoke', mod: 'snapshot_review', event: 'tool', name: 'start', payload: {}, expect_error: 'capture_first' }] },
  };
  return scenarios[name] || scenarios.minimal;
}

function debugScenario(name) {
  if (name === 'coordination') {
    return { schema: 1, steps: [{ type: 'invoke', mod: 'coordination', event: 'tool', name: 'compare', payload: null, expect_error: 'prompt required' }] };
  }
  if (name === 'minimal') {
    return { schema: 1, steps: [{ type: 'invoke', mod: name, event: 'command', name: 'hello', payload: 'fail', expect_error: 'INTENTIONAL_AUTHOR_FAILURE' }] };
  }
  return { schema: 1, steps: [{ type: 'invoke', mod: ({ service_request: 'example_service_request', workspace: 'workspace_author', virtual_reader: 'example_virtual_reader', scoped_data: 'example_scoped_data', review_probe: 'example_review_probe' })[name] ?? name.replaceAll('-', '_'), event: 'command', name: '__intentional_missing__', payload: null, expect_error: 'unsupported_or_unregistered_operation' }] };
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeProjectFiles(directory, name) {
  await writeJson(join(directory, 'package.json'), packageJson(name));
  await writeJson(join(directory, 'tsconfig.json'), tsconfig());
  await writeJson(join(directory, 'mod.test.json'), scenarioFor(name));
  await writeJson(join(directory, 'debug.test.json'), debugScenario(name));
}

// The SDK is a local file dependency, so the scaffold and its lockfile install without the network.
function lock(directory) {
  const result = spawnSync('pnpm', ['install', '--offline', '--silent'], { cwd: directory, encoding: 'utf8' });
  if (result.status !== 0) process.stderr.write('pnpm install --offline did not complete; run pnpm install in the project to link the SDK\n');
}

async function createProject(directory, name) {
  if (!/^[a-z0-9_]{1,24}$/.test(name)) fail(`invalid_mod_id: ${name}`);
  if (existsSync(directory)) fail(`target_exists: ${directory}`);
  mkdirSync(directory, { recursive: true });
  await writeJson(join(directory, 'mod.json'), { schema: 1, id: name, version: '0.1.0', api: apiVersion, state_version: 1,
    license: 'UNLICENSED', provenance: { maintainer: 'CHANGE ME', source: 'CHANGE ME' }, capabilities: ['commands'] });
  await writeFile(join(directory, 'index.ts'), minimalSource());
  await writeProjectFiles(directory, name);
  lock(directory);
}

async function copyExample(directory, name) {
  if (!publicExamples.includes(name)) fail(`unknown_example: ${name}`);
  const source = join(sdkRoot, 'examples', name);
  if (!statSync(source).isDirectory()) fail(`unknown_example: ${name}`);
  if (existsSync(directory)) fail(`target_exists: ${directory}`);
  cpSync(source, directory, { recursive: true });
  await writeProjectFiles(directory, name);
  const suppliedScenario = join(source, 'mod.test.json');
  if (existsSync(suppliedScenario)) cpSync(suppliedScenario, join(directory, 'mod.test.json'));
}

async function copyExamples(directory) {
  if (existsSync(directory)) fail(`target_exists: ${directory}`);
  mkdirSync(directory, { recursive: true });
  for (const name of publicExamples) await copyExample(join(directory, name), name);
  await writeJson(join(directory, 'package.json'), { name: 'omd-mod-examples', private: true, scripts: { check: 'pnpm -r check', test: 'pnpm -r test', package: 'pnpm -r package' } });
  await writeFile(join(directory, 'pnpm-workspace.yaml'), "packages:\n  - '*'\n");
}

function compileJsx(directory) {
  const sourcePath = join(directory, 'index.tsx');
  if (!existsSync(sourcePath)) return;
  let ts;
  try {
    ts = createRequire(join(directory, 'package.json'))('typescript');
  } catch (error) {
    if (error.code === 'MODULE_NOT_FOUND') fail('jsx_requires_typescript: pnpm add -D typescript@5.9.3');
    throw error;
  }
  const { outputText, diagnostics } = ts.transpileModule(readFileSync(sourcePath, 'utf8'), {
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, jsxImportSource: '@oh-my-diff/mod-api', module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    fileName: 'index.tsx',
    reportDiagnostics: true,
  });
  const errors = diagnostics.filter(diagnostic => diagnostic.category === ts.DiagnosticCategory.Error);
  if (errors.length) fail(errors.map(diagnostic => `index.tsx: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')}`).join('\n'));
  const factory = readFileSync(join(sdkRoot, 'author/jsx-runtime.mjs'), 'utf8').replace(/^export /gm, '');
  const importLine = /^import \{([^}]*)\} from ["']@oh-my-diff\/mod-api\/jsx-runtime["'];?$/m;
  if (/\bFragment\b/.test(importLine.exec(outputText)?.[1] ?? '')) fail('jsx_unsupported_element: fragment');
  const inlined = outputText.replace(importLine, (_match, names) => `const {${names.replaceAll(' as ', ': ')}} = (() => {\n${factory}return { jsx, jsxs };\n})();`);
  if (inlined.includes('@oh-my-diff/mod-api/jsx-runtime')) fail('jsx_import_unsupported: index.tsx may only use the JSX factory import the compiler emits');
  const header = '// @ts-nocheck\n// Generated from index.tsx; edit that file instead.\n';
  const generated = `${header}${inlined}`;
  const target = join(directory, 'index.ts');
  const existing = existsSync(target) ? readFileSync(target, 'utf8') : null;
  if (existing !== null && !existing.startsWith(header)) fail('jsx_entrypoint_conflict: index.ts was not generated from index.tsx; remove one of them');
  if (existing !== generated) writeFileSync(target, generated);
}

function checkProject(directory) {
  compileJsx(directory);
  const manifest = JSON.parse(readFileSync(join(directory, 'mod.json'), 'utf8'));
  stripTypeScriptTypes(readFileSync(join(directory, manifest.entrypoint ?? 'index.ts'), 'utf8'));
  if (!existsSync(join(directory, 'node_modules/.bin/tsc'))) {
    process.stderr.write('Syntax checked; add TypeScript for type checking: pnpm add -D typescript@5.9.3\n');
    return;
  }
  if (!existsSync(join(directory, 'index.tsx'))) return command('pnpm', ['exec', 'tsc', '-p', 'tsconfig.json'], { cwd: directory });
  // TypeScript drops index.tsx from a program that also lists index.ts, so check the source rather than its generated output.
  const jsxConfig = join(directory, 'tsconfig.omd-jsx.json');
  writeFileSync(jsxConfig, JSON.stringify({ extends: './tsconfig.json', include: ['.omd/*.d.ts'], files: ['index.tsx'] }));
  try {
    command('pnpm', ['exec', 'tsc', '-p', 'tsconfig.omd-jsx.json'], { cwd: directory });
  } finally {
    rmSync(jsxConfig, { force: true });
  }
}

function trustPackage(store, directory) {
  const inspected = engineJson(['inspect', directory]);
  const capabilities = inspected.manifest.capabilities.join(',');
  engineJson(['trust', store, inspected.path, inspected.sha256, capabilities, 'user']);
  engineJson(['enable', store, inspected.path]);
  return inspected;
}

function copyDeclarations(store, directory) {
  const declarations = engineJson(['declarations', store]);
  const target = join(directory, '.omd');
  mkdirSync(target, { recursive: true });
  cpSync(declarations.active_host, join(target, 'active-host.d.ts'));
  cpSync(declarations.installed_contracts, join(target, 'installed-contracts.d.ts'));
  if (declarations.tool_types) cpSync(declarations.tool_types, join(target, 'tool-types.d.ts'));
}

export function runScenarioObject(directory, scenario, afterRun) {
  const packages = [...(scenario.packages || []).map(path => resolve(directory, path)), directory];
  for (const packagePath of packages) compileJsx(packagePath);
  const temporary = mkdtempSync(join(tmpdir(), 'omd-mod-author-'));
  const store = join(temporary, 'store');
  try {
    engineJson(['init', store, node]);
    const installed = new Map(packages.map(packagePath => {
      const inspected = trustPackage(store, resolve(packagePath));
      return [inspected.manifest.id, inspected.path];
    }));
    for (const [id, settings] of Object.entries(scenario.settings || {})) {
      const path = installed.get(id) || fail(`settings_for_uninstalled_mod: ${id}`);
      engineJson(['settings', store, path, JSON.stringify(settings)]);
    }
    const scenarioPath = join(temporary, 'scenario.json');
    writeFileSync(scenarioPath, JSON.stringify(scenario));
    const result = engineJson(['test', store, scenarioPath]);
    afterRun?.(store);
    return result;
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

function runScenario(directory, file) {
  const scenario = JSON.parse(readFileSync(resolve(directory, file), 'utf8'));
  const result = runScenarioObject(directory, scenario, store => {
    copyDeclarations(store, directory);
    checkProject(directory);
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

function runTests(directory) {
  const scenario = existsSync(join(directory, 'mod.test.json'));
  const files = readdirSync(directory).filter(name => /\.test\.(ts|mjs)$/.test(name));
  if (!scenario && !files.length) fail('no_tests: add mod.test.json or a *.test.ts file');
  if (scenario) runScenario(directory, 'mod.test.json');
  if (files.length) command(node, ['--test', ...files], { cwd: directory });
}

async function packageProject(directory) {
  checkProject(directory);
  const inspected = engineJson(['inspect', directory]);
  const name = `${inspected.manifest.id}-${inspected.manifest.version}`;
  const target = join(directory, 'dist', name);
  if (existsSync(target)) fail(`package_target_exists: ${target}`);
  mkdirSync(target, { recursive: true });
  const entrypoint = inspected.manifest.entrypoint ?? 'index.ts';
  for (const path of new Set(['mod.json', entrypoint, ...(inspected.manifest.assets ?? []), ...Object.values(inspected.manifest.lifecycle ?? {})])) {
    mkdirSync(dirname(join(target, path)), { recursive: true });
    cpSync(join(directory, path), join(target, path));
  }
  const transformed = stripTypeScriptTypes(readFileSync(join(directory, entrypoint), 'utf8'), { mode: 'transform', sourceMap: true, sourceUrl: entrypoint });
  const marker = '\n//# sourceMappingURL=data:application/json;base64,';
  const [javascript, encoded] = transformed.split(marker);
  if (existsSync(join(target, 'index.js')) || existsSync(join(target, 'index.js.map')) || existsSync(join(target, 'package-report.json'))) fail('package_generated_file_conflict');
  await writeFile(join(target, 'index.js'), `${javascript}\n//# sourceMappingURL=index.js.map\n`);
  await writeFile(join(target, 'index.js.map'), Buffer.from(encoded.trim(), 'base64'));
  const packaged = engineJson(['inspect', target]);
  if (packaged.sha256 !== inspected.sha256) fail('package_integrity_changed');
  await writeJson(join(target, 'package-report.json'), { api: apiVersion, sha256: packaged.sha256, source_map: 'index.js.map', manifest: packaged.manifest });
  process.stdout.write(`${JSON.stringify({ package: target, sha256: packaged.sha256, source_map: join(target, 'index.js.map') }, null, 2)}\n`);
}

function watchProject(directory, store, once) {
  let files = new Set(['mod.json']);
  const reload = () => {
    compileJsx(directory);
    const inspected = trustPackage(store, directory);
    files = new Set(['mod.json', inspected.manifest.entrypoint ?? 'index.ts', ...(inspected.manifest.assets ?? []), ...Object.values(inspected.manifest.lifecycle ?? {})]);
    if (existsSync(join(directory, 'index.tsx'))) files.add('index.tsx');
    const result = engineJson(['reload', store]);
    copyDeclarations(store, directory);
    process.stdout.write(`${JSON.stringify({ reloaded: directory, sha256: inspected.sha256, result })}\n`);
  };
  reload();
  if (once) return;
  // Editors save in several writes, so a later reload can see a half-written file; report it and keep watching.
  const tryReload = () => {
    try {
      reload();
    } catch (error) {
      process.stderr.write(`${JSON.stringify({ reload_failed: directory, error: error.message })}\n`);
    }
  };
  let pending;
  const watcher = watch(directory, { recursive: true }, (_event, filename) => {
    if (!files.has(String(filename).replaceAll('\\', '/'))) return;
    clearTimeout(pending);
    pending = setTimeout(tryReload, 100);
  });
  process.on('SIGINT', () => watcher.close());
}

async function main() {
  const [action, rawDirectory = '.', nameOrStore, extra] = process.argv.slice(2);
  const directory = resolve(rawDirectory);
  switch (action) {
    case 'create': return createProject(directory, nameOrStore || basename(directory));
    case 'example': return copyExample(directory, nameOrStore);
    case 'examples': return copyExamples(directory);
    case 'check': return checkProject(directory);
    case 'test': return runTests(directory);
    case 'run': return runScenario(directory, 'mod.test.json');
    case 'debug': return runScenario(directory, 'debug.test.json');
    case 'package': return packageProject(directory);
    case 'watch': return watchProject(directory, resolve(nameOrStore || fail('watch requires STORE')), extra === '--once');
    case 'report': process.stdout.write(`${JSON.stringify(engineJson(['report', directory]), null, 2)}\n`); return;
    case 'events': process.stdout.write(`${JSON.stringify(engineJson(['events', directory]), null, 2)}\n`); return;
    case 'diagnostics': process.stdout.write(`${JSON.stringify(engineJson(['diagnostics', directory, resolve(nameOrStore || 'omd-diagnostics.json')]), null, 2)}\n`); return;
    case 'explain': process.stdout.write(`${JSON.stringify(engineJson(['explain', rawDirectory]), null, 2)}\n`); return;
    default: fail('usage: omd-mod-author create DIR [ID] | example DIR NAME | examples DIR | check/test/run/debug/package DIR | watch DIR STORE [--once] | report/events STORE | diagnostics STORE [OUTPUT] | explain DENIAL');
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
