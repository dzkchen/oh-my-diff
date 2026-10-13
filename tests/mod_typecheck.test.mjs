import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import ts from '../mods/node_modules/typescript/lib/typescript.js';
import { fileURLToPath } from 'node:url';
import { checkedSources } from '../scripts/mod_typecheck_inventory.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const config = name => ts.getParsedCommandLineOfConfigFile(`${root}mods/${name}`, {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: diagnostic => { throw new Error(String(diagnostic.messageText)); } });

test('new shipped JavaScript and TypeScript files fail when no check owns them', () => {
  for (const extension of ['js', 'cjs', 'mjs', 'jsx', 'ts', 'tsx', 'mts', 'cts']) {
    assert.throws(() => checkedSources([`plugins/bundled/new/source.${extension}`], new Map(), new Map()), /shipped_source_not_typechecked/);
  }
});

test('shipped plugin TypeScript and author implementations belong to the typecheck gate', () => {
  const typed = config('tsconfig.json');
  const author = config('tsconfig.author.json');
  assert.ok(typed.fileNames.includes(`${root}plugins/bundled/oh-my-diff/plugins/omd-artifact-reading/mod/index.ts`));
  assert.ok(author.fileNames.includes(`${root}mods/author/cli.mjs`));
  assert.equal(author.options.checkJs, true);
  assert.match(execFileSync(process.execPath, [`${root}scripts/mod_typecheck_inventory.mjs`, '--list'], { encoding: 'utf8' }), /tsconfig.author.json\tmods\/author\/client.mjs/);
});

test('author declaration contracts reject wrong implementation results', () => {
  const parsed = config('tsconfig.author.json');
  const host = ts.createCompilerHost(parsed.options);
  const read = host.readFile.bind(host);
  host.readFile = file => {
    const source = read(file);
    return file.endsWith('/author/testing.mjs') ? source.replace('({ virtual_time_ms: virtualTimeMs })', '({ virtual_time_ms: "wrong" })') : source;
  };
  const program = ts.createProgram(parsed.fileNames, parsed.options, host);
  assert.ok(ts.getPreEmitDiagnostics(program).some(diagnostic => diagnostic.file?.fileName.endsWith('/author/testing.mjs') && diagnostic.code === 2322), 'wrong mock SDK result must fail typechecking');
});
