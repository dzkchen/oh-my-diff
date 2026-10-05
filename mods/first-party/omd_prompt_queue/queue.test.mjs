import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
const manifest = JSON.parse(readFileSync(new URL('./mod.json', import.meta.url), 'utf8'));
const runner = readFileSync(new URL('../../../runtime/omd/src/mods/runner.mjs', import.meta.url), 'utf8');
const surface = { events: { idle: 'lifecycle', turn_start: 'lifecycle', turn_end: 'lifecycle', terminal: 'terminal' },
  replacements: [], middleware: [], intercept: {}, state: 'store', contracts: 'contracts' };

// The host side: single-use consents bound to content, a draft with a revision and a busy flag.
function host() {
  const world = { consents: new Map(), draft: { text: '', revision: 1, attachments: [] }, busy: false, submitted: [], serial: 0 };
  world.call = ({ operation, arguments: args }) => {
    const digest = JSON.stringify([args?.text, args?.attachments ?? []]);
    switch (operation) {
      case 'composer.read': return { value: { ...world.draft, cursor: world.draft.text.length, selection: null, suggestion: null } };
      case 'composer.write':
        if (args.revision !== world.draft.revision) return { error: 'stale_revision' };
        world.draft = { ...world.draft, text: args.edit.text, revision: world.draft.revision + 1 };
        return { value: { text: world.draft.text, cursor: 0, revision: world.draft.revision } };
      case 'prompts.consent': {
        const id = `c${++world.serial}`;
        world.consents.set(id, { digest, client: null, delivered: false });
        return { value: { consent: id, sha256: 'x' } };
      }
      case 'prompts.revoke': world.consents.delete(args.consent); return { value: { revoked: 1 } };
      case 'prompts.status': {
        const found = world.consents.get(args.consent);
        const state = !found ? 'missing' : !found.client ? 'pending' : found.delivered ? 'delivered' : 'unconfirmed';
        return { value: { state, client_id: found?.client } };
      }
      case 'prompts.submit': {
        const found = world.consents.get(args.consent);
        if (!found) return { error: 'consent_missing' };
        if (found.client) return { error: 'consent_spent' };
        if (found.digest !== digest) return { error: 'consent_content_changed' };
        if ((args.mode === 'turn') === world.busy) return { value: { status: 'not_submitted', reason: world.busy ? 'busy' : 'no_active_turn' } };
        found.client = args.client_id;
        world.submitted.push(`${args.mode}:${args.text}`);
        return { value: { status: args.mode === 'turn' ? 'started' : 'steered', client_id: args.client_id } };
      }
      default: throw new Error(`unexpected host call ${operation}`);
    }
  };
  world.deliver = () => { for (const found of world.consents.values()) if (found.client) found.delivered = true; };
  return world;
}

function run(world, state, event, name, payload) {
  const receipts = [];
  for (;;) {
    const request = { source, filename: 'index.ts', api: manifest.api, capabilities: manifest.capabilities, state, settings: {},
      event, name, payload, receipts, surface, hook_budget_ms: 2000 };
    const output = JSON.parse(spawnSync(process.execPath, ['--no-warnings', '--experimental-vm-modules', '--input-type=module', '--eval', runner],
      { input: JSON.stringify(request), encoding: 'utf8', timeout: 5000 }).stdout);
    if (output.error) throw new Error(output.error);
    if (!output.host_call) return { value: output.value, state: output.state ?? state };
    receipts.push({ call: output.host_call, ...world.call(output.host_call) });
  }
}

test('queued prompts are consented, edited, joined and sent once as the user', () => {
  const world = host();
  let state = null;
  const queue = text => { const out = run(world, state, 'command', 'queue', text); state = out.state; return out.value.display; };
  const fire = (event, payload = {}) => { state = run(world, state, event, '', payload).state; };

  world.busy = true;
  world.draft = { text: 'fix the build', revision: 7, attachments: [] };
  assert.equal(queue('capture'), 'Queued as #1.');
  assert.equal(world.draft.text, '', 'capturing the draft clears it with compare-and-write');
  assert.equal(queue('add run the tests'), 'Queued as #2.');
  assert.equal(queue('add docs'), 'Queued as #3.');
  assert.equal(queue('join 2 3'), 'Joined into #2.');
  assert.equal(queue('edit 1 fix the build first'), '#1 updated.');
  assert.equal(world.consents.size, 2, 'edits and joins revoke the consents they replace');
  assert.equal(queue('move 2 1'), 'Moved #2 to #1.');
  assert.match(queue(''), /1\. \[queued\] run the tests docs\n2\. \[queued\] fix the build first/);

  fire('idle');
  assert.deepEqual(world.submitted, [], 'a busy thread keeps the queue');
  world.busy = false;
  fire('idle');
  fire('idle');
  assert.deepEqual(world.submitted, ['turn:run the tests\n\ndocs'], 'a sent entry is not submitted twice');
  world.deliver();
  fire('turn_start');
  assert.equal(state.entries.length, 1, 'delivered entries leave the queue');

  world.busy = true;
  fire('turn_end', { turn_id: 't', outcome: 'aborted' });
  world.busy = false;
  fire('idle');
  assert.equal(world.submitted.length, 1, 'a stopped turn pauses draining');
  const view = run(world, state, 'terminal', '', { event: 'draw', ledger: null }).value;
  assert.match(view.status[0], /queue 1 paused/);
  assert.deepEqual(view.keybindings, { 'Alt+q': { command: 'queue', args: 'capture' } });
  assert.equal(queue('resume'), 'Queue resumed; the next prompt is sent when the session is idle.');
  assert.deepEqual(world.submitted.at(-1), 'turn:fix the build first');
});

test('a prompt queued while idle is sent at once', () => {
  const world = host();
  const out = run(world, null, 'command', 'queue', 'add now');
  assert.equal(out.value.display, 'Queued as #1.');
  assert.deepEqual(world.submitted, ['turn:now']);
  assert.equal(out.state.entries[0].status, 'sent');
});

test('stale drafts, spent consents and forked threads never resend', () => {
  const world = host();
  let state = null;
  const queue = text => { const out = run(world, state, 'command', 'queue', text); state = out.state; return out.value.display; };
  world.draft = { text: 'draft', revision: 3, attachments: [] };
  const stale = world.call;
  world.call = call => call.operation === 'composer.write' ? { error: 'stale_revision' } : stale(call);
  assert.match(queue('capture'), /draft changed while it was captured/);
  assert.equal(world.consents.size, 0, 'a refused capture leaves no consent');
  world.call = stale;

  world.busy = true;
  assert.equal(queue('add once'), 'Queued as #1.');
  world.busy = false;
  const [id] = world.consents.keys();
  world.consents.get(id).client = 'q1-1';
  world.consents.get(id).delivered = true;
  state = run(world, state, 'idle', '', {}).state;
  assert.equal(state.entries.length, 0, 'a consent spent before a crash is reconciled as delivered');
  assert.deepEqual(world.submitted, []);

  world.busy = true;
  assert.equal(queue('add forked'), 'Queued as #1.');
  world.busy = false;
  world.consents.clear();
  state = run(world, state, 'idle', '', {}).state;
  assert.equal(state.entries[0].status, 'needs_consent');
  assert.equal(queue('retry 1'), '#1 will be sent again.');
  state = run(world, state, 'idle', '', {}).state;
  assert.deepEqual(world.submitted, ['turn:forked']);
});
