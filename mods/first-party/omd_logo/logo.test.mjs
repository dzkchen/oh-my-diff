import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runnerSync } from '../../../tests/mod_runner.mjs';

const surface = {
  events: { terminal: 'terminal', component_event: 'terminal', channel: 'events', timer: 'events', start: 'lifecycle', resume: 'lifecycle', turn_start: 'lifecycle', turn_end: 'lifecycle', idle: 'lifecycle', tool_result: 'lifecycle', agent_end: 'lifecycle', compaction_end: 'lifecycle', app_notification: 'threads' },
  replacements: [], intercept: { render: 'terminal' }, middleware: [], state: 'store', contracts: 'contracts',
};
const source = readFileSync(new URL('index.ts', import.meta.url), 'utf8');
const manifest = JSON.parse(readFileSync(new URL('mod.json', import.meta.url), 'utf8'));
const assets = Object.fromEntries((manifest.assets ?? []).map(asset => [asset, { text: readFileSync(new URL(asset, import.meta.url), 'utf8') }]));
function run(input) {
  const result = runnerSync({ source, assets, filename: 'index.ts', api: manifest.api, surface, capabilities: [], settings: {}, state: null, event: 'inspect', ...input });
  assert.ifError(result.error);
  const output = JSON.parse(result.stdout);
  assert.equal(result.status, 0, `${result.stderr}\n${output.error ?? ''}`);
  assert.equal(output.error, undefined, output.error);
  return output;
}

test('logo follows host acceptance and installed identity without persistent task state', () => {
  const identity = { codex_version: '9.8.7', install_profile: 'full', mode: 'omd', mods: { installed: 6, enabled: 2, active: 0 } };
  const capabilities = ['terminal'];
  const presentation = { thread_id: 'fresh-thread', phase: 'fresh' };
  const payload = { event: 'start', identity, presentation, ledger: null };
  const logo = run({ capabilities, event: 'terminal', payload });
  assert.equal(logo.value.session_title_suffix, ' | OMD+');
  assert.equal(logo.value.greeting, '');
  assert.deepEqual(logo.value.welcome, { show_while_composing: true });
  assert.equal(logo.value.sites.welcome.components[0].children[0].spans[1].text, '╭─╮ ╭╮╭╮ ┌─╮');
  assert.match(JSON.stringify(logo.value), /v9.8.7/);
  assert.equal(logo.state, null);
  for (const event of ['idle', 'input_rejected', 'turn_end']) {
    const draft = run({ capabilities, event: 'terminal', payload: { ...payload, event } });
    assert.deepEqual(draft.value.sites, logo.value.sites);
  }
  for (const phase of ['started', 'resumed']) {
    for (const event of ['start', 'turn_start', 'turn_end', 'idle']) {
      const current = run({ capabilities, state: { settled: false }, event: 'terminal', payload: { ...payload, event, presentation: { ...presentation, phase } } });
      assert.deepEqual(current.value.sites, {});
      assert.equal(current.value.session_title_suffix, ' | OMD+');
    }
  }
  const core = run({ capabilities, settings: { icons: 'ascii' }, event: 'terminal', payload: { ...payload, identity: { ...identity, install_profile: 'platform_only', mods: { installed: 20, enabled: 15, active: 15 } } } });
  assert.equal(core.value.session_title_suffix, ' | OMD Core');
  assert.equal(core.value.sites.welcome.components[1].children[0].spans[1].text, '.-. |\\/| |-.');
  const unreported = run({ capabilities, event: 'terminal', payload: { ...payload, identity: undefined, presentation: undefined } });
  assert.equal(unreported.value.session_title_suffix, undefined);
  assert.deepEqual(unreported.value.sites, {});
});
