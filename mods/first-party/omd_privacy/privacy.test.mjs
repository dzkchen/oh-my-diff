import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { callback } from '../../../tests/mod_runner.mjs';

const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
const manifest = JSON.parse(readFileSync(new URL('./mod.json', import.meta.url), 'utf8'));
const defaults = Object.fromEntries(Object.entries(manifest.settings_schema.properties).map(([name, schema]) => [name, schema.default]));
const PII = ['email', 'phone', 'ipv4', 'ipv6', 'card', 'us_ssn'];
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

test('a secret partly replaced by an inner policy is redacted around that edit without overlapping it', () => {
  const token = fake.github(9);
  const segments = [segment('/s', `key ${token} end`)];
  const inner = [{ segment: '/s', start: 14, end: 24, text: 'MID' }];
  const { result } = send(segments, { inner });
  const own = result.edits.slice(1);
  assert.ok(own.every(edit => edit.end <= 14 || edit.start >= 24));
  assert.match(applied(segments, result.edits)['/s'], /^key \[REDACTED:github_token:[a-z2-7]{12}\]MID end$/);
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
});

test('a placeholder inside a finding redacts the rest of it instead of dropping it', () => {
  const key = fake.pem().replace(body(64, 4), '[REDACTED:assigned_secret:abcdefghijkl]');
  const segments = [segment('/s', `key:\n${key}\nend`)];
  const out = applied(segments, send(segments).result.edits)['/s'];
  assert.match(out, /^key:\n\[REDACTED:private_key:[a-z2-7]{12}\]\[REDACTED:assigned_secret:abcdefghijkl\]\nend$/);
  assert.deepEqual(send([segment('/s', out)]).result.edits, []);
});

test('AGENTS.md and environment context are scanned in the context scope, not the prompt scope', () => {
  const token = fake.github(3);
  const segments = [
    segment('/input/0/content/0/text', `# AGENTS.md instructions\nuse ${token}`, { kind: 'agents_md.instructions' }),
    segment('/input/0/content/1/text', `<environment_context>${token}</environment_context>`, { kind: 'environments.environment_context' }),
    segment('/input/1/content/0/text', `prompt ${token}`),
  ];
  const { result } = send(segments, { settings: { scopes: ['context', 'tools'] } });
  assert.deepEqual(result.edits.map(edit => edit.segment), ['/input/0/content/0/text', '/input/0/content/1/text']);
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

test('leaves lookalikes, references, placeholders and reserved examples alone', () => {
  const clean = [
    ['AK', 'IAIOSFODNN7EXAMPLE'].join(''), ['gh', 'p_', 'x'.repeat(36)].join(''), 'pip install scikit-learn; sk-learn docs',
    'max_tokens = 128000', 'password: string;', 'const token = getToken();', 'secret = process.env.SECRET', 'api_key: ${API_KEY}',
    'password = this.config.password', 'tokenizer = AutoTokenizer.from_pretrained(name)', 'std::vector<int> at 12:30:45 on aa:bb:cc:dd:ee:ff',
    'token = [REDACTED:assigned_secret:abcdefghijkl]', 'Bearer authentication is described below', 'use a basic aarch64-unknown-linux-gnu build',
    'password: "Enter your password, then press Continue."', 'admin@example.com and 192.168.1.1',
  ];
  const segments = clean.map((text, index) => segment(`/input/${index}/content/0/text`, text));
  assert.deepEqual(send(segments).result.edits, []);
  assert.deepEqual(send(segments.slice(-2), { settings: { pii: PII } }).result.edits, []);
});

test('selected PII rules redact real-domain emails, compressed IPv6 and Luhn cards but not reserved or private values', () => {
  const detected = ['john@gmail.com', 'admin@example.com.evil.io', '2606:4700:4700::1111', '2001:4860:4860::8888', '::ffff:8.8.8.8', '8.8.8.8',
    '(415) 867-5309', '+44 7700 900123', '4539 1488 0343 6467', '371449635398431', '123-45-6789'];
  const clean = ['alice@example.com', 'ops@mail.example.org', 'dev@build.test', '::1', 'fe80::1', '2001:db8::1', 'fc00::5', '127.0.0.1', '10.0.0.1',
    '192.0.2.4', '12:30:45', 'aa:bb:cc:dd:ee:ff', 'ab::cd', 'std::vector', '4242 4242 4242 4242', '1696600000000', '(415) 555-0123', '000-12-3456'];
  for (const text of detected) {
    const { result } = send([segment('/s', `value ${text} end`)], { settings: { pii: PII } });
    assert.equal(result.edits.length, 1, text);
    assert.equal(applied([segment('/s', `value ${text} end`)], result.edits)['/s'].replace(PLACEHOLDER, 'X'), 'value X end', text);
    assert.deepEqual(send([segment('/s', `value ${text} end`)]).result.edits, [], `${text} without PII selected`);
  }
  for (const text of clean) assert.deepEqual(send([segment('/s', `value ${text} end`)], { settings: { pii: PII } }).result.edits, [], text);
  assert.deepEqual(send([segment('/s', 'mail ops@corp.dev')], { settings: { pii: ['email'], exempt: ['domain:corp.dev'] } }).result.edits, []);
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
  assert.match(reasoning.result.deny, /^omd_privacy: github_token in reasoning text, which cannot be redacted \(placeholder [a-z2-7]{12}\)/);
  assert.ok(!reasoning.result.deny.includes(token.slice(4)));
  assert.equal(reasoning.state.denied, 1);
  const image = { id: '/input/0/content/1/image_url', kind: 'image_url' };
  const encrypted = { id: '/input/1/encrypted_content', kind: 'encrypted_content' };
  assert.match(send([], { opaque: [encrypted, image], settings: { unscanned: 'deny' } }).result.deny, /unscanned image_url content/);
  assert.deepEqual(send([], { opaque: [encrypted], settings: { unscanned: 'deny' } }).result, { edits: [] });
  assert.deepEqual(send([], { opaque: [image] }).result, { edits: [] });
  assert.match(send([{ id: '/x', kind: 'user.text', role: 'user', editable: true }]).result.deny, /malformed request page/);
  const truncated = JSON.stringify({ key: '-----BEGIN RSA PRIVATE KEY-----' });
  assert.match(send([segment('/input/0/arguments', truncated, { kind: 'tool_call.arguments', role: 'assistant' })]).result.deny, /would break tool-call JSON/);
});

test('reviewed exemptions recover from a false alert by placeholder or by value', () => {
  const text = 'deploy_token: "build-cache-42"';
  const flagged = send([segment('/s', text)]);
  const [, , id] = PLACEHOLDER.exec(flagged.result.edits[0].text) ?? [];
  PLACEHOLDER.lastIndex = 0;
  const writes = [];
  const host = call => {
    assert.equal(call.operation, 'settings.write');
    writes.push(call.arguments.values.exempt);
    return { settings: call.arguments.values };
  };
  assert.match(run('command', 'privacy', `allow ${id}`, { state: flagged.state, host }).value.display, /^Exempt \(sha256:[0-9a-f]{16}\)/);
  assert.match(run('command', 'privacy', 'allow build-cache-42', { state: flagged.state, host }).value.display, /^Exempt/);
  assert.equal(writes[0].at(-1), writes[1].at(-1));
  assert.deepEqual(writes[0].slice(0, -1), defaults.exempt);
  assert.deepEqual(send([segment('/s', text)], { state: flagged.state, settings: { exempt: writes[0] } }).result.edits, []);
  assert.match(run('command', 'privacy', 'allow [REDACTED:jwt:aaaaaaaaaaaa]', { state: flagged.state }).value.display, /^Unknown placeholder/);
  assert.match(run('command', 'privacy', 'forget', { state: flagged.state }).value.display, /^Usage: \/privacy/);
});

test('placeholder ids are collision checked against earlier fingerprints', () => {
  const token = fake.github(6);
  const first = send([segment('/s', token)]);
  const [, id] = /\[REDACTED:[a-z_]+:([a-z2-7]+)\]/.exec(first.result.edits[0].text);
  const collided = { ...first.state, ids: { [id]: 'ffffffffffffffff' } };
  const second = send([segment('/s', token)], { state: collided });
  const [, longer] = /\[REDACTED:[a-z_]+:([a-z2-7]+)\]/.exec(second.result.edits[0].text);
  assert.equal(longer.length, 16);
  assert.ok(longer.startsWith(id));
  assert.equal(second.state.ids[id], 'ffffffffffffffff');
});

test('worker, internal and retried requests are redacted the same way', () => {
  const token = fake.github(8);
  const internal = { thread_id: null, agent_id: null, kind: 'internal' };
  const once = send([segment('/s', `title for ${token}`)], { scope: internal });
  const again = send([segment('/s', `title for ${token}`)], { scope: internal, state: once.state, attempt: 2 });
  assert.equal(again.result.edits[0].text, once.result.edits[0].text);
  const worker = send([segment('/s', `COMPLETE ${token}`)], { scope: { thread_id: 'agent-thread', agent_id: 'agent-1', kind: 'subagent' }, state: once.state });
  assert.match(worker.result.edits[0].text, /^\[REDACTED:github_token:/);
});

test('sensitive path policy asks before shell reads and honours exemptions and modes', () => {
  const approval = (command, settings = {}, kind = 'exec', details = { command, cwd: '/repo' }) => run('approval', '', { id: 'a', kind, thread_id: 't',
    turn_id: null, agent_id: null, host_decision: 'skip', policy: 'on-request', details, assessment: false }, { settings }).value;
  assert.match(approval(null, {}, 'stdin', { tool: 'write_stdin', process_id: 3, input: 'cat ~/.ssh/id_rsa\n', cwd: '/repo' }).ask, /id_rsa\*/);
  assert.equal(approval(null, {}, 'stdin', { tool: 'write_stdin', process_id: 3, input: 'y\n', cwd: '/repo' }), null);
  assert.match(approval(null, {}, 'stdin', { tool: 'write_stdin', process_id: 3, cwd: '/repo', truncated: true }).ask, /too large to check/);
  assert.match(approval(null, {}, 'execve', { tool: 'execve', program: '/bin/cat', argv: ['cat', 'id_ed25519'], command: ['/bin/cat', 'id_ed25519'], cwd: '/home/me/.ssh' }).ask,
    /id_ed25519\*/);
  assert.match(approval(['bash', '-lc', 'cat .env']).ask, /sensitive path \(\.env\)/);
  assert.match(approval(['bash', '-lc', 'grep -r key ~/.ssh']).ask, /\.ssh\//);
  assert.match(approval('cat ./config/.env.local').ask, /\.env\.\*/);
  assert.match(approval(['cat', '/home/me/.aws/credentials']).ask, /\.aws\/credentials/);
  for (const command of ['cat .env.example', 'cat ~/.ssh/id_ed25519.pub', 'ls src', 'cat environment.md']) assert.equal(approval(['bash', '-lc', command]), null, command);
  assert.equal(approval(['cat', '.env'], {}, 'patch'), null);
  assert.match(approval(['cat', 'server.pem'], { paths: 'deny' }).deny, /\*\.pem/);
  assert.equal(approval(['cat', '.env'], { paths: 'off' }), null);
  assert.equal(approval(['cat', 'local.env'], { exempt: ['path:local.env'], sensitive_paths: ['*.env'] }), null);
});

test('status separates model-bound redaction from terminal display and keeps only categories and counts', () => {
  const { state } = send([segment('/s', `${fake.github()} and ${fake.aws()}`)]);
  const display = run('command', 'privacy', '', { state, settings: { pii: ['email', 'bogus'] } }).value.display;
  assert.match(display, /Terminal display: unchanged; the screen, transcript, rollout and resume data keep the originals\./);
  assert.match(display, /PII rules: email\nUnknown rules ignored: bogus/);
  assert.match(display, /Redacted: github_token 1, aws_access_key 1 · denied 0 · last: redacted 2 \(main\)/);
  assert.match(display, /Placeholders: 2 known/);
  assert.deepEqual(Object.keys(state).sort(), ['counts', 'ids', 'last', 'salt']);
});

test('a full request page with every rule enabled redacts every match', () => {
  const chunk = `${fake.github()} mail john@gmail.com at 8.8.8.8 password="hunter2pw" ${'ordinary output text '.repeat(80)}\n`;
  const segments = Array.from({ length: 6 }, (_, index) => segment(`/input/${index}/output`, chunk.repeat(9), { kind: 'tool_output', role: 'tool' }));
  assert.ok(segments.reduce((sum, item) => sum + item.bytes, 0) > 90_000);
  const { result } = send(segments, { settings: { pii: PII } });
  assert.equal(result.edits.length, 6 * 9 * 4);
});
