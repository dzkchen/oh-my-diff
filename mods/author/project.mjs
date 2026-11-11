import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createRequire, stripTypeScriptTypes } from 'node:module';

const sdkRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const engine = process.env.OMD_MOD_BIN || 'omd-mod';

/** @returns {never} */
export function fail(message) {
  throw new Error(message);
}

export function command(program, args, options = {}) {
  const result = spawnSync(program, args, { cwd: options.cwd, encoding: 'utf8', stdio: options.capture ? 'pipe' : 'inherit' });
  if (result.error && 'code' in result.error && result.error.code === 'ENOENT') fail(`${program} was not found on PATH; ${program === engine ? 'reinstall Oh My Diff or set OMD_MOD_BIN to the omd-mod binary' : 'install it first'}`);
  if (result.error) throw result.error;
  if (result.status !== 0) fail((result.stderr || result.stdout || `${program} failed`).trim());
  return options.capture ? result.stdout.trim() : '';
}

export function engineJson(args) {
  return JSON.parse(command(engine, args, { capture: true }));
}

export function jsxSources(directory, folder = '') {
  return readdirSync(join(directory, folder), { withFileTypes: true }).flatMap(entry => {
    const path = folder ? `${folder}/${entry.name}` : entry.name;
    if (entry.isDirectory()) return entry.name.startsWith('.') || ['node_modules', 'dist'].includes(entry.name) ? [] : jsxSources(directory, path);
    return entry.name.endsWith('.tsx') ? [path] : [];
  });
}

export function compileJsx(directory) {
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

export function checkSyntax(directory) {
  compileJsx(directory);
  const manifest = JSON.parse(readFileSync(join(directory, 'mod.json'), 'utf8'));
  for (const path of [manifest.entrypoint ?? 'index.ts', ...(manifest.assets ?? []).filter(asset => asset.endsWith('.ts'))]) {
    stripTypeScriptTypes(readFileSync(join(directory, path), 'utf8'));
  }
}

export function checkProject(directory) {
  checkSyntax(directory);
  engineJson(['inspect', directory]);
  if (!existsSync(join(directory, 'node_modules/.bin/tsc'))) {
    process.stderr.write('Syntax checked; add TypeScript for type checking: pnpm add -D typescript@5.9.3\n');
    return;
  }
  const sources = jsxSources(directory);
  if (!sources.length) return command('pnpm', ['exec', 'tsc', '-p', 'tsconfig.json'], { cwd: directory });
  const ts = typescript(directory);
  const parsed = ts.getParsedCommandLineOfConfigFile(join(directory, 'tsconfig.json'), {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: diagnostic => fail(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')) });
  const generated = new Set(sources.map(source => resolve(directory, source.slice(0, -1))));
  const files = [...new Set([...parsed.fileNames.map(file => resolve(file)).filter(file => !generated.has(file)), ...sources.map(source => resolve(directory, source))])];
  const jsxConfig = join(directory, `tsconfig.omd-jsx-${process.pid}-${Date.now().toString(36)}.json`);
  writeFileSync(jsxConfig, JSON.stringify({ extends: './tsconfig.json', include: ['.omd/*.d.ts'], files }), { flag: 'wx' });
  try {
    command('pnpm', ['exec', 'tsc', '-p', basename(jsxConfig)], { cwd: directory });
  } finally {
    rmSync(jsxConfig, { force: true });
  }
}

export function trustPackage(store, directory) {
  const inspected = engineJson(['inspect', directory]);
  const capabilities = inspected.manifest.capabilities.join(',');
  engineJson(['trust', store, inspected.path, inspected.sha256, capabilities, 'user']);
  engineJson(['enable', store, inspected.path]);
  return inspected;
}

export function copyDeclarations(store, directory) {
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
    engineJson(['init', store]);
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
