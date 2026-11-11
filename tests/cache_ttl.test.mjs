import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { OPENAI_LONG_TTL_MS, OPENAI_TTL_MS, cacheLifetime } from '../mods/first-party/omd_idle_compact/cache_ttl.ts';

const MODS = ['omd_idle_compact', 'omd_observation_mask', 'omd_usage'];
const MINUTE = 60_000;
const AT = 1_800_000_000_000;

test('the cache-TTL helper is the same file in every mod that ships it', () => {
  const [first, ...rest] = MODS.map(mod => readFileSync(new URL(`../mods/first-party/${mod}/cache_ttl.ts`, import.meta.url)));
  for (const [index, copy] of rest.entries()) assert.ok(copy.equals(first), `${MODS[index + 1]}/cache_ttl.ts differs from ${MODS[0]}/cache_ttl.ts`);
  for (const mod of MODS) assert.ok(JSON.parse(readFileSync(new URL(`../mods/first-party/${mod}/mod.json`, import.meta.url))).assets.includes('cache_ttl.ts'), mod);
});

const response = (patch = {}) => ({ provider: 'openai', route: 'session', credential: 'key', requested_model: 'gpt-6.1-sol', served_model: 'gpt-6.1-sol',
  usage: {}, cache: { read_tokens: 0, write_tokens: 0 }, cost: { basis: 'settled' }, ...patch });
const lifetime = (patch, minutes = 0, previous = null) => cacheLifetime(response(patch), minutes, AT, previous);

test('OpenAI API responses with cache activity get 30 minutes, and nothing else does', () => {
  assert.equal(lifetime({ cache: { read_tokens: 1, write_tokens: 0 } }).ttl, OPENAI_TTL_MS);
  assert.equal(lifetime({ cache: { read_tokens: 0, write_tokens: 1 } }).expires, AT + OPENAI_TTL_MS);
  assert.equal(lifetime({}).ttl, 0);
  assert.equal(lifetime({ provider: 'anthropic', cache: { read_tokens: 1, write_tokens: 1 } }).ttl, 0);
});

test('OpenAI subscription and unpriced responses are skipped, local providers always, and an explicit lifetime overrides all but local', () => {
  const active = { cache: { read_tokens: 1, write_tokens: 0 } };
  for (const basis of ['included_subscription', 'unpriced']) {
    assert.equal(lifetime({ ...active, cost: { basis } }).ttl, 0);
    assert.equal(lifetime({ ...active, cost: { basis } }, 10).ttl, 10 * MINUTE);
  }
  assert.equal(lifetime({ ...active, provider: 'ollama' }, 10).ttl, 0);
  assert.equal(lifetime({ provider: 'anthropic' }, 5).ttl, 5 * MINUTE);
});

test('a provider-reported lifetime wins and later reads keep it for the same identity only', () => {
  const reported = lifetime({ provider: 'anthropic', usage: { omd_cache_ttl_seconds: 3600 } });
  assert.deepEqual([reported.ttl, reported.reported], [3600_000, true]);
  assert.equal(lifetime({ provider: 'anthropic', usage: { omd_cache_ttl_seconds: -1 } }).ttl, 0);
  const read = { provider: 'anthropic', cache: { read_tokens: 5, write_tokens: 0 } };
  assert.equal(lifetime(read, 0, reported).ttl, 3600_000);
  assert.equal(lifetime({ ...read, credential: 'other' }, 0, reported).ttl, 0);
  assert.equal(lifetime({ ...read, cache: { read_tokens: 0, write_tokens: 0 } }, 0, reported).ttl, 0);
});

test('the OpenAI 12-hour cache expires from its write, and a read only extends it to 30 minutes ahead', () => {
  const read = { cache: { read_tokens: 1, write_tokens: 0 } };
  const first = lifetime(read, 720);
  assert.equal(first.ttl, OPENAI_LONG_TTL_MS);
  assert.equal(first.expires, AT + OPENAI_TTL_MS);
  const written = { ...first, expires: AT - MINUTE + OPENAI_LONG_TTL_MS };
  assert.equal(lifetime(read, 720, written).expires, written.expires);
  assert.equal(lifetime(read, 720, { ...written, expires: AT }).expires, AT + OPENAI_TTL_MS);
  assert.equal(lifetime({ cache: { read_tokens: 0, write_tokens: 1 } }, 720).expires, AT + OPENAI_LONG_TTL_MS);
  assert.equal(lifetime({ ...read, provider: 'anthropic' }, 720).expires, AT + OPENAI_LONG_TTL_MS);
});
