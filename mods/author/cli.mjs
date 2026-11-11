#!/usr/bin/env node
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, watch } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { stripTypeScriptTypes } from 'node:module';
import { checkProject, checkSyntax, command, compileJsx, copyDeclarations, engine, engineJson, fail, jsxSources, runScenarioObject, trustPackage } from './project.mjs';

const sdkRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// Installed generations are pruned after updates, so projects depend on the SDK through the installer's current link.
const stableSdkRoot = (() => {
  const match = /^(.*)\/releases\/[0-9a-f]{32}(\/prefix\/author\/package)$/.exec(sdkRoot);
  const current = match ? `${match[1]}/current${match[2]}` : null;
  return current && existsSync(current) && realpathSync(current) === realpathSync(sdkRoot) ? current : sdkRoot;
})();
// A managed (curl) install records its release, which publishes the SDK archive collaborators fetch without OMD.
const releaseSpec = (() => {
  try {
    const record = JSON.parse(readFileSync(join(sdkRoot, '../../install.json'), 'utf8'));
    return record.update && `https://github.com/dzkchen/oh-my-diff/releases/download/v${record.version}/mod-api.tgz`;
  } catch { return null; }
})();
const sdkSpec = process.env.OMD_MOD_SDK_SPEC || releaseSpec || `file:${stableSdkRoot}`;
const sdkPackage = JSON.parse(readFileSync(join(sdkRoot, 'package.json'), 'utf8'));
const apiVersion = sdkPackage.version;
const node = process.env.OMD_MOD_NODE || process.execPath;
const publicExamples = sdkPackage.files.filter(file => file.startsWith('examples/')).map(file => file.slice('examples/'.length));

const USAGE = 'usage: omd-mod-author create DIR [ID] | example DIR NAME | examples DIR | check/test/run/debug/package DIR | cost DIR [COMMAND [ARGS_JSON]] [--runs N] | watch DIR STORE [--once] | report/events STORE | diagnostics STORE [OUTPUT] | explain DENIAL\n';
const DEFAULT_COST_RUNS = 10;
const MAX_COST_RUNS = 100;

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
      '@oh-my-diff/mod-api': sdkSpec,
      typescript: process.env.OMD_MOD_TYPESCRIPT_SPEC || '5.9.3',
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

const pretty = value => `${JSON.stringify(value, null, 2)}\n`;
const print = value => process.stdout.write(pretty(value));

async function writeJson(path, value) {
  await writeFile(path, pretty(value));
}

async function writeProjectFiles(directory, name, scenarios) {
  await writeJson(join(directory, 'package.json'), packageJson(name));
  await writeJson(join(directory, 'tsconfig.json'), tsconfig());
  for (const [file, scenario] of Object.entries(scenarios)) await writeJson(join(directory, file), scenario);
}

// A file: SDK installs without the network; any other spec needs it once to record the archive's integrity.
function lock(directory) {
  const result = spawnSync('pnpm', ['install', ...sdkSpec.startsWith('file:') ? ['--offline'] : [], '--silent'], { cwd: directory, encoding: 'utf8' });
  if (result.status !== 0) process.stderr.write('pnpm install did not complete; run pnpm install in the project to link the SDK\n');
}

function agentInstructions(name) {
  return `# ${name}

An Oh My Diff mod. Follow https://github.com/dzkchen/oh-my-diff/blob/main/docs/AGENT_MOD_GUIDE.md.

Check with \`pnpm check\`, test with \`pnpm test\`.
`;
}

async function createProject(directory, name) {
  if (!/^[a-z0-9_]{1,24}$/.test(name)) fail(`invalid_mod_id: ${name}`);
  if (existsSync(directory)) fail(`target_exists: ${directory}`);
  mkdirSync(directory, { recursive: true });
  await writeJson(join(directory, 'mod.json'), { schema: 1, id: name, version: '0.1.0', api: apiVersion, state_version: 1,
    license: 'UNLICENSED', provenance: { maintainer: 'CHANGE ME', source: 'CHANGE ME' }, capabilities: ['commands'] });
  await writeFile(join(directory, 'index.ts'), minimalSource());
  await writeFile(join(directory, 'AGENTS.md'), agentInstructions(name));
  await writeProjectFiles(directory, name, minimalScenarios(name));
  lock(directory);
}

async function copyExample(directory, name) {
  const source = join(sdkRoot, 'examples', name);
  if (!publicExamples.includes(name) || !existsSync(source)) fail(`unknown_example: ${name}`);
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

function runScenario(directory, file) {
  const scenario = JSON.parse(readFileSync(resolve(directory, file), 'utf8'));
  const result = runScenarioObject(directory, scenario, store => {
    copyDeclarations(store, directory);
    checkProject(directory);
  });
  print(result);
}

function runTests(directory) {
  const scenario = existsSync(join(directory, 'mod.test.json'));
  const names = readdirSync(directory);
  const files = names.filter(name => /\.test\.(ts|mjs)$/.test(name));
  const skipped = names.filter(name => name.endsWith('.test.json') && !['mod.test.json', 'debug.test.json'].includes(name));
  if (skipped.length) fail(`unsupported_scenario_files: ${skipped.join(', ')} would not run; \`test\` runs only mod.test.json (put the scenarios in it), \`debug\` runs debug.test.json`);
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
  print({ package: target, sha256: packaged.sha256, source_maps: sourceMaps.map(path => join(target, path)) });
}

function costProject(directory, args) {
  const at = args.indexOf('--runs');
  const runs = at === -1 ? String(DEFAULT_COST_RUNS) : args[at + 1] ?? '';
  if (!/^[1-9]\d*$/.test(runs) || Number(runs) > MAX_COST_RUNS) fail(`cost --runs takes a whole number from 1 to ${MAX_COST_RUNS}`);
  const call = at === -1 ? args : [...args.slice(0, at), ...args.slice(at + 2)];
  if (call.length > 2) fail(USAGE.trim());
  compileJsx(directory);
  const temporary = mkdtempSync(join(tmpdir(), 'omd-mod-author-'));
  const store = join(temporary, 'store');
  try {
    engineJson(['init', store]);
    const { manifest } = trustPackage(store, directory);
    print(JSON.parse(command(engine, ['cost', store, manifest.id, runs, ...call], { capture: true, cwd: temporary })));
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

export function watchProject(directory, store, once) {
  let files = new Set(['mod.json']);
  const reload = () => {
    const manifest = JSON.parse(readFileSync(join(directory, 'mod.json'), 'utf8'));
    files = new Set(['mod.json', manifest.entrypoint ?? 'index.ts', ...(manifest.assets ?? []), ...Object.values(manifest.lifecycle ?? {}), ...jsxSources(directory)]);
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
    const result = engineJson(['reload', store]);
    copyDeclarations(store, directory);
    const status = engineJson(['status', store]);
    const error = status.mods.find(mod => mod.id === inspected.manifest.id)?.error ?? status.rejected?.find(entry => entry.id === inspected.manifest.id)?.reason;
    if (error) {
      if (once) fail(`activation_failed: ${inspected.manifest.id}: ${error}`);
      process.stderr.write(`${JSON.stringify({ activation_failed: inspected.manifest.id, error })}\n`);
      return;
    }
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
  if (['--help', '-h', 'help'].includes(action)) return void process.stdout.write(USAGE);
  const directory = resolve(rawDirectory);
  switch (action) {
    case 'create': return createProject(directory, nameOrStore || basename(directory).replaceAll('-', '_'))
      .then(() => void process.stderr.write(`created ${directory}; next: cd ${directory} && pnpm test\n`));
    case 'example': return copyExample(directory, nameOrStore).then(() => lock(directory));
    case 'examples': return copyExamples(directory);
    case 'check':
      checkProject(directory);
      return void process.stderr.write('check: ok\n');
    case 'test': return runTests(directory);
    case 'run': return runScenario(directory, 'mod.test.json');
    case 'debug': return runScenario(directory, 'debug.test.json');
    case 'package': return packageProject(directory);
    case 'cost': return costProject(directory, process.argv.slice(2).filter(argument => argument !== '--').slice(2));
    case 'watch': return watchProject(directory, resolve(nameOrStore || fail('watch requires STORE')), extra === '--once');
    case 'report':
    case 'events': return print(engineJson([action, directory]));
    case 'diagnostics': return print(engineJson(['diagnostics', directory, resolve(nameOrStore || 'omd-diagnostics.json')]));
    case 'explain': return print(engineJson(['explain', rawDirectory]));
    default:
      process.exitCode = 1;
      return void process.stderr.write(USAGE);
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const emitWarning = process.emitWarning;
  process.emitWarning = (warning, ...rest) => String(warning).includes('stripTypeScriptTypes') ? undefined : emitWarning.call(process, warning, ...rest);
  try {
    await main();
  } catch (error) {
    process.exitCode = 1;
    const message = error instanceof Error ? error.message : String(error);
    const code = error instanceof Error && 'code' in error && typeof error.code === 'string' && !message.startsWith(error.code) ? `${error.code}: ` : '';
    process.stderr.write(`${code}${message}\n`);
  }
}
