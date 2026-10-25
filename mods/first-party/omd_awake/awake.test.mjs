import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { callback } from '../../../tests/mod_runner.mjs';

const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
const manifest = JSON.parse(readFileSync(new URL('./mod.json', import.meta.url), 'utf8'));
const NOW = 1_800_000_000_000;
const MINUTE = 60_000;
const BATTERY = (percent, power = 'Battery Power') => `Now drawing from '${power}'\n -InternalBattery-0 (id=1)\t${percent}%; discharging; 3:00 remaining present: true\n`;
const PORTS = 'Hardware Port: Ethernet\nDevice: en1\n\nHardware Port: Wi-Fi\nDevice: en0\nEthernet Address: 00\n';

function machine({ battery = BATTERY(80), thermal = 0, lowPower = 0, agents = [], online = true, broker = true, saved = ['Home', 'Phone'], lid = 'No' } = {}) {
  return { battery, thermal, lowPower, agents, online, broker, saved, lid, leases: 0 };
}

function run(event, payload, state, mac, { settings = {}, now = NOW } = {}) {
  const calls = [];
  const exec = ({ program, argv }) => {
    const ok = stdout => ({ exit_code: 0, stdout, timed_out: false });
    if (program === '/usr/bin/pmset') return ok(mac.battery);
    if (program === '/usr/bin/notifyutil') return ok(`com.apple.system.thermalpressurelevel ${mac.thermal}\ncom.apple.system.lowpowermode ${mac.lowPower}\n`);
    if (program === '/usr/sbin/ioreg') return ok(`  "AppleClamshellCausesSleep" = Yes\n  "AppleClamshellState" = ${mac.lid}\n`);
    if (program === '/sbin/route') return mac.online ? ok('gateway: 192.168.1.1\n') : { exit_code: 1, stdout: '', timed_out: false };
    if (program === '/usr/sbin/networksetup') {
      return ok(argv[0] === '-listallhardwareports' ? PORTS : argv[0] === '-listpreferredwirelessnetworks' ? `Preferred networks on en0:\n${mac.saved.map(name => `\t${name}\n`).join('')}` : '');
    }
    throw new Error(`unexpected ${program}`);
  };
  const output = callback({ source, filename: 'index.ts', api: manifest.api, capabilities: manifest.capabilities, settings, state, event, payload,
    virtual_time_ms: now, hook_budget_ms: 2000 }, call => {
    calls.push(call);
    const args = call.arguments;
    if (call.operation === 'exec.run') return exec(args);
    if (call.operation === 'agents.inventory') return { agents: mac.agents.map(status => ({ status })) };
    if (call.operation === 'power.hold') {
      if (args.lid_closed && !mac.broker) throw new Error('power_unavailable: the authority broker is not deployed');
      mac.leases += 1;
      return { lease: `power-${mac.leases}`, lid_closed: args.lid_closed };
    }
    if (call.operation === 'power.release') return { released: true };
    if (call.operation === 'terminal.notice') return { shown: true };
    if (call.operation === 'terminal.notify') return { delivered: true, method: 'osc9' };
    if (call.operation === 'events.schedule') return args;
    throw new Error(`unexpected ${call.operation}`);
  });
  assert.equal(output.error, undefined, output.error);
  const view = callback({ source, filename: 'index.ts', api: manifest.api, capabilities: manifest.capabilities, settings, state: output.state,
    event: 'terminal', payload: { ledger: null }, virtual_time_ms: now, hook_budget_ms: 2000 }, () => { throw new Error('render calls the host'); });
  return { state: output.state, status: view.value?.status ?? null,
    execs: calls.filter(call => call.operation === 'exec.run' && call.arguments.program === '/usr/sbin/networksetup').map(call => call.arguments.argv.join(' ')),
    calls: calls.filter(call => !['exec.run', 'agents.inventory'].includes(call.operation)).map(({ operation, arguments: args }) => [operation, args]) };
}

const hold = (lid_closed, max = 4 * 60 * MINUTE) => ['power.hold', { reason: 'Oh My Diff agents are working', lid_closed, max_duration_ms: max }];
const ops = calls => calls.map(([operation]) => operation);
const check = delay_ms => ['events.schedule', { key: 'check', delay_ms }];

test('holds lid-closed while a turn runs, winds down through the grace period and then lets the Mac sleep', () => {
  const mac = machine();
  const started = run('turn_start', { turn_id: 't1' }, null, mac);
  assert.deepEqual(started.calls, [hold(true), check(15_000)]);
  assert.deepEqual(started.status, ['awake · lid can close']);
  const again = run('timer', { key: 'check' }, started.state, mac, { now: NOW + MINUTE });
  assert.deepEqual(again.calls, [hold(true, 4 * 60 * MINUTE - MINUTE), ['power.release', { lease: 'power-1' }], check(15_000)]);
  const ended = run('turn_end', { turn_id: 't1', outcome: 'completed' }, again.state, mac, { now: NOW + 2 * MINUTE });
  assert.deepEqual(ended.calls, [check(15_000)]);
  assert.deepEqual(ended.status, ['awake: winding down']);
  assert.deepEqual(run('timer', { key: 'check' }, ended.state, mac, { now: NOW + 3 * MINUTE + 50_000 }).calls, [check(10_000)]);
  const slept = run('timer', { key: 'check' }, ended.state, mac, { now: NOW + 4 * MINUTE });
  assert.deepEqual(slept.calls, [['power.release', { lease: 'power-2' }]]);
  assert.equal(slept.status, null);
});

test('a running subagent keeps the hold after the turn ends', () => {
  const mac = machine();
  const ended = run('turn_end', { turn_id: 't1', outcome: 'completed' }, run('turn_start', { turn_id: 't1' }, null, mac).state, mac);
  mac.agents = ['running', 'completed'];
  const later = run('timer', { key: 'check' }, ended.state, mac, { now: NOW + 5 * MINUTE });
  assert.deepEqual(ops(later.calls), ['power.hold', 'power.release', 'events.schedule']);
  assert.equal(later.state.idle_since, 0);
  mac.agents = ['completed'];
  const idle = run('timer', { key: 'check' }, later.state, mac, { now: NOW + 6 * MINUTE });
  assert.deepEqual(idle.calls, [check(15_000)]);
});

test('without a working broker it warns once and holds idle sleep only, and recovers lid-closed once the broker is back', () => {
  const mac = machine({ broker: false });
  const started = run('turn_start', { turn_id: 't1' }, null, mac);
  assert.deepEqual(ops(started.calls), ['power.hold', 'terminal.notice', 'terminal.notify', 'power.hold', 'events.schedule']);
  assert.match(started.calls[1][1].text, /Lid-closed wake is off \(the authority broker is not deployed\)/);
  assert.deepEqual(started.status, ['awake']);
  assert.deepEqual(started.calls.at(-1), check(MINUTE));
  const quiet = run('timer', { key: 'check' }, started.state, mac, { now: NOW + MINUTE });
  assert.deepEqual(ops(quiet.calls), ['power.hold', 'power.hold', 'power.release', 'events.schedule']);
  mac.broker = true;
  const back = run('timer', { key: 'check' }, quiet.state, mac, { now: NOW + 2 * MINUTE });
  assert.deepEqual(back.status, ['awake · lid can close']);
  assert.equal(back.state.warned, false);
  assert.deepEqual(run('turn_start', { turn_id: 't1' }, null, machine(), { settings: { lid_closed: false } }).calls[0], hold(false));
});

test('safeguards release, notify and stay off until the agents go idle', () => {
  for (const [mac, reason] of [[machine({ battery: BATTERY(20) }), 'battery at 20%'], [machine({ lowPower: 1 }), 'Low Power Mode is on'],
    [machine({ thermal: 2 }), 'the Mac is under heavy thermal pressure']]) {
    const started = run('turn_start', { turn_id: 't1' }, null, mac);
    assert.deepEqual(ops(started.calls), ['terminal.notice', 'terminal.notify', 'events.schedule'], reason);
    assert.match(started.calls[0][1].text, new RegExp(`Stopped keeping the Mac awake: ${reason}`));
    assert.deepEqual(started.status, [`awake off: ${reason}`.slice(0, 40)]);
  }
  assert.deepEqual(ops(run('turn_start', { turn_id: 't1' }, null, machine({ battery: BATTERY(5, 'AC Power') })).calls), ['power.hold', 'events.schedule']);

  const settings = { max_hours: 1 };
  const mac = machine();
  const held = run('turn_start', { turn_id: 't1' }, null, mac, { settings });
  const limit = run('timer', { key: 'check' }, held.state, mac, { settings, now: NOW + 60 * MINUTE });
  assert.deepEqual(ops(limit.calls), ['power.release', 'terminal.notice', 'terminal.notify', 'events.schedule']);
  const turnEnded = run('turn_end', { turn_id: 't1', outcome: 'completed' }, limit.state, mac, { settings, now: NOW + 61 * MINUTE });
  const nextTurn = run('turn_start', { turn_id: 't2' }, turnEnded.state, mac, { settings, now: NOW + 62 * MINUTE });
  assert.deepEqual(ops(nextTurn.calls), ['events.schedule']);
  const finished = run('turn_end', { turn_id: 't2', outcome: 'completed' }, nextTurn.state, mac, { settings, now: NOW + 63 * MINUTE });
  assert.equal(finished.state.paused, 'reached the 1 h limit');
  const idle = run('timer', { key: 'check' }, finished.state, mac, { settings, now: NOW + 65 * MINUTE });
  assert.equal(idle.state.paused, null);
  assert.deepEqual(ops(run('turn_start', { turn_id: 't3' }, idle.state, mac, { settings, now: NOW + 66 * MINUTE }).calls), ['power.hold', 'events.schedule']);
});

test('with the lid closed it rejoins known Wi-Fi, then keeps joining the hotspot, and gives up after a bounded number of tries', () => {
  const settings = { hotspot_ssid: 'Phone' };
  const unsaved = run('turn_start', { turn_id: 't1' }, null, machine({ saved: ['Home'] }), { settings });
  assert.match(unsaved.calls.find(([op]) => op === 'terminal.notice')[1].text, /Phone isn't a saved Wi-Fi network/);
  const mac = machine({ lid: 'Yes' });
  const started = run('turn_start', { turn_id: 't1' }, null, mac, { settings });
  assert.deepEqual(ops(started.calls), ['power.hold', 'events.schedule']);
  let state = started.state;
  mac.online = false;
  mac.lid = 'No';
  assert.deepEqual(run('timer', { key: 'check' }, state, mac, { settings }).execs, []);
  mac.lid = 'Yes';
  const actions = [];
  for (let attempt = 1; attempt <= 21; attempt += 1) {
    const checked = run('timer', { key: 'check' }, state, mac, { settings, now: NOW + attempt * 15_000 });
    assert.deepEqual(checked.calls.at(-1), check(attempt <= 20 ? 15_000 : MINUTE));
    if (attempt === 21) assert.match(checked.calls.find(([op]) => op === 'terminal.notice')[1].text, /Couldn't rejoin Wi-Fi or the Phone hotspot/);
    state = checked.state;
    assert.equal(state.offline, attempt);
    actions.push(checked.execs.filter(argv => !argv.startsWith('-list')).join(', '));
  }
  const toggle = '-setairportpower en0 off, -setairportpower en0 on', join = '-setairportnetwork en0 Phone';
  assert.deepEqual(actions, [toggle, ...Array(19).fill(join), '']);
  mac.online = true;
  const back = run('timer', { key: 'check' }, state, mac, { settings, now: NOW + 6 * MINUTE });
  assert.equal(back.state.offline, 0);
  assert.deepEqual(back.calls.at(-1), check(15_000));
});
