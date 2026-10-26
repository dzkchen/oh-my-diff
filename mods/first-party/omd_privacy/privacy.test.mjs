import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { callback } from '../../../tests/mod_runner.mjs';

const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
const manifest = JSON.parse(readFileSync(new URL('./mod.json', import.meta.url), 'utf8'));
const defaults = Object.fromEntries(Object.entries(manifest.settings_schema.properties).map(([name, schema]) => [name, schema.default]));
const PLACEHOLDER = /\[REDACTED:([a-z0-9_]+):([a-z2-7]{12,52})\]/g;

const body = (length, seed = 0) => Array.from({ length }, (_, index) => 'aB3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xY3zC8'[(index + seed) % 36]).join('');
const fake = {
  github: (seed = 0) => ['gh', 'p_', body(36, seed)].join(''),
  aws: () => ['AK', 'IA', 'Q3EGRTZ5WX7Y2KJ4'].join(''),
  openai: () => ['sk', '-proj-', body(40, 3)].join(''),
  stripe: () => ['sk', '_live_', body(24, 5)].join(''),
  pem: () => ['-----BEGIN ', 'RSA PRIVATE KEY-----\n', Array.from({ length: 26 }, (_, line) => body(64, line)).join('\n'), '\n-----END RSA PRIVATE KEY-----'].join(''),
  jwt: length => ['ey', 'JhbGciOiJIUzI1NiJ9', '.ey', 'J', body(length, 7), '.', body(43, 9)].join(''),
};

function run(event, name, payload, { state = null, settings = {}, host = call => assert.fail(`unexpected ${call.operation}`) } = {}) {
  const output = callback({ source, filename: 'index.ts', api: manifest.api, capabilities: manifest.capabilities, environment: ['crypto'],
    settings: { ...defaults, ...settings }, state, event, name, payload, hook_budget_ms: manifest.hook_budget_ms }, host);
  if (output.error) throw new Error(output.error);
  return output;
}

const segment = (id, text, extra = {}) => ({ id, kind: 'user.text', role: 'user', editable: true, text, bytes: Buffer.byteLength(text), sha256: '0'.repeat(64), ...extra });

function send(segments, { state = null, settings = {}, inner = [], cache, scope = { thread_id: 'thread-a', agent_id: null, kind: 'main' }, opaque = [], attempt = 1 } = {}) {
  const input = { request_id: 'request', attempt, scope, provider: 'fixture', route: 'lead', model: 'lead', page: 1, pages: 1, cached: 0, segments, opaque };
  const output = run('intercept', '0', { surface: 'model_send', input, original: input, origin: { caller: 'engine' } }, { state, settings, host: call => {
    assert.equal(call.operation, 'continuation.next');
    return { result: { edits: inner, ...(cache === false ? { cache } : {}) }, trace: [] };
  } });
  return { result: output.value.result, state: output.state };
}

function applied(segments, edits) {
  return Object.fromEntries(segments.map(({ id, text }) => [id, edits.filter(edit => edit.segment === id)
    .sort((a, b) => b.start - a.start).reduce((out, edit) => out.slice(0, edit.start) + edit.text + out.slice(edit.end), text)]));
}

test('redacts supported secrets in editable text with stable opaque placeholders and keeps inner edits', () => {
  const token = fake.github();
  const segments = [
    segment('/input/0/content/0/text', `export GITHUB_TOKEN=${token} and key ${fake.aws()}`),
    segment('/input/1/output', `${fake.pem()}\nstripe ${fake.stripe()}`, { kind: 'tool_output', role: 'tool' }),
    segment('/input/2/arguments', JSON.stringify({ cmd: `curl -H 'Authorization: Bearer ${body(32, 2)}' https://deploy:hunter2pw@ci.internal/x` }), { kind: 'tool_call.arguments', role: 'assistant' }),
    segment('/instructions', `Use ${fake.openai()} for the model and ${token} again`, { kind: 'instructions', role: 'system' }),
    segment('/input/3/content/0/text', 'other policy text', { kind: 'message.developer', role: 'developer' }),
  ];
  const inner = [{ segment: '/input/3/content/0/text', start: 0, end: 5, text: 'OTHER' }];
  const { result, state } = send(segments, { inner, cache: false });
  assert.equal(result.cache, false);
  assert.deepEqual(result.edits[0], inner[0]);
  const out = applied(segments, result.edits);
  for (const secret of [token, fake.aws(), fake.stripe(), fake.openai(), body(32, 2), 'hunter2pw', body(64, 3)]) {
    assert.ok(!Object.values(out).some(text => text.includes(secret)), secret.slice(0, 8));
  }
  assert.deepEqual(JSON.parse(out['/input/2/arguments']).cmd.match(/\[REDACTED:([a-z_]+):/g), ['[REDACTED:bearer_token:', '[REDACTED:url_credentials:']);
  assert.match(out['/input/1/output'], /^\[REDACTED:private_key:[a-z2-7]{12}\]\nstripe \[REDACTED:stripe_key:[a-z2-7]{12}\]$/);
  const ids = text => [...text.matchAll(PLACEHOLDER)].map(match => match[2]);
  const [first] = ids(out['/input/0/content/0/text']);
  assert.equal(ids(out['/instructions'])[1], first);
  assert.equal(out['/input/3/content/0/text'], 'OTHER policy text');
  assert.ok(!JSON.stringify(state).includes(token.slice(4)) && !JSON.stringify(state).includes('hunter2pw'));

  const later = send([segment('/input/9/content/0/text', `retrying with ${token}`)], { state });
  assert.equal(ids(applied([segment('/input/9/content/0/text', `retrying with ${token}`)], later.result.edits)['/input/9/content/0/text'])[0], first);
  const other = send([segment('/input/9/content/0/text', token)], { state, scope: { thread_id: 'thread-b', agent_id: null, kind: 'main' } });
  assert.notEqual(other.result.edits[0].text, later.result.edits[0].text);
});

test('quoted values with spaces or symbols and escaped JSON quotes are redacted without breaking tool-call JSON', () => {
  const nested = JSON.stringify({ cmd: `echo '${JSON.stringify({ password: 'hunter2xyz' })}' > conf.json` });
  const segments = [
    segment('/s', 'password = "Xk9&mP2(qL" and secret: \'my pass 9word\''),
    segment('/input/1/arguments', nested, { kind: 'tool_call.arguments', role: 'assistant' }),
    segment('/b', 'curl -H "Authorization: Basic dXNlcjpwYXNzd29yZDEyMw=="'),
  ];
  const out = applied(segments, send(segments).result.edits);
  assert.equal(out['/s'].replace(PLACEHOLDER, 'X').replace(PLACEHOLDER, 'X'), 'password = "X" and secret: \'X\'');
  assert.match(JSON.parse(out['/input/1/arguments']).cmd, /^echo '\{\\?"password\\?":\\?"\[REDACTED:assigned_secret:[a-z2-7]{12}\]\\?"\}' > conf\.json$/);
  assert.match(out['/b'], /Basic \[REDACTED:bearer_token:/);
  const value = 'a3f9c2d8e1b74f60';
  const forms = [`x-api-key: ${value}`, `--api-key=${value}`, `secret-key=${value}`, `--access-key=${value}`, `private-key: ${value}`]
    .map((text, index) => segment(`/h${index}`, `curl ${text} done`));
  for (const [id, text] of Object.entries(applied(forms, send(forms).result.edits))) assert.match(text, /^curl \S+[:=] ?\[REDACTED:assigned_secret:[a-z2-7]{12}\] done$/, id);
});

test('more findings than one page takes edits for are merged into fewer edits with the same result', () => {
  const text = Array.from({ length: 300 }, (_, index) => `user${index}@gmail.com logged in`).join('\n');
  const segments = [segment('/input/0/output', text, { kind: 'tool_output', role: 'tool' })];
  const inner = [{ segment: '/input/0/output', start: 0, end: 4, text: 'USER' }];
  const { result, state } = send(segments, { settings: { pii: ['email'] }, inner });
  assert.ok(result.edits.length <= 256);
  assert.ok(result.edits.every(edit => Buffer.byteLength(edit.text) <= 4096));
  assert.deepEqual(result.edits[0], inner[0]);
  const out = applied(segments, result.edits)['/input/0/output'];
  assert.ok(!/@gmail\.com/.test(out));
  assert.equal(out.split('\n').length, 300);
  assert.match(out, /^USER\[REDACTED:email:[a-z2-7]{12}\] logged in\n\[REDACTED:email:/);
  assert.equal(state.counts.email, 300);
});

function pieces(text, cuts) {
  const bounds = [0, ...cuts, text.length];
  return bounds.slice(0, -1).map((offset, index) => {
    const end = bounds[index + 1];
    return segment('/input/0/output', text.slice(offset, end), { kind: 'tool_output', role: 'tool', bytes: text.length,
      offset, before: text.slice(Math.max(0, offset - 1024), offset), after: text.slice(end, end + 1024) });
  });
}

test('secrets split across request pieces are fully redacted with one placeholder each', () => {
  const filler = length => Array.from({ length }, (_, index) => `line ${index} of ordinary build output`).join('\n').slice(0, length);
  const token = fake.github(4);
  const key = fake.pem();
  const long = fake.jwt(3000);
  const text = `${filler(5000)} ${token} ${filler(5000)}\n${key}\n${filler(5000)} ${long} ${filler(3000)}`;
  const at = value => text.indexOf(value);
  const cuts = [at(token) + 20, at(key) + 900, at(long) + 1800];
  let state = null;
  const edits = [];
  for (const piece of pieces(text, cuts)) {
    const sent = send([piece], { state });
    state = sent.state;
    edits.push(...sent.result.edits.map(edit => ({ ...edit, start: edit.start + piece.offset, end: edit.end + piece.offset })));
  }
  const out = applied([segment('/input/0/output', text)], edits)['/input/0/output'];
  assert.deepEqual([...out.matchAll(PLACEHOLDER)].map(match => match[1]), ['github_token', 'private_key', 'jwt']);
  assert.equal(out.replace(PLACEHOLDER, 'X'), `${filler(5000)} X ${filler(5000)}\nX\n${filler(5000)} X ${filler(3000)}`);
});

test('refuses what it cannot redact: protected kinds, requested unscanned content, malformed pages and broken JSON', () => {
  const token = fake.github(2);
  const reasoning = send([segment('/input/0/summary/0/text', `thinking about ${token}`, { kind: 'reasoning', role: 'assistant', editable: false })]);
  assert.match(reasoning.result.deny, /github_token in reasoning/);
  assert.ok(!reasoning.result.deny.includes(token.slice(4)));
  assert.equal(reasoning.state.denied, 1);
  const image = { id: '/input/0/content/1/image_url', kind: 'image_url' };
  const encrypted = { id: '/input/1/encrypted_content', kind: 'encrypted_content' };
  assert.match(send([], { opaque: [encrypted, image], settings: { unscanned: 'deny' } }).result.deny, /unscanned image_url/);
  assert.deepEqual(send([], { opaque: [encrypted], settings: { unscanned: 'deny' } }).result, { edits: [] });
  assert.deepEqual(send([], { opaque: [image] }).result, { edits: [] });
  assert.match(send([{ id: '/x', kind: 'user.text', role: 'user', editable: true }]).result.deny, /malformed request page/);
  const truncated = JSON.stringify({ key: '-----BEGIN RSA PRIVATE KEY-----' });
  assert.match(send([segment('/input/0/arguments', truncated, { kind: 'tool_call.arguments', role: 'assistant' })]).result.deny, /would break tool-call JSON/);
});

test('sensitive path policy asks before shell reads, ignores case, covers parent directories and globs, and honours exemptions and modes', () => {
  const approval = (command, settings = {}, kind = 'exec', details = { command, cwd: '/repo' }) => run('approval', '', { id: 'a', kind, thread_id: 't',
    turn_id: null, agent_id: null, host_decision: 'skip', policy: 'on-request', details, assessment: false }, { settings }).value;
  assert.match(approval(null, {}, 'stdin', { tool: 'write_stdin', process_id: 3, input: 'cat ~/.ssh/id_rsa\n', cwd: '/repo' }).ask, /id_rsa\*/);
  assert.equal(approval(null, {}, 'stdin', { tool: 'write_stdin', process_id: 3, input: 'y\n', cwd: '/repo' }), null);
  assert.match(approval(null, {}, 'stdin', { tool: 'write_stdin', process_id: 3, cwd: '/repo', truncated: true }).ask, /too large/);
  assert.match(approval(['bash', '-lc', 'cat .env']).ask, /sensitive path \(\.env\)/);
  assert.match(approval(['bash', '-lc', 'grep -r key ~/.ssh']).ask, /\.ssh\//);
  assert.match(approval('cat ./config/.env.local').ask, /\.env\.\*/);
  assert.match(approval(['cat', '/home/me/.aws/credentials']).ask, /\.aws\/credentials/);
  for (const command of ['cat .env.example', 'cat ~/.ssh/id_ed25519.pub', 'ls src', 'cat environment.md']) assert.equal(approval(['bash', '-lc', command]), null, command);
  assert.equal(approval(['cat', '.env'], {}, 'patch'), null);
  assert.match(approval(['cat', 'server.pem'], { paths: 'deny' }).deny, /\*\.pem/);
  assert.equal(approval(['cat', '.env'], { paths: 'off' }), null);
  assert.equal(approval(['cat', 'local.env'], { exempt: ['path:local.env'], sensitive_paths: ['*.env'] }), null);
  for (const command of ['cat .ENV', 'cat ID_RSA', 'cat ~/.AWS/Credentials', 'cat ~/.aws/*', 'cat ~/.aws/cred*', 'cat ~/.kube/c*', 'grep -r key ~/.aws',
    'grep -r token ~/.kube/', 'cat .env*', 'cat id_r*', 'cat *.pe?', 'cat ~/.config/gh/hosts.yml', 'cat .e*', 'cat ~/.docker/config.js?n', 'cat .env{,.local}', 'cat .[e]nv', 'cat ~/.ssh/id_{rsa,ed25519}', 'cat ~/.aws/[c]redentials', 'cat {.env,x}', 'cat ~/{.aws,.ssh}/credentials',
    'cat .e{n,x,a,b,c,d,e,f,g}{v,w,x,y,z,a,b,c}', `cat .e${'?'.repeat(9)}`, `cat .${'e'.repeat(260)}*`,
    'git show HEAD:.env', 'cat .?nv', 'cat .aws//credentials', 'cat ~/.aws/./credentials', 'cat ~/.aws/x/../credentials', "cat .e''nv", 'cat ".e"nv', 'cat .e\\nv', 'cat .env///',
    `cat {.env,${'abcdefghijklmnopqr'.split('').join(',')}}`, 'cat .e{n..n}v']) {
    assert.match(approval(['bash', '-lc', command])?.ask ?? '', /sensitive path/, command);
  }
  for (const command of ['ls ~/.config', 'cat *', 'ls *.md', 'cat ~/src/c*', 'grep -r key --include=*.json src', 'cat ~/.kube-notes.md',
    'mkdir -p ~/.docker/cli-plugins', 'ls ~/.kube/cache', 'cat ~/.aws/config', "sed 's/foo/.*/' f", 'grep -E ".*" f', 'find . -name ".*"', 'ls -la .*', 'echo {a,b}', 'ls [z-a]', 'ls [^]', `cat ${'*'.repeat(60)}z`,
    'git show HEAD:src/index.ts', 'cat src//a.ts ./b.ts', "echo 'hi' \"there\"", 'find . -exec cat {} +', "awk '{print $1}' f", 'ls .?', 'cat *.ts', 'ls src/*']) {
    assert.equal(approval(['bash', '-lc', command]), null, command);
  }
  const started = Date.now();
  assert.equal(approval(`cat ${'/'.repeat(80000)}x`), null);
  assert.ok(Date.now() - started < 1000);
});
