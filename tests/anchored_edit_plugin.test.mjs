import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { callback } from './mod_runner.mjs';

const root = new URL('../plugins/bundled/oh-my-diff/plugins/omd-anchored-edit/mod/', import.meta.url);
const source = readFileSync(new URL('index.ts', root), 'utf8');
const manifest = JSON.parse(readFileSync(new URL('mod.json', root), 'utf8'));
const digest = text => createHash('sha256').update(text).digest('hex');

function invoke(payload, host, extra = {}) {
  const request = { source, filename: 'index.ts', api: manifest.api, capabilities: manifest.capabilities, state: null, settings: {}, event: 'tool', name: 'edit', payload, ...extra };
  const reply = callback(request, host);
  if (reply.error) throw new Error(reply.error);
  return reply;
}

function workspace(initial, overrides = {}) {
  const files = { ...initial };
  const calls = [];
  return { files, calls, host(call) {
    calls.push(call);
    if (overrides[call.operation]) return overrides[call.operation](call);
    if (call.operation === 'workspace.stat') return { files: Object.fromEntries(call.arguments.paths.map(path => [path, Object.hasOwn(files, path) ? { kind: 'file', size: Buffer.byteLength(files[path]), mtime_ms: 0 } : null])) };
    if (call.operation === 'workspace.read') return { files: Object.fromEntries(call.arguments.paths.map(path => [path, Object.hasOwn(files, path) ? { text: files[path], sha256: digest(files[path]) } : null])) };
    assert.equal(call.operation, 'workspace.transaction');
    for (const [path, hash] of Object.entries(call.arguments.expected)) assert.equal(digest(files[path]), hash);
    Object.assign(files, call.arguments.writes);
    return { files: Object.fromEntries(Object.keys(call.arguments.writes).map(path => [path, digest(files[path])])), backup: null };
  } };
}

const anchored = (name, payload, host) => invoke(payload, host.host, { name }).value;
const anchors = (host, path) => Object.fromEntries(anchored('read', { paths: [path] }, host).split('\n').slice(1).filter(line => line.includes('|')).map(line => [line.slice(line.indexOf('|') + 1), line.slice(0, line.indexOf('|'))]));
const writes = host => host.calls.filter(call => call.operation === 'workspace.transaction').length;

test('hashline edits apply atomically across files with byte fidelity and fresh anchors', () => {
  const host = workspace({ 'a.txt': 'head\r\n}\r\n  value = "世界"\r\n}\r\ntail', 'b.txt': 'one\ntwo\n' });
  const a = anchors(host, 'a.txt');
  const read = anchored('read', { paths: ['a.txt'] }, host).split('\n');
  const braces = read.filter(line => line.endsWith('|}'));
  assert.equal(new Set(braces.map(line => line.split('|')[0])).size, 2);
  const result = anchored('edit', { files: [
    { path: 'a.txt', edits: [{ op: 'replace', anchor: a['  value = "世界"'], lines: ['  value = 1', '  other = 2'] }, { op: 'delete', anchor: braces[1].split('|')[0] }, { op: 'append', lines: ['end'] }] },
    { path: 'b.txt', edits: [{ op: 'prepend', lines: ['zero'] }, { op: 'insert_after', anchor: anchors(host, 'b.txt').two, lines: ['three'] }] },
  ] }, host);
  assert.equal(result.status, 'applied');
  assert.equal(host.files['a.txt'], 'head\r\n}\r\n  value = 1\r\n  other = 2\r\ntail\r\nend');
  assert.equal(host.files['b.txt'], 'zero\none\ntwo\nthree\n');
  assert.equal(writes(host), 1);
  const fresh = [...result.diff.matchAll(/^\+(\d+#[0-9A-Z]{4})\|(.*)$/gm)];
  assert.deepEqual(fresh.map(match => match[2]), ['  value = 1', '  other = 2', 'end', 'zero', 'three']);
  const current = { ...anchors(host, 'a.txt'), ...anchors(host, 'b.txt') };
  for (const [, anchor, text] of fresh) assert.equal(current[text], anchor);
  assert.match(result.diff, /^-\}$/m);
  assert.match(result.diff, /^ \d+#[0-9A-Z]{4}\|tail$/m);
});

test('only cited lines are verified; drift relocates uniquely and every failure returns before any write', () => {
  const host = workspace({ 'a.txt': 'a\nb\nc\nd\n', 'b.txt': 'x\n}\ny\n}\n' });
  const a = anchors(host, 'a.txt');
  const b = anchors(host, 'b.txt');
  host.files['a.txt'] = 'a\nb\nc\nD\n';
  assert.equal(anchored('edit', { files: [{ path: 'a.txt', edits: [{ op: 'replace', anchor: a.b, lines: ['B'] }] }] }, host).status, 'applied');
  host.files['a.txt'] = 'new\na\nB\nc\nD\n';
  host.files['b.txt'] = 'x\n}\n}\ny\n}\n';
  const stale = anchored('edit', { files: [
    { path: 'a.txt', edits: [{ op: 'replace', anchor: a.c, lines: ['C'] }, { op: 'delete', anchor: '2#ZZZZ' }] },
    { path: 'b.txt', edits: [{ op: 'insert_before', anchor: b.y, lines: ['w'] }, { op: 'delete', anchor: '4#' + b['}'].split('#')[1] }] },
  ] }, host);
  assert.equal(stale.status, 'rejected');
  assert.deepEqual(stale.failures.map(failure => Object.keys(failure).at(-1)), ['moved_to', 'stale', 'moved_to', 'ambiguous']);
  assert.equal(writes(host), 1);
  const retry = anchored('edit', { files: [{ path: 'a.txt', edits: [{ op: 'replace', anchor: stale.failures[0].moved_to, lines: ['C'] }] }] }, host);
  assert.equal(retry.status, 'applied');
  assert.equal(host.files['a.txt'], 'new\na\nB\nC\nD\n');
  const overlap = anchored('edit', { files: [{ path: 'a.txt', edits: [{ op: 'replace', anchor: anchors(host, 'a.txt').a, lines: ['y'] }, { op: 'insert_before', anchor: anchors(host, 'a.txt').a, lines: ['z'] }] }] }, host);
  assert.match(overlap.failures[0].error, /overlapping/);
  assert.equal(writes(host), 2);
});

test('denied, oversized, missing, generated and malformed edits never write', () => {
  const denied = anchored('edit', { files: [{ path: 'a.txt', edits: [{ op: 'append', lines: ['x'] }] }] }, workspace({}, { 'workspace.stat': () => { throw new Error('read_denied'); } }));
  assert.equal(denied.status, 'denied');
  const host = workspace({ 'big.txt': 'x'.repeat(96_001), 'gen.ts': '// @generated\nx\n' });
  assert.deepEqual(anchored('read', { paths: ['big.txt'] }, host), { status: 'rejected', reason: 'files_too_large: 96001 bytes exceeds 96000; use the ordinary patch tool', writes_attempted: false });
  const result = anchored('edit', { files: [{ path: 'gen.ts', edits: [{ op: 'append', lines: ['y'] }] }, { path: 'none.txt', edits: [{ op: 'append', lines: ['y'] }] }] }, host);
  assert.deepEqual(result.failures.map(failure => failure.error.split(';')[0]), ['generated file', 'file missing']);
  for (const edit of [{ op: 'delete', anchor: '1#AAAA', lines: ['x'] }, { op: 'append', anchor: '1#AAAA', lines: ['x'] }, { op: 'replace', anchor: '1#AAAA' }, { op: 'move' }]) assert.equal(anchored('edit', { files: [{ path: 'gen.ts', edits: [edit] }] }, host).status, 'rejected');
  assert.equal(writes(host), 0);
});

test('edits that would exceed the callback receipt budget are rejected before any write, counting JSON escaping', () => {
  const host = workspace({ 'big.txt': 'x'.repeat(70_000), 'small.txt': 'a\n', 'quotes.txt': '"'.repeat(50_000), 'heavy.txt': '"'.repeat(90_000), 'fits.txt': 'x'.repeat(50_000) });
  for (const [path, lines] of [['big.txt', ['z']], ['small.txt', ['y'.repeat(140_000)]], ['quotes.txt', ['z']]]) {
    const result = anchored('edit', { files: [{ path, edits: [{ op: 'append', lines }] }] }, host);
    assert.equal(result.writes_attempted, false);
    assert.match(result.reason, /^edit_too_large: .*use the ordinary patch tool$/);
  }
  assert.match(anchored('read', { paths: ['heavy.txt'] }, host).reason, /^files_too_large: the JSON-encoded contents .*use the ordinary patch tool$/);
  assert.match(anchored('edit', { files: [{ path: 'heavy.txt', edits: [{ op: 'append', lines: ['z'] }] }] }, host).reason, /^files_too_large: the JSON-encoded/);
  assert.equal(writes(host), 0);
  assert.equal(anchored('edit', { files: [{ path: 'fits.txt', edits: [{ op: 'append', lines: ['z'] }] }] }, host).status, 'applied');
  assert.equal(host.files['fits.txt'], `${'x'.repeat(50_000)}\nz`);
});

test('anchored search returns the anchors read would return', () => {
  const text = 'alpha\nbeta\ngamma\ndelta\n';
  const rg = [
    { type: 'begin', data: { path: { text: 'src/a.txt' } } },
    { type: 'context', data: { path: { text: 'src/a.txt' }, line_number: 1, lines: { text: 'alpha\n' } } },
    { type: 'match', data: { path: { text: 'src/a.txt' }, line_number: 2, lines: { text: 'beta\n' } } },
    { type: 'match', data: { path: { text: 'src/a.txt' }, line_number: 4, lines: { text: 'delta\n' } } },
  ].map(line => JSON.stringify(line)).join('\n');
  const host = workspace({ 'src/a.txt': text }, { 'exec.run': call => {
    assert.deepEqual(call.arguments.argv.slice(-4), ['-e', 'ta', '--', 'src']);
    return { exit_code: 0, stdout: rg, stdout_preview_truncated: false, stderr: '' };
  } });
  const found = anchored('search', { pattern: 'ta', path: 'src', context: 1 }, host).split('\n');
  const read = anchors(host, 'src/a.txt');
  assert.deepEqual(found, ['src/a.txt', `${read.alpha}|alpha`, `${read.beta}|beta`, '--', `${read.delta}|delta`]);
  assert.equal(anchored('search', { pattern: 'zzz' }, workspace({}, { 'exec.run': () => ({ exit_code: 1, stdout: '', stderr: '' }) })), 'no matches');
});

test('the anchored edit plugin registers no lifecycle or context callbacks', () => {
  const reply = invoke(null, () => { throw new Error('unexpected call'); }, { event: 'inspect' });
  assert.deepEqual(reply.registrations.events, []);
});
