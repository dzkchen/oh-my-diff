import ts from '../mods/node_modules/typescript/lib/typescript.js';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function checkedSources(files, coverage, syntaxOnly) {
  return [...new Set(files)].filter(file => !/\.(test|spec)\.[cm]?[jt]sx?$/.test(file))
    .filter(file => /^(mods\/(author|examples|first-party|optional)\/|plugins\/bundled\/).*\.[cm]?[jt]sx?$/.test(file)
      || /^mods\/[^/]+\.d\.[cm]?ts$/.test(file))
    .sort().map(file => {
      const config = coverage.get(file);
      if (!config && !syntaxOnly.has(file)) throw new Error(`shipped_source_not_typechecked: ${file}`);
      return { file, config, reason: syntaxOnly.get(file) };
    });
}

function main() {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const configs = ['mods/tsconfig.json', 'mods/tsconfig.author.json'];
  const coverage = new Map();
  for (const config of configs) {
    const filename = resolve(root, config);
    const parsed = ts.getParsedCommandLineOfConfigFile(filename, {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: diagnostic => { throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')); } });
    if (parsed.errors.length) throw new Error(ts.formatDiagnostics(parsed.errors, { getCanonicalFileName: name => name, getCurrentDirectory: () => dirname(filename), getNewLine: () => '\n' }));
    for (const file of parsed.fileNames) coverage.set(file.slice(root.length), config);
  }
  const files = [...new Set(execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', 'mods', 'plugins/bundled'], { cwd: root, encoding: 'utf8' }).split('\0'))]
    .filter(file => existsSync(resolve(root, file)));
  const syntaxOnly = new Map([
    ['plugins/bundled/oh-my-diff/plugins/omd-code-execution/kernels/bun.mjs', 'Bun runtime kernel'],
    ['mods/examples/approval_desk/client.mjs', 'standalone browser client example'],
    ['mods/examples/external_client/client.mjs', 'standalone browser client example'],
    ['mods/first-party/omd_preview/render.mjs', 'preview renderer sidecar'],
    ['mods/first-party/omd_claude_cli/setup.mjs', 'CLI setup hook'],
    ['mods/first-party/omd_claude_cli/transport.mjs', 'CLI transport sidecar'],
    ['mods/first-party/omd_profiles/setup.mjs', 'profile setup hook'],
    ['mods/first-party/omd_profiles/router.mjs', 'profile router sidecar'],
  ]);
  const sources = checkedSources(files, coverage, syntaxOnly);
  for (const { file, config, reason } of sources) {
    if (reason) execFileSync(process.execPath, ['--check', resolve(root, file)]);
    if (process.argv.includes('--list')) process.stdout.write(`${config ?? `node --check (${reason})`}\t${file}\n`);
  }
  for (const file of syntaxOnly.keys()) if (!files.includes(file)) throw new Error(`stale_source_exception: ${file}`);
  if (!process.argv.includes('--list')) process.stdout.write(`Shipped source checks: ${sources.length - syntaxOnly.size} typed; ${syntaxOnly.size} syntax-only clients/hooks/sidecars.\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
