import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { callback } from '../../../tests/mod_runner.mjs';

const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
const manifest = JSON.parse(readFileSync(new URL('./mod.json', import.meta.url), 'utf8'));
const identity = install_profile => ({ codex_version: '0.167.0', omd_version: '1.2.3', install_profile, mode: 'omd', mods: { installed: 9, enabled: 7, active: 6 } });

function render(payload, settings = {}) {
  const reply = callback({ source, filename: 'index.ts', api: manifest.api, capabilities: manifest.capabilities, state: null, settings, event: 'terminal', payload }, call => assert.fail(`unexpected host call ${call.operation}`));
  assert.equal(reply.error, undefined, reply.error);
  return reply.value;
}
const text = component => [component.text, ...(component.spans ?? []).map(span => span.text), ...(component.children ?? []).map(text)].filter(Boolean).join('');

test('a fresh session shows the mark with the version and profile, leaving the mod count to the status line', () => {
  const patch = render({ identity: identity('platform_only'), presentation: { phase: 'fresh', surface: 'fullscreen' } });
  assert.equal(patch.session_title_suffix, ' | OMD Core');
  const [wide] = patch.sites.welcome.components;
  assert.equal(wide.id, 'omd_logo_mark');
  assert.match(text(wide), /oh my diff v1\.2\.3 · OMD Core/);
  assert.match(text(wide), /Codex v0\.167\.0/);
  assert.doesNotMatch(text(wide), /mods on/);
});

test('an unknown profile drops the suffix, ascii swaps the mark and later phases draw nothing', () => {
  const plain = render({ identity: identity('private'), presentation: { phase: 'fresh', surface: 'fullscreen' } }, { icons: 'ascii' });
  assert.equal(plain.session_title_suffix, undefined);
  assert.match(text(plain.sites.welcome.components[0]), /\.-\. \|\\\/\| \|-\./);
  assert.doesNotMatch(text(plain.sites.welcome.components[0]), /[╭│╰]/);
  assert.deepEqual(render({ identity: identity('full'), presentation: { phase: 'active', surface: 'fullscreen' } }).sites, {});
});
