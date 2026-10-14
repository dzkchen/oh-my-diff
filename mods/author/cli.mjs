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
const sdkPackage = JSON.parse(readFileSync(join(sdkRoot, 'package.json'), 'utf8'));
const apiVersion = sdkPackage.version;
const engine = process.env.OMD_MOD_BIN || 'omd-mod';
const node = process.env.OMD_MOD_NODE || process.execPath;
const publicExamples = sdkPackage.files.filter(file => file.startsWith('examples/')).map(file => file.slice('examples/'.length));

/** @returns {never} */
function fail(message) {
  throw new Error(message);
}

function command(program, args, options = {}) {
  const result = spawnSync(program, args, { cwd: options.cwd, encoding: 'utf8', stdio: options.capture ? 'pipe' : 'inherit' });
  if (result.error && 'code' in result.error && result.error.code === 'ENOENT') fail(`${program} was not found on PATH; ${program === engine ? 'reinstall Oh My Diff or set OMD_MOD_BIN to the omd-mod binary' : 'install it first'}`);
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
      allowImportingTsExtensions: true,
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

function minimalScenarios(name) {
  return {
    'mod.test.json': { schema: 1, virtual_time_ms: 1000, steps: [{ type: 'invoke', mod: name, event: 'command', name: 'hello', payload: 'author', expect: { display: 'Hello author' } }] },
    'debug.test.json': { schema: 1, steps: [{ type: 'invoke', mod: name, event: 'command', name: 'hello', payload: 'fail', expect_error: 'INTENTIONAL_AUTHOR_FAILURE' }] },
  };
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeProjectFiles(directory, name, scenarios) {
  await writeJson(join(directory, 'package.json'), packageJson(name));
  await writeJson(join(directory, 'tsconfig.json'), tsconfig());
  for (const [file, scenario] of Object.entries(scenarios)) await writeJson(join(directory, file), scenario);
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
  await writeProjectFiles(directory, name, minimalScenarios(name));
  lock(directory);
}

async function copyExample(directory, name) {
  if (!publicExamples.includes(name)) fail(`unknown_example: ${name}`);
  const source = join(sdkRoot, 'examples', name);
  if (!statSync(source).isDirectory()) fail(`unknown_example: ${name}`);
  if (existsSync(directory)) fail(`target_exists: ${directory}`);
  cpSync(source, directory, { recursive: true });
  const { id } = JSON.parse(readFileSync(join(directory, 'mod.json'), 'utf8'));
  const debug = { schema: 1, steps: [{ type: 'invoke', mod: id, event: 'command', name: '__intentional_missing__', payload: null, expect_error: 'unsupported_or_unregistered_operation' }] };
  await writeProjectFiles(directory, name, existsSync(join(directory, 'debug.test.json')) ? {} : { 'debug.test.json': debug });
}

async function copyExamples(directory) {
  if (existsSync(directory)) fail(`target_exists: ${directory}`);
  mkdirSync(directory, { recursive: true });
  for (const name of publicExamples) await copyExample(join(directory, name), name);
  await writeJson(join(directory, 'package.json'), { name: 'omd-mod-examples', private: true, scripts: { check: 'pnpm -r check', test: 'pnpm -r test', package: 'pnpm -r package' } });
  await writeFile(join(directory, 'pnpm-workspace.yaml'), "packages:\n  - '*'\n");
}

function jsxSources(directory, folder = '') {
  return readdirSync(join(directory, folder), { withFileTypes: true }).flatMap(entry => {
    const path = folder ? `${folder}/${entry.name}` : entry.name;
    if (entry.isDirectory()) return entry.name.startsWith('.') || ['node_modules', 'dist'].includes(entry.name) ? [] : jsxSources(directory, path);
    return entry.name.endsWith('.tsx') ? [path] : [];
  });
}

function compileJsx(directory) {
  const sources = jsxSources(directory);
  if (!sources.length) return;
  const ts = typescript(directory);
  for (const source of sources) compileJsxFile(ts, directory, source);
}

function typescript(directory) {
  try {
    return createRequire(join(directory, 'package.json'))('typescript');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'MODULE_NOT_FOUND') fail('jsx_requires_typescript: pnpm add -D typescript@5.9.3');
    throw error;
  }
}

function compileJsxFile(ts, directory, source) {
  const { outputText, diagnostics } = ts.transpileModule(readFileSync(join(directory, source), 'utf8'), {
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, jsxImportSource: '@oh-my-diff/mod-api', module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    fileName: source,
    reportDiagnostics: true,
  });
  const errors = diagnostics.filter(diagnostic => diagnostic.category === ts.DiagnosticCategory.Error);
  if (errors.length) fail(errors.map(diagnostic => `${source}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')}`).join('\n'));
  const factory = readFileSync(join(sdkRoot, 'author/jsx-runtime.mjs'), 'utf8').replace(/^export /gm, '');
  const importLine = /^import \{([^}]*)\} from ["']@oh-my-diff\/mod-api\/jsx-runtime["'];?$/m;
  if (/\bFragment\b/.test(importLine.exec(outputText)?.[1] ?? '')) fail('jsx_unsupported_element: fragment');
  const inlined = outputText.replace(importLine, (_match, names) => `const {${names.replaceAll(' as ', ': ')}} = (() => {\n${factory}return { jsx, jsxs };\n})();`)
    .replace(/(\bfrom\s*["']\.\.?\/[^"']*)\.tsx(["'])/g, '$1.ts$2');
  if (inlined.includes('@oh-my-diff/mod-api/jsx-runtime')) fail(`jsx_import_unsupported: ${source} may only use the JSX factory import the compiler emits`);
  const header = `// @ts-nocheck\n// Generated from ${source}; edit that file instead.\n`;
  const generated = `${header}${inlined}`;
  const target = join(directory, source.slice(0, -1));
  const existing = existsSync(target) ? readFileSync(target, 'utf8') : null;
  if (existing !== null && !existing.startsWith(header)) fail(`jsx_entrypoint_conflict: ${source.slice(0, -1)} was not generated from ${source}; remove one of them`);
  if (existing !== generated) writeFileSync(target, generated);
}

function checkSyntax(directory) {
  compileJsx(directory);
  const manifest = JSON.parse(readFileSync(join(directory, 'mod.json'), 'utf8'));
  for (const path of [manifest.entrypoint ?? 'index.ts', ...(manifest.assets ?? []).filter(asset => asset.endsWith('.ts'))]) {
    stripTypeScriptTypes(readFileSync(join(directory, path), 'utf8'));
  }
}

function checkProject(directory) {
  checkSyntax(directory);
  if (!existsSync(join(directory, 'node_modules/.bin/tsc'))) {
    process.stderr.write('Syntax checked; add TypeScript for type checking: pnpm add -D typescript@5.9.3\n');
    return;
  }
  const sources = jsxSources(directory);
  if (!sources.length) return command('pnpm', ['exec', 'tsc', '-p', 'tsconfig.json'], { cwd: directory });
  // TypeScript drops a .tsx from a program that also lists its generated .ts, so check the sources rather than their output.
  const ts = typescript(directory);
  const parsed = ts.getParsedCommandLineOfConfigFile(join(directory, 'tsconfig.json'), {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: diagnostic => fail(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')) });
  const generated = new Set(sources.map(source => resolve(directory, source.slice(0, -1))));
  const files = [...new Set([...parsed.fileNames.map(file => resolve(file)).filter(file => !generated.has(file)), ...sources.map(source => resolve(directory, source))])];
  const jsxConfig = join(directory, 'tsconfig.omd-jsx.json');
  writeFileSync(jsxConfig, JSON.stringify({ extends: './tsconfig.json', include: ['.omd/*.d.ts'], files }));
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
  if (existsSync(join(target, 'package-report.json'))) fail('package_generated_file_conflict');
  const sourceMaps = [];
  for (const path of [entrypoint, ...(inspected.manifest.assets ?? [])].filter(path => path.endsWith('.ts'))) {
    const transformed = stripTypeScriptTypes(readFileSync(join(directory, path), 'utf8'), { mode: 'transform', sourceMap: true, sourceUrl: basename(path) });
    const [javascript, encoded] = transformed.split('\n//# sourceMappingURL=data:application/json;base64,');
    const output = path.slice(0, -3) + '.js';
    if (existsSync(join(target, output)) || existsSync(join(target, output + '.map'))) fail('package_generated_file_conflict');
    await writeFile(join(target, output), `${javascript}\n//# sourceMappingURL=${basename(output)}.map\n`);
    await writeFile(join(target, output + '.map'), Buffer.from(encoded.trim(), 'base64'));
    sourceMaps.push(output + '.map');
  }
  const packaged = engineJson(['inspect', target]);
  if (packaged.sha256 !== inspected.sha256) fail('package_integrity_changed');
  await writeJson(join(target, 'package-report.json'), { api: apiVersion, sha256: packaged.sha256, source_maps: sourceMaps, manifest: packaged.manifest });
  process.stdout.write(`${JSON.stringify({ package: target, sha256: packaged.sha256, source_maps: sourceMaps.map(path => join(target, path)) }, null, 2)}\n`);
}

function watchProject(directory, store, once) {
  let files = new Set(['mod.json']);
  const reload = () => {
    checkSyntax(directory);
    const inspected = engineJson(['inspect', directory]);
    const locked = engineJson(['package-lock', store]).packages;
    const installed = locked[inspected.manifest.id];
    if (installed) {
      if (installed.source.kind !== 'local' || realpathSync(installed.source.path) !== inspected.path || realpathSync(installed.path) !== inspected.path) fail('watch_source_mismatch: use a scratch store with this local package');
      const index = installed.dependencies.map(dependency => locked[dependency.id]?.source).find(source => source?.kind === 'package')?.index;
      const request = JSON.stringify({ action: 'update', source: { kind: 'local', path: inspected.path }, scope: installed.scope, offline: true, index,
        trust: { packages: Object.fromEntries(Object.entries(locked).map(([id, entry]) => [id, entry.trust])) } });
      const preview = engineJson(['package-plan', store, request]);
      if (preview.packages.some(packageEntry => locked[packageEntry.id] && locked[packageEntry.id].scope !== packageEntry.scope)) fail('watch_approval_required: review package scope changes before watching');
      if (preview.changes.packages.some(change => change.renewed_approval || change.state_version.migration_required)) fail('watch_approval_required: review changed package grants, authority or state versions before watching');
      engineJson(['package-apply', store, request, preview.confirmation]);
    } else {
      trustPackage(store, directory);
    }
    files = new Set(['mod.json', inspected.manifest.entrypoint ?? 'index.ts', ...(inspected.manifest.assets ?? []), ...Object.values(inspected.manifest.lifecycle ?? {})]);
    for (const source of jsxSources(directory)) files.add(source);
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
      process.stderr.write(`${JSON.stringify({ reload_failed: directory, error: error instanceof Error ? error.message : String(error) })}\n`);
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
  const [action, rawDirectory = '.', nameOrStore, extra] = process.argv.slice(2).filter(argument => argument !== '--');
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
