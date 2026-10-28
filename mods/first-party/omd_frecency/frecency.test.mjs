import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { callback } from '../../../tests/mod_runner.mjs';

const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
const manifest = JSON.parse(readFileSync(new URL('./mod.json', import.meta.url), 'utf8'));

function run(event, payload, host, name = '', state = null, now = undefined) {
  const request = { source, filename: 'index.ts', api: manifest.api, capabilities: manifest.capabilities, state, settings: {}, event, name, payload, hook_budget_ms: 2000, virtual_time_ms: now };
  const receipts = [];
  const output = callback(request, host, receipts, { capture: error => error.host === true });
  if (output.error) throw new Error(output.error);
  return { value: output.value, calls: output.calls, state: output.state, receipts };
}

const branch = (oid = 'c0ffee', head = 'main') => `# branch.oid ${oid}\0# branch.head ${head}\0`;
const modified = path => `1 .M N... 100644 100644 100644 0000000 0000000 ${path}\0`;
const commits = (...lists) => lists.map(paths => `/${paths.length ? `\n${paths.join('\0')}\0` : ''}`).join('\0');

function repository(files, status, { log = () => '', mtimes = {}, prefix = '' } = {}) {
  const writes = [];
  const store = {};
  const logs = [];
  let execs = 0;
  const host = ({ operation, arguments: args }) => {
    if (operation === 'store.get' && args.key === 'status') return store.status ?? null;
    if (operation === 'store.get') return files && { value: files, revision: 3, provenance: {} };
    if (operation === 'store.put') {
      assert.ok(Buffer.byteLength(JSON.stringify(args.value)) <= 65_536, 'store_value_limit');
      if (args.key === 'status') return store.status = { value: args.value, revision: (store.status?.revision ?? 0) + 1, provenance: {} }, { revision: store.status.revision };
      assert.equal(args.expected_revision, files ? 3 : null);
      return writes.push(args.value), { revision: 4 };
    }
    if (operation === 'exec.run') {
      execs++;
      const limit = args.max_output_bytes ?? Infinity;
      const output = args.argv.includes('log') ? (logs.push(args.argv), log(args.argv)) : args.argv[0] === 'rev-parse' ? `${prefix}\n` : typeof status === 'function' ? status() : status;
      return { exit_code: 0, stdout: Buffer.from(output).subarray(0, limit).toString(), stdout_truncated: Buffer.byteLength(output) > limit, stderr: '' };
    }
    if (operation === 'workspace.stat') return { files: Object.fromEntries(args.paths.map(path => [path, path.startsWith('old/') ? null : { kind: 'file', size: 1, mtime_ms: mtimes[path] ?? 0 }])) };
    throw new Error(operation);
  };
  return { host, writes, logs, execs: () => execs };
}

test('a failed existence check keeps history entries instead of hiding them', () => {
  const { host, writes } = repository({ tick: 10, files: { 'notes/plan.md': [5, 10] } }, '');
  const failing = call => {
    if (call.operation === 'workspace.stat') throw Object.assign(new Error('workspace_stat_failed'), { host: true });
    return host(call);
  };
  assert.deepEqual(run('completion', { kind: 'mention', query: 'plan', candidates: [] }, failing).value.items, [{ path: 'notes/plan.md' }]);
  assert.deepEqual(writes, []);
});

test('ranking a full history beside a large Git status keeps every host call inside the receipt budget', () => {
  const entries = prefix => Array.from({ length: 70 }, (_, index) => `${prefix}/${'a'.repeat(200)}${index}.ts`);
  const files = { tick: 10, files: Object.fromEntries([...entries('old').map(path => [path, [5, 10]]), ...entries('keep').map(path => [path, [1, 10]])]) };
  assert.ok(Buffer.byteLength(JSON.stringify(files)) <= 32_000);
  const untracked = Array.from({ length: 3000 }, (_, index) => `? untracked/file${index}.ts\0`).join('');
  const dirty = Array.from({ length: 20 }, (_, index) => modified(`src/${'d'.repeat(150)}${index}.ts`)).join('');
  let oid = 1;
  const log = () => commits(...Array.from({ length: 64 }, (_, commit) => Array.from({ length: 20 }, (_, index) => `lib/${'r'.repeat(120)}${commit}-${index}.ts`)));
  const { host, writes } = repository(files, () => branch(String(oid)) + dirty + untracked, { log });
  const pruned = {};
  for (const [name, now, refresh, log] of [['cold', 1e12, true, true], ['cached', 1e12 + 1_000, false, false], ['expired', 1e12 + 40_000, true, false], ['moved', 1e12 + 80_000, true, true]]) {
    if (name === 'moved') oid++;
    const before = writes.length;
    const { value, receipts } = run('completion', { kind: 'mention', query: '', candidates: [] }, host, '', null, now);
    assert.deepEqual(receipts.filter(receipt => 'error' in receipt), []);
    assert.equal(receipts.some(receipt => receipt.call.operation === 'exec.run'), refresh);
    assert.equal(receipts.some(receipt => receipt.call.arguments.argv?.includes('log')), log);
    assert.equal(value.items.length, 50);
    assert.equal(writes.length, before + 1);
    pruned[name] = 70 - Object.keys(writes.at(-1).files).filter(path => path.startsWith('old/')).length;
  }
  assert.equal(pruned.cached, 70);
  assert.ok(pruned.cold > 0 && pruned.cold < 70, 'a refresh spends receipts on Git, so it checks only part of the history');
});

test('mention queries typed within the cache window reuse one Git status', () => {
  const { host, execs } = repository(null, branch() + modified('src/parser.ts'));
  const query = (now, text) => callback({ source, filename: 'index.ts', api: manifest.api, capabilities: manifest.capabilities, state: null, settings: {},
    event: 'completion', name: '', payload: { kind: 'mention', query: text, candidates: [{ path: 'src/lexer.ts' }] }, hook_budget_ms: 2000, virtual_time_ms: now }, host).value.items;
  assert.deepEqual(query(1_000, 'p'), [{ path: 'src/parser.ts' }, { path: 'src/lexer.ts' }]);
  assert.deepEqual(query(2_000, 'pa'), [{ path: 'src/parser.ts' }, { path: 'src/lexer.ts' }]);
  assert.equal(execs(), 3);
  query(40_000, 'par');
  assert.equal(execs(), 4);
});

for (const [label, component, count] of [['Unicode', '雪'.repeat(60), 100], ['JSON escaping', '\\'.repeat(120), 64]]) {
  test(`learning trims serialized UTF-8 storage bytes for ${label}`, () => {
    const path = index => `${component}/${component.slice(0, label === 'Unicode' ? 40 : 120)}${String(index).padStart(3, '0')}.ts`;
    const files = { tick: 0, files: Object.fromEntries(Array.from({ length: count }, (_, index) => [path(index), [1, 0]])) };
    const initialBytes = Buffer.byteLength(JSON.stringify(files));
    assert.ok(initialBytes > 30_000 && initialBytes <= 32_000);
    const tokens = Array.from({ length: 16 }, (_, index) => path(count + index));
    const queued = run('intercept', { surface: 'input', input: { text: tokens.join(' '), attachments: 0 }, origin: { caller: 'user' } },
      call => ({ result: { text: call.arguments.input.text }, trace: [] }), '0').state;
    assert.deepEqual(queued, tokens);
    assert.ok(Buffer.byteLength(JSON.stringify({ tick: 1, files: { ...files.files, ...Object.fromEntries(tokens.map(path => [path, [1, 1]])) } })) > 32_000);
    const { host, writes } = repository(files, tokens.join('\0') + '\0');
    const learned = run('turn_start', { turn_id: 'unicode' }, host, '', queued);
    assert.equal(learned.state, null);
    assert.equal(writes.length, 1);
    assert.ok(Buffer.byteLength(JSON.stringify(writes[0])) < 32_000);
    assert.equal(writes[0].tick, 1);
    for (const path of tokens) assert.deepEqual(writes[0].files[path], [1, 1]);
    const retained = Object.keys(writes[0].files);
    const old = retained.filter(name => !tokens.includes(name));
    assert.deepEqual(old, Array.from({ length: old.length }, (_, index) => path(index)));
  });
}

const mention = (host, query, paths, now = 1_000_000_000) => run('completion', { kind: 'mention', query, candidates: paths.map(path => ({ path })) }, host, '', null, now).value.items.map(item => item.path);

test('an exact file name outranks a longer name it prefixes', () => {
  const { host } = repository(null, branch());
  assert.deepEqual(mention(host, 'parser', ['src/parser_utils.ts', 'lib/parser.ts']), ['lib/parser.ts', 'src/parser_utils.ts']);
  assert.deepEqual(mention(host, 'parser.ts', ['src/parser.tsx', 'lib/parser.ts']), ['lib/parser.ts', 'src/parser.tsx']);
});

test('recently modified dirty files outrank older dirty files', () => {
  const now = 1_000_000_000;
  const { host } = repository(null, branch() + modified('src/old.ts') + modified('src/new.ts'), { mtimes: { 'src/old.ts': now - 2 * 86_400_000, 'src/new.ts': now - 60_000 } });
  assert.deepEqual(mention(host, 'src', [], now), ['src/new.ts', 'src/old.ts']);
});

test('files from the branch\'s own recent commits rank higher, skipping huge commits, and the log reruns only when HEAD moves', () => {
  let oid = 'a1';
  const huge = Array.from({ length: 51 }, (_, index) => `src/bulk${index}.ts`);
  const { host, logs } = repository(null, () => branch(oid, 'feat'), { log: argv => argv.includes('--not') ? commits(huge, ['src/feature.ts']) : '' });
  const candidates = ['src/bulk1.ts', 'src/other.ts', 'src/feature.ts'];
  assert.deepEqual(mention(host, 'src', candidates, 1_000), ['src/feature.ts', 'src/bulk1.ts', 'src/other.ts']);
  assert.ok(logs[0].includes('--glob=refs/remotes/origin/HEA[D]'));
  mention(host, 'src', candidates, 40_000);
  assert.equal(logs.length, 1);
  oid = 'b2';
  mention(host, 'src', candidates, 80_000);
  assert.equal(logs.length, 2);
});

test('a branch without commits of its own, or the default branch, ranks by plain HEAD history', () => {
  const { host, logs } = repository(null, branch('a1', 'fresh'), { log: argv => argv.includes('--not') ? '' : commits(['src/feature.ts']) });
  assert.deepEqual(mention(host, 'src', ['src/other.ts', 'src/feature.ts']), ['src/feature.ts', 'src/other.ts']);
  assert.deepEqual(logs.map(argv => argv.includes('--not')), [true, false]);
  const main = repository(null, branch('a1', 'main'), { log: () => commits(['src/feature.ts']) });
  mention(main.host, 'src', ['src/other.ts', 'src/feature.ts']);
  assert.deepEqual(main.logs.map(argv => argv.includes('--not')), [false]);
});

test('names with tabs, newlines and spaces parse from NUL-separated Git output, limited to the session folder', () => {
  const status = branch('a1', 'main') + modified('sub/ta\tb.ts') + '2 R. N... 100644 100644 100644 0000000 0000000 R100 sub/new name.ts\0sub/old.ts\0' + '? top.ts\0';
  const { host, logs } = repository(null, status, { prefix: 'sub/', log: () => commits(['nl\nc.ts', 'ta\tb.ts'], []) });
  assert.deepEqual(mention(host, '', ['other.ts', 'nl\nc.ts']), ['ta\tb.ts', 'new name.ts', 'nl\nc.ts', 'other.ts']);
  assert.ok(logs[0].includes('-z'));
});

test('boosts stop at 50, so a typo match never passes an exact name', () => {
  const now = 1_000_000_000;
  const files = { tick: 100, files: { 'src/parsre.ts': [1000, 100] } };
  const { host } = repository(files, branch('a1', 'feat') + modified('src/parsre.ts'), { mtimes: { 'src/parsre.ts': now }, log: () => commits(['src/parsre.ts'], ['src/parsre.ts'], ['src/parsre.ts']) });
  assert.deepEqual(mention(host, 'parser', ['src/parsre.ts', 'lib/parser.ts'], now), ['lib/parser.ts', 'src/parsre.ts']);
});

test('status records parse by kind: renames skip their original, conflicts keep spaces, deletions and a cut last record drop', () => {
  const pad = rest => `# pad ${'x'.repeat(12_000 - 6 - branch().length - 7 - rest)}\0? abcdefgh.ts\0`;
  for (const [records, expected] of [
    ['2 R. N... 100644 100644 100644 0000000 0000000 R100 new.ts\0? x.ts\0', ['new.ts']],
    ['u UU N... 100644 100644 100644 100644 h1 h2 h3 both name.ts\0', ['both name.ts']],
    ['1 .D N... 100644 100644 000000 0000000 0000000 gone.ts\0' + '1 D. N... 100644 000000 000000 0000000 0000000 staged.ts\0', []],
    [pad(0), []],
  ]) assert.deepEqual(mention(repository(null, branch() + records).host, '', []), expected);
});

test('recent commits skip empty ones and a cut last commit, and a truncated log reads past it once', () => {
  const paged = list => argv => commits(...list.slice(Number(argv.find(arg => arg.startsWith('--skip=')).slice(7))));
  const pad = Array.from({ length: 40 }, (_, index) => `pad/${'p'.repeat(125)}${index}.ts`);
  for (const list of [
    [Array.from({ length: 200 }, (_, index) => `bulk/${'b'.repeat(40)}${index}.ts`), ['src/feature.ts']],
    [pad, ['cut.ts', 'z'.repeat(1000)], ['src/feature.ts']],
    [...Array.from({ length: 10 }, () => []), ['src/feature.ts']],
  ]) {
    const { host, logs } = repository(null, branch(), { log: paged(list) });
    assert.deepEqual(mention(host, '', ['src/other.ts', 'cut.ts', 'src/feature.ts']), ['src/feature.ts', 'src/other.ts', 'cut.ts']);
    assert.ok(logs.length <= 2);
  }
});
