import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { callback } from '../../../../../tests/mod_runner.mjs';
import { excerpt, htmlText, limitFor, size } from './mod/budget.ts';

const mod = new URL('./mod/', import.meta.url);
const read = name => readFileSync(new URL(name, mod), 'utf8');
const manifest = JSON.parse(read('mod.json'));
const assets = Object.fromEntries(manifest.assets.map(name => [name, { text: read(name), sha256: '0'.repeat(64) }]));
const BUDGET = { result_bytes: 6144, turn_bytes: 49_152, floor_bytes: 2048 };

function host() {
  const entries = new Map();
  const evidence = new Map();
  let revision = 0;
  return {
    entries, evidence, originals: new Map(), invoked: [], pageBytes: 65_536,
    ops: {
      'store.get': ({ key }) => entries.get(key) ?? null,
      'store.put': ({ key, value, expected_revision }) => {
        if ((entries.get(key)?.revision ?? null) !== expected_revision) throw new Error('store_revision_conflict');
        entries.set(key, { value, revision: ++revision, provenance: {} });
        return { revision };
      },
      'store.delete': ({ key, expected_revision }) => {
        if (entries.get(key)?.revision !== expected_revision) throw new Error('store_revision_conflict');
        return { deleted: entries.delete(key) };
      },
    },
  };
}

function bind(world) {
  const sha = text => createHash('sha256').update(text).digest('hex');
  const keep = text => {
    const reference = { reference: `r${world.evidence.size}`, sha256: sha(`record${text}`) };
    world.evidence.set(reference.reference, text);
    return reference;
  };
  return {
    ...world.ops,
    'tools.original': ({ call_id }) => {
      const text = world.originals.get(call_id);
      if (text === undefined) throw new Error('tool_original_unavailable: the call\'s result is not in an interceptor chain');
      return { reference: keep(text), sha256: sha(text), bytes: Buffer.byteLength(text) };
    },
    'evidence.write': ({ media_type, base64 }) => {
      assert.equal(media_type, 'application/octet-stream', 'inline text evidence pages back as its JSON record');
      return keep(Buffer.from(base64, 'base64').toString('utf8'));
    },
    'evidence.read': ({ reference, cursor = 0, max_bytes }) => {
      const bytes = Buffer.from(world.evidence.get(reference.reference));
      const end = Math.min(bytes.length, cursor + Math.min(max_bytes, world.pageBytes));
      return { reference, text: bytes.subarray(cursor, end).toString('utf8'), cursor: end < bytes.length ? end : null, bytes: end - cursor };
    },
    'tools.invoke': call => {
      world.invoked.push(call);
      return world.fetched(call);
    },
  };
}

function run(world, event, name, payload, settings = {}) {
  const calls = [];
  const ops = bind(world);
  const output = callback({ source: read('index.ts'), filename: fileURLToPath(new URL('index.ts', mod)), entrypoint: 'index.ts', assets, api: manifest.api,
    capabilities: manifest.capabilities, environment: manifest.environment, state: null, settings, event, name, payload, hook_budget_ms: 10_000 }, call => {
    calls.push(call);
    const handler = world.next && call.operation === 'continuation.next' ? world.next : ops[call.operation];
    if (!handler) assert.fail(`unexpected ${call.operation}`);
    return handler(call.arguments);
  });
  if (output.error) throw new Error(output.error);
  return { value: output.value, calls };
}

function intercept(world, call, result, { callId = 'c1', original = result.output, settings } = {}) {
  const input = { ...call, call_id: callId, thread_id: 't', agent_id: null, schema: null, raw_arguments: JSON.stringify(call.arguments), batch: null };
  world.originals.set(callId, original);
  let sent = null;
  world.next = effective => {
    sent = effective.input;
    return { result: { truncated: Buffer.byteLength(original) > Buffer.byteLength(result.output), bytes: Buffer.byteLength(original), ...result }, trace: [] };
  };
  const out = run(world, 'intercept', '0', { surface: 'tool', input, original: input, origin: { caller: 'model', thread_id: 't' } }, settings);
  world.next = null;
  return { ...out, value: out.value?.result, sent };
}

const tool = (world, name, args) => run(world, 'tool', name, args).value;
const exec = (cmd, extra = {}) => ({ tool: 'exec_command', arguments: { cmd, ...extra } });
const shell = (body, code = 1) => `Chunk ID: a1\nWall time: 41.0 seconds\nProcess exited with code ${code}\nOriginal token count: ${Math.ceil(body.length / 4)}\nOutput:\n${body}`;
const build = Array.from({ length: 3000 }, (_, index) => index === 1700 ? 'error[E0308]: mismatched types in src/lib.rs:42' : index === 2100 ? 'warning: unused variable `x`' : `   Compiling crate-${index} v0.1.${index}`).join('\n');

test('a result within budget passes through and counts toward the turn', () => {
  const world = host();
  run(world, 'turn_start', '', { turn_id: 'turn-1' });
  const small = { output: shell('ok\n', 0), success: true };
  const out = intercept(world, exec('ls'), small);
  assert.equal(out.value.output, small.output);
  assert.equal(world.entries.get('turn').value.delivered, size(small.output));
  assert.ok(!out.calls.some(call => call.operation === 'tools.original'));
});

test('a large build log becomes a bounded excerpt keeping exit status, ends and the error lines', () => {
  const world = host();
  const result = { output: shell(build), success: false };
  const out = intercept(world, exec('cargo build'), result);
  const text = out.value.output;
  assert.ok(size(text) <= BUDGET.result_bytes, String(size(text)));
  assert.equal(out.value.success, false);
  assert.match(text, /^Chunk ID: a1\nWall time: 41.0 seconds\nProcess exited with code 1\n/);
  assert.match(text, /Compiling crate-0 v0\.1\.0/);
  assert.match(text, /Compiling crate-2999 v0\.1\.2999$/m);
  assert.match(text, /L1706: error\[E0308\]: mismatched types/);
  assert.match(text, /L2106: warning: unused variable/);
  const id = /full output (out_[0-9a-f]{12})/.exec(text)[1];
  assert.deepEqual(world.entries.get('outs').value, [id]);
  assert.equal(world.entries.get(`out/${id}`).value.label, 'cargo build');
  assert.equal(out.sent.arguments.max_output_tokens, 65_536, 'unset max_output_tokens is widened so the kept output is complete');
  assert.equal(out.sent.arguments.cmd, 'cargo build', 'the command itself is never rewritten');
  assert.equal(intercept(host(), exec('cargo build', { max_output_tokens: 500 }), result).sent.arguments.max_output_tokens, 500);
});

test('the full output stays retrievable by line across evidence pages and searchable', () => {
  const world = host();
  world.pageBytes = 4096;
  const out = intercept(world, exec('cargo build'), { output: shell(build), success: false });
  const id = /full output (out_[0-9a-f]{12})/.exec(out.value.output)[1];
  const page = tool(world, 'read', { id, line: 1705, lines: 3 });
  const body = shell(build).split('\n');
  assert.deepEqual(page.text.split('\n'), body.slice(1704, 1707));
  assert.equal(page.next_line, 1708);
  const found = tool(world, 'search', { query: 'mismatched types' });
  assert.equal(found.matches[0].id, id);
  assert.equal(found.matches[0].line, 1706);
  assert.match(found.matches[0].text, /mismatched types/);
});

test('once the turn budget is spent every large result is cut to the floor', () => {
  const world = host();
  run(world, 'turn_start', '', { turn_id: 'turn-1' });
  world.entries.get('turn').value.delivered = BUDGET.turn_bytes - 100;
  const out = intercept(world, exec('cargo test'), { output: shell(build), success: false }, { callId: 'c2' });
  assert.ok(size(out.value.output) <= BUDGET.floor_bytes + 700, String(size(out.value.output)));
  assert.equal(limitFor(BUDGET.turn_bytes, BUDGET), BUDGET.floor_bytes);
  run(world, 'turn_start', '', { turn_id: 'turn-2' });
  assert.equal(world.entries.get('turn').value.delivered, 0);
});

test('without the full output the result falls back to a head and tail as large as Codex would send', () => {
  const world = host();
  const result = { output: shell(build), success: false };
  world.originals.delete('c1');
  const input = { ...exec('cargo build'), call_id: 'c1', thread_id: 't', agent_id: null, schema: null, raw_arguments: '{}', batch: null };
  world.next = () => ({ result: { ...result, truncated: false, bytes: Buffer.byteLength(result.output) }, trace: [] });
  const out = run(world, 'intercept', '0', { surface: 'tool', input, original: input, origin: { caller: 'model', thread_id: 't' } });
  const text = out.value.result.output;
  assert.ok(size(text) <= 40_200, String(size(text)));
  assert.ok(text.startsWith(result.output.slice(0, 1000)));
  assert.ok(text.endsWith(result.output.slice(-1000)));
  assert.match(text, /bytes omitted; the full output could not be kept \(tool_original_unavailable/);
});

test('fetch runs curl through the session command tool, keeps the text and refuses unsafe URLs', () => {
  const world = host();
  world.fetched = () => ({ call_id: 'mod-omd_output_budget-1', output: shell('<!doctype html><html><head><title>Guide &amp; API</title><script>x()</script></head><body><h2>Install</h2><p>Run <code>pnpm add x</code>.</p><h2>Retry policy</h2><p>Backoff doubles.</p></body></html>', 0), success: true, truncated: false });
  const page = tool(world, 'fetch', { url: 'https://docs.example.com/guide' });
  assert.equal(world.invoked[0].tool, 'exec_command');
  assert.match(world.invoked[0].arguments.cmd, /^curl -fsSL .* -- 'https:\/\/docs\.example\.com\/guide'$/);
  assert.equal(page.title, 'Guide & API');
  assert.deepEqual(page.headings, ['## Install', '## Retry policy']);
  assert.equal(tool(world, 'search', { query: 'backoff', id: page.id }).matches[0].text, 'Backoff doubles.');
  for (const url of ["https://x.com/a'b", 'file:///etc/passwd', 'https://x.com/$(id)', 'https://x.com/a b']) assert.match(tool(world, 'fetch', { url }).error, /url must be/);
  world.fetched = () => ({ call_id: 'm', output: shell('curl: (22) 404', 22), success: true, truncated: false });
  assert.match(tool(world, 'fetch', { url: 'https://docs.example.com/missing' }).error, /exit 22/);
});

test('the component skips its own invoked calls', () => {
  const world = host();
  const result = { output: shell(build), success: true };
  assert.equal(intercept(world, exec('curl x'), result, { callId: 'mod-omd_output_budget-3' }).value.output, result.output);
});

test('excerpts are deterministic and html text keeps structure', () => {
  const body = shell(build);
  assert.equal(excerpt(body, 6144, 'out_x', size(body)), excerpt(body, 6144, 'out_x', size(body)));
  assert.match(excerpt(`x\n${'y'.repeat(5000)}\nz`, 2048, 'out_x', 5004), /…\[\+\d+ bytes\]/);
  assert.equal(htmlText('<ul><li>a</li><li>b&#x21;</li></ul>').text, '- a\n- b!');
});

test('read clips a line longer than its byte cap and continues from the returned cursor; search by id finds rare words', () => {
  const world = host();
  const body = `${'x'.repeat(70_000)}\n${Array.from({ length: 400 }, (_, index) => index === 300 ? 'ENOENT: no such file config.json' : `ok step ${index}`).join('\n')}`;
  const out = intercept(world, exec('node build.js'), { output: shell(body), success: false });
  const id = /full output (out_[0-9a-f]{12})/.exec(out.value.output)[1];
  const long = tool(world, 'read', { id, line: 6, lines: 5, max_bytes: 4096 });
  assert.match(long.text, /^x+…\[line continues: \d+ more bytes\]$/);
  assert.equal(long.next_line, 7);
  const next = tool(world, 'read', { id, line: long.next_line, cursor: long.next_cursor, lines: 2 });
  assert.deepEqual(next.text.split('\n'), ['ok step 0', 'ok step 1']);
  const later = tool(world, 'read', { id, line: next.next_line, cursor: next.next_cursor, lines: 1 });
  assert.equal(later.text, 'ok step 2');
  assert.equal(tool(world, 'search', { query: 'ENOENT config', id }).matches[0].line, 307);
});

test('a long single line keeps a window around its first error, as code-mode cells print one JSON line per call', () => {
  const cell = `{"chunk_id":"a","exit_code":1,"output":"${Array.from({ length: 800 }, (_, index) => index === 500 ? 'AssertionError: 2.0 != 4' : `test_${index} ok`).join('\\n')}"}`;
  const text = excerpt(`Script completed\nOutput:\n${cell}\n${cell}`, 4096, 'out_x', 2 * cell.length);
  assert.match(text, /AssertionError: 2\.0 != 4/);
  assert.ok(size(text) <= 4096);
});
