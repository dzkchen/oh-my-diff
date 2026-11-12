import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { callback } from '../../../tests/mod_runner.mjs';

const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
const manifest = JSON.parse(readFileSync(new URL('./mod.json', import.meta.url), 'utf8'));
const settings = { checks: 'on', auto: 'off', channel: 'stable', cadence: 'daily', pin: '' };

function run(event, payload, state, { info, name = '', answers = {} } = {}) {
  const calls = [];
  const reply = callback({ source, filename: 'index.ts', api: manifest.api, capabilities: manifest.capabilities, state, settings, event, name, payload }, call => {
    calls.push(call);
    if (call.operation in answers) return answers[call.operation](call.arguments);
    if (call.operation === 'environment.read') return { values: info === undefined ? {} : { OH_MY_DIFF_UPDATE: { value: JSON.stringify(info) } } };
    assert.fail(`unexpected host call ${call.operation}`);
  });
  assert.equal(reply.error, undefined, reply.error);
  return { ...reply, calls };
}
const fresh = { presentation: { phase: 'fresh', surface: 'fullscreen' } };
const welcome = patch => patch.sites.welcome.components.filter(item => item.type === 'text').map(item => item.text.replace(/\n/g, ' '));

test('a new release is announced once on a fresh screen and not again within a day', () => {
  const info = { installed: '1.0.0', checked_at: 1, available: { version: '1.1.0', notes: 'Faster.' } };
  const started = run('start', {}, null, { info });
  assert.deepEqual(started.state.banner, ['Oh My Diff 1.1.0 is out; you have 1.0.0. Run omd update in a shell, or /update for the notes.']);
  const drawn = run('terminal', fresh, started.state);
  assert.match(welcome(drawn.value)[0], /^Oh My Diff 1\.1\.0 is out/);
  assert.equal(drawn.state.shown.version, '1.1.0');
  assert.deepEqual(run('start', {}, drawn.state, { info }).state.banner, []);
});

test('/update queues the offered release, and later or skip silence it', () => {
  const state = run('start', {}, null, { info: { installed: '1.0.0', available: { version: '1.1.0' } } }).state;
  const puts = [];
  const queued = run('command', 'request', state, { name: 'update', answers: {
    'store.get': () => ({ value: null, revision: 'r1' }),
    'store.put': args => { puts.push(args); return { revision: 'r2' }; },
  } });
  assert.deepEqual(puts, [{ key: 'request', value: { id: '1.1.0#1', version: '1.1.0' }, expected_revision: 'r1', scope: 'user' }]);
  assert.equal(queued.state.open, true);
  assert.equal(queued.state.requests, 1);
  assert.match(queued.state.notice, /installs the next time OMD starts/);
  const skipped = run('command', 'skip', state, { name: 'update' }).state;
  assert.equal(skipped.skipped, '1.1.0');
  assert.deepEqual(run('start', {}, skipped, { info: { installed: '1.0.0', available: { version: '1.1.0' } } }).state.banner, []);
  assert.equal(run('command', 'later', state, { name: 'update' }).state.snoozed.version, '1.1.0');
});

test('a setting choice is validated and written through settings.write', () => {
  const state = run('start', {}, null, { info: { installed: '1.0.0' } }).state;
  assert.equal(run('command', 'channel beta', state, { name: 'update' }).state.notice, 'channel takes stable or prerelease or nightly');
  const written = run('command', 'channel nightly', state, { name: 'update', answers: { 'settings.write': args => { assert.deepEqual(args, { values: { channel: 'nightly' } }); return null; } } });
  assert.deepEqual(written.state.overrides, { channel: 'nightly' });
  const dialog = run('terminal', {}, written.state).value.sites.dialog.components[1];
  assert.match(dialog.children.find(item => item.id === 'omd_update_settings').text, /channel nightly/);
});

test('an install without update info shows only the unmanaged notice', () => {
  const state = run('start', {}, null).state;
  const dialog = run('terminal', {}, { ...state, open: true }).value.sites.dialog.components[1];
  assert.deepEqual(dialog.children.map(item => item.id), ['omd_update_header', 'omd_update_unmanaged', 'omd_update_close']);
});

test('a blocked release is not reported as the newest one', () => {
  const ids = info => run('terminal', {}, { ...run('start', {}, null, { info }).state, open: true }).value.sites.dialog.components[1].children.map(item => item.id);
  const blocked = ids({ installed: '1.0.0', checked_at: 1, blocked: { version: '1.1.0', reasons: ['built for x86_64-apple-darwin'] } });
  assert.ok(blocked.includes('omd_update_blocked'));
  assert.ok(!blocked.includes('omd_update_current'));
  assert.ok(ids({ installed: '1.0.0', checked_at: 1 }).includes('omd_update_current'));
});

test('an update names retired mods, new default mods left off and new permissions', () => {
  const last = { from: '1.0.0', to: '1.1.0', at: 5, retired: ['omd_old'], left_off: ['omd_new'], capabilities: { omd_git: ['exec'] } };
  const info = { installed: '1.1.0', checked_at: 1, last, last_mods: { serial: 2, changed: ['omd_logo'], at: 6, capabilities: { omd_logo: ['network'] }, catalog_updated: ['omd_usage'], needs_review: ['omd_git'] } };
  const state = run('start', {}, null, { info }).state;
  assert.deepEqual(state.banner, [
    'Oh My Diff was updated from 1.0.0 to 1.1.0. Retired and turned off: omd_old. New default mods, left off (turn them on in /mods): omd_new. New permissions: omd_git (exec).',
    'First-party mods were updated: omd_logo. New permissions: omd_logo (network). Updated mods you installed from the catalog: omd_usage. '
      + 'These installed mods need your review before they update; run omd mods update ID for each: omd_git.',
  ]);
  const children = run('terminal', {}, { ...state, open: true }).value.sites.dialog.components[1].children;
  assert.match(children.find(item => item.id === 'omd_update_last').text.replace(/\n/g, ' '), /^From 1\.0\.0: Retired and turned off: omd_old\. .*omd_git \(exec\)\.$/);
  assert.match(children.find(item => item.id === 'omd_update_last_mods').text, /omd_logo \(network\)/);
});

test('a waiting first-party mod update opens a dialog whose ids are all unique', () => {
  const mods = { omd: '1.4.2', serial: 1, changed: ['omd_theme', 'omd_privacy'] };
  const info = { installed: '1.4.2', checked_at: 1, mods, pending_mods: mods, blocked: { version: '1.5.0', reasons: ['upstream Codex 0.167.x is required'] } };
  const children = run('terminal', {}, { ...run('start', {}, null, { info }).state, open: true }).value.sites.dialog.components[1].children;
  const ids = children.map(item => item.id);
  assert.equal(new Set(ids).size, ids.length, ids.join(' '));
  assert.ok(ids.includes('omd_update_mods_out') && ids.includes('omd_update_mods'));
});

test('a mod update that only adds mods or refreshes the directory names no empty update list', () => {
  const mods = { omd: '1.4.2', serial: 2, changed: ['omd_new'], added: ['omd_new'] };
  const offered = run('start', {}, null, { info: { installed: '1.4.2', checked_at: 1, mods } }).state;
  assert.deepEqual(offered.banner, ['New first-party mods are out: omd_new. Run omd update in a shell, or /update.']);
  const children = run('terminal', {}, { ...offered, open: true }).value.sites.dialog.components[1].children;
  assert.match(children.find(item => item.id === 'omd_update_mods_out').text.replace(/\n/g, ' '), /^New first-party mods are out: omd_new\. Your/);
  const banner = last_mods => run('start', {}, null, { info: { installed: '1.4.2', checked_at: 1, last_mods } }).state.banner;
  assert.deepEqual(banner({ serial: 2, changed: [], at: 6, added: ['omd_new'] }), ['New mods, off until you install them (omd install ID or /mods): omd_new.']);
  assert.deepEqual(banner({ serial: 2, changed: [], at: 6 }), ['The mod directory was updated.']);
});
