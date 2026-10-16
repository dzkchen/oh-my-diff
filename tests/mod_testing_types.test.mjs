import assert from 'node:assert/strict';
import { test } from 'node:test';
import ts from '../mods/node_modules/typescript/lib/typescript.js';

test('normal mock replies and scenario steps preserve operation-specific types', () => {
  const filename = new URL('../mods/testing-types-fixture.mts', import.meta.url).pathname;
  const source = `
import { hostOperations, scenario } from './testing.js';
hostOperations({ 'store.put': [{ arguments: { key: 'x', value: true, expected_revision: null }, result: { revision: 1 }, optional: true }] });
// @ts-expect-error unknown operation
hostOperations({ 'store.pot': [{ result: null }] });
// @ts-expect-error wrong result
hostOperations({ 'store.put': [{ result: { revision: 'one' } }] });
// @ts-expect-error wrong arguments
hostOperations({ 'store.put': [{ arguments: { paths: [] }, result: { revision: 1 } }] });
// @ts-expect-error invalid union of error and result
hostOperations({ 'store.put': [{ result: { revision: 1 }, error: 'bad' }] });
scenario({ steps: [{ type: 'advance_time', ms: 10 }, { type: 'state', mod: 'm' }] });
// @ts-expect-error unknown step
scenario({ steps: [{ type: 'advance', ms: 10 }] });
// @ts-expect-error missing step field
scenario({ steps: [{ type: 'invoke', mod: 'm' }] });
// @ts-expect-error field belonging to another step
scenario({ steps: [{ type: 'reload', ms: 10 }] });
`;
  const options = { strict: true, noEmit: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, types: [] };
  const host = ts.createCompilerHost(options);
  const read = host.readFile;
  host.readFile = path => path === filename ? source : read(path);
  const program = ts.createProgram([filename], options, host);
  const diagnostics = ts.getPreEmitDiagnostics(program);
  assert.equal(diagnostics.length, 0, ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCurrentDirectory: () => process.cwd(), getCanonicalFileName: name => name, getNewLine: () => '\n',
  }));
});
