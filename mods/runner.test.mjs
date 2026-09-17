import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
const runner = readFileSync(new URL('../runtime/omd/src/mods/runner.mjs', import.meta.url), 'utf8');
function run(source, extra = {}) {
  const result = spawnSync(process.execPath, ['--no-warnings', '--experimental-vm-modules', '--input-type=module', '--eval', runner], {
    input: JSON.stringify({ source, filename: 'fixture.ts', capabilities: [], state: null, settings: {}, event: 'inspect', ...extra }),
    encoding: 'utf8', timeout: 5000,
  });
  assert.ifError(result.error);
  return JSON.parse(result.stdout);
}
test('typed module context callback', () => {
  const reply = run('export default (api: any) => api.on("context", () => ({text:"hello"}))', { capabilities: ['context'], event: 'context' });
  assert.deepEqual(reply.value, { text: 'hello' });
});
test('capability and imports fail visibly', () => {
  assert.match(run('export default api => api.on("context", () => null)').error, /capability_denied/);
  assert.match(run('import fs from "node:fs"; export default () => {}').error, /unsupported_import/);
  assert.match(run('export default api => api.unsupported("provider.register")').error, /unsupported_operation/);
});
test('no ambient process, fetch, or code generation', () => {
  for (const expression of ['process.env', 'fetch("https://example.org")', 'Function("return process")()']) {
    assert.ok(run(`export default () => { ${expression} }`).error);
  }
});
test('duplicate registrations rejected', () => {
  assert.match(run('export default api => { api.command("a", () => null); api.command("a", () => null) }', { capabilities: ['commands'] }).error, /conflict/);
});
test('persistent state passed through tool invocation', () => {
  const source = 'export default api => api.tool({ name:"count", description:"count", parameters:{type:"object",properties:{}} }, () => { api.state.set(api.state.get()+1); return api.state.get(); })';
  const reply = run(source, { capabilities: ['tools','state'], state: 9, event: 'tool', name: 'count' });
  assert.equal(reply.state, 10);
  assert.equal(reply.value, 10);
});
test('infinite loops interrupted and oversized output rejected', () => {
  assert.match(run('export default () => { while(true) {} }').error, /timed out/);
  assert.match(run('export default api => api.command("large", () => "x".repeat(70000))', {capabilities:['commands'],event:'command',name:'large'}).error, /output_limit/);
});
