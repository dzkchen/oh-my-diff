import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { runnerSync } from './mod_runner.mjs';

const runner = readFileSync(new URL('../runtime/omd/src/mods/runner.mjs', import.meta.url), 'utf8');
const source = readFileSync(new URL('../mods/first-party/omd_recovery/index.ts', import.meta.url), 'utf8');
const manifest = JSON.parse(readFileSync(new URL('../mods/first-party/omd_recovery/mod.json', import.meta.url), 'utf8'));
const native = readFileSync(new URL('../runtime/omd/src/mods.rs', import.meta.url), 'utf8');
const events = native.match(/pub const MOD_EVENTS:[\s\S]*?= &\[([\s\S]*?)\];/)[1];
const surface = { events: Object.fromEntries([...events.matchAll(/\("([a-z_]+)", "([a-z_.]+)"\)/g)].map(match => [match[1], match[2]])),
  replacements: [], middleware: [], state: 'store',
  intercept: Object.fromEntries([...native.match(/pub const MOD_INTERCEPT_SURFACES:[\s\S]*?= &\[([\s\S]*?)\];/)[1].matchAll(/\("([a-z_]+)", "([a-z_.]+)"\)/g)].map(match => [match[1], match[2]])) };
const evidence = { reference: 'evidence:history', sha256: 'b'.repeat(64) };
const routes = [
  { name: 'lead', roles: ['lead', 'worker'], available: true, provider: 'fixture', model: 'lead', billing: 'included_subscription' },
  { name: 'opposite', roles: ['lead', 'worker'], available: true, provider: 'fixture', model: 'opposite', billing: 'included_subscription' },
];

function recover(settings = {}, changes = {}, failure_class = 'edit') {
  const calls = [];
  const receipts = [];
  const request = { source, filename: 'index.ts', api: manifest.api, capabilities: manifest.capabilities,
    state: [{ kind: 'lead', thread: 'thread-1', model: 'lead', provider: 'fixture' }],
    settings: { advisory_route: 'opposite', allowed_failure_classes: ['edit'], evidence_bytes: 100000, ...settings },
    surface, event: 'tool', name: 'recover', payload: { failure_class, summary: 'The exact edit failed', call_ids: ['failed-edit'] }, receipts };
  for (let turn = 0; turn < 24; turn++) {
    const child = runnerSync(request);
    assert.ifError(child.error);
    const reply = JSON.parse(child.stdout);
    if (!reply.host_call) return { reply: reply.value?.status === 'refused' ? { ...reply, error: reply.value.reason } : reply, calls };
    calls.push(reply.host_call);
    const { operation, arguments: args } = reply.host_call;
    const defaults = {
      'task.status': { ledger: { thread_id: 'thread-1' } },
      'store.get': null,
      'routes.list': routes,
      'sessions.snapshot': { evidence, provenance: { sha256: 'b'.repeat(64), bytes: 4096, items: 1, revision: 1 } },
      'workspace.snapshot': { snapshot: { reference: 'snapshot:fixture', sha256: 'a'.repeat(64) } },
      'agents.spawn': { handle: 'advice-1' },
    };
    const value = Object.hasOwn(changes, operation) ? changes[operation]
      : operation === 'store.put' ? { revision: args.expected_revision === null ? 1 : 2 } : defaults[operation];
    assert.notEqual(value, undefined, `unexpected host operation ${operation}`);
    receipts.push({ call: reply.host_call, value });
  }
  assert.fail('recovery callback limit');
}

test('advisory class policy rejects disallowed assertions before host access', () => {
  const { reply, calls } = recover({}, {}, 'environment');
  assert.match(reply.error, /failure_class_not_allowed/);
  assert.deepEqual(calls, []);
});

test('advisory stays on the lead billing class and never spawns a paid fallback', () => {
  const paid = routes.map(route => route.name === 'opposite' ? { ...route, billing: 'explicit_paid_api_grant' } : route);
  const { reply, calls } = recover({}, { 'routes.list': paid });
  assert.match(reply.error, /distinct_same_billing_advisory_route_unavailable/);
  assert.ok(!calls.some(call => ['sessions.snapshot', 'agents.spawn'].includes(call.operation)));
  const ambiguous = [...routes, { ...routes[0], name: 'other-lead', billing: 'explicit_paid_api_grant' }];
  const changed = recover({}, { 'routes.list': ambiguous });
  assert.match(changed.reply.error, /lead_billing_ambiguous_or_unavailable/);
  assert.ok(!changed.calls.some(call => call.operation === 'agents.spawn'));
});

test('oversized or unattributed history cannot admit an advisory agent', () => {
  for (const provenance of [{ bytes: 100001 }, {}]) {
    const { reply, calls } = recover({}, { 'sessions.snapshot': { evidence, provenance } });
    assert.match(reply.error, /advisory_evidence_limit/);
    assert.ok(!calls.some(call => ['store.put', 'agents.spawn'].includes(call.operation)));
  }
});

test('bounded eligible evidence starts one read-only advisory', () => {
  const { reply, calls } = recover();
  assert.equal(reply.value.status, 'running');
  assert.equal(reply.value.route, 'opposite');
  assert.equal(calls.find(call => call.operation === 'sessions.snapshot').arguments.call_ids[0], 'failed-edit');
  assert.equal(calls.find(call => call.operation === 'agents.spawn').arguments.workspace, 'read_only');
  assert.equal(calls.filter(call => call.operation === 'agents.spawn').length, 1);
});
