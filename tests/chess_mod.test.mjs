import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { callback } from './mod_runner.mjs';

const mod = new URL('../mods/first-party/omd_chess/', import.meta.url);
const source = readFileSync(new URL('index.ts', mod), 'utf8');
const manifest = JSON.parse(readFileSync(new URL('mod.json', mod), 'utf8'));
const surface = { events: { terminal: 'terminal', channel: 'events', turn_start: 'lifecycle', turn_end: 'lifecycle' }, replacements: [], middleware: [], state: 'store', contracts: 'contracts' };

function fixture(browser = () => ({ display: 'Opening browser chess…' })) {
  const calls = [];
  let state = null;
  const host = (operation, args) => {
    calls.push({ operation, args });
    if (operation === 'mods.service') return browser(args);
    if (operation === 'terminal.open') return { opened: true };
    return { delivered: 1, dropped: 0 };
  };
  const invoke = (event, payload, name) => {
    const receipts = [];
    const output = callback({ source, filename: 'index.ts', api: manifest.api, capabilities: manifest.capabilities, state, settings: {}, event, name, payload, receipts, surface, hook_budget_ms: 10000 },
      call => host(call.operation, call.arguments), receipts);
    if (output.error) throw new Error(output.error);
    state = output.state;
    return output.value;
  };
  const channel = (name, data) => invoke('channel', { publisher: name.split('/')[0], channel: name, data, correlation: null, sequence: 1, dropped: 0 });
  const status = () => invoke('terminal', { event: 'redraw', ledger: null }).status;
  return { calls, invoke, channel, status, of: operation => calls.filter(call => call.operation === operation).map(call => call.args) };
}

test('/chess opens a user-only Chess.com session beside the conversation and coding turns only notify', () => {
  const f = fixture();
  assert.match(f.invoke('command', '', 'chess').display, /Opening Chess\.com/);
  assert.deepEqual(f.of('events.publish'), [{ channel: 'request', data: 'open' }]);
  f.channel('omd_chess/request', 'open');
  assert.deepEqual(f.of('mods.service'), [{ name: 'omd.browser', method: 'open', input: { session: 'chess', url: 'https://www.chess.com/play/online', user_only: true, zoom: 0.8 } }]);
  assert.equal(f.status(), undefined);
  f.channel('omd_browser/opened', { session: 'default', open: true, display: 'other' });
  assert.equal(f.status(), undefined);
  f.channel('omd_browser/opened', { session: 'chess', open: true, display: 'Browser chess is open beside the conversation.' });
  assert.deepEqual(f.of('terminal.notice').map(notice => [notice.text, notice.kind]), [['Browser chess is open beside the conversation.', 'info']]);
  assert.deepEqual(f.status(), ['♟ Chess.com open']);
  f.invoke('turn_start', { turn_id: 't1' });
  assert.deepEqual(f.status(), ['♟ coding turn running']);
  f.invoke('turn_end', { turn_id: 't1', outcome: 'completed' });
  assert.deepEqual(f.status(), ['♟ coding turn finished']);
  assert.equal(f.of('terminal.notice').at(-1).text, 'Coding turn finished; your game continues');
  assert.equal(f.of('mods.service').length, 1);
  f.channel('omd_browser/closed', { session: 'chess', end: false });
  assert.equal(f.status(), undefined);
  f.invoke('turn_end', { turn_id: 't2', outcome: 'completed' });
  assert.equal(f.of('terminal.notice').length, 2);
  f.channel('omd_chess/request', 'end');
  assert.deepEqual(f.of('mods.service').at(-1).input, { session: 'chess', end: true });
  assert.match(f.invoke('command', 'system', 'chess').display, /system browser: a fallback outside OMD/);
  assert.deepEqual(f.of('terminal.open'), [{ url: 'https://www.chess.com/play/online' }]);
  assert.match(f.invoke('command', 'resign', 'chess').display, /^usage/);
});

test('/chess reports a missing or refusing browser instead of opening', () => {
  const missing = fixture(() => { throw new Error('service_unavailable: omd.browser'); });
  missing.channel('omd_chess/request', 'open');
  assert.deepEqual([missing.of('terminal.notice')[0].kind, missing.status()], ['warning', undefined]);
  assert.match(missing.of('terminal.notice')[0].text, /needs the omd_browser mod/);
  const refused = fixture();
  refused.channel('omd_chess/request', 'open');
  refused.channel('omd_browser/opened', { session: 'chess', open: false, display: 'Session chess must be user-only' });
  assert.deepEqual([refused.of('terminal.notice')[0].kind, refused.status()], ['warning', undefined]);
});
