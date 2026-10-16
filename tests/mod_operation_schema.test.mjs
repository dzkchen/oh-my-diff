import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { operationSchemas, shareSchemas } from '../scripts/mod_operation_schema.mjs';

function generate(text) {
  const directory = mkdtempSync(join(tmpdir(), 'omd-operation-schema-'));
  const source = join(directory, 'api.d.ts');
  try { writeFileSync(source, text); return operationSchemas(source); }
  finally { rmSync(directory, { recursive: true, force: true }); }
}

test('HostOperations schema preserves required fields, alternatives, tuples, intersections and dictionaries', () => {
  const schemas = generate(`
    type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
    interface HostOperations {
      'test.call': {
        arguments: { mode: 'a'; value: [string, number?]; data?: Json } | { mode: 'b'; values: Record<string, number[]> };
        result: { success: true } & { count: number; empty: Record<string, never> };
      };
    }
  `);
  const alternatives = schemas['test.call'].arguments.anyOf;
  assert.deepEqual(alternatives[0].required, ['mode', 'value']);
  assert.deepEqual(alternatives[0].properties.mode, { const: 'a' });
  assert.deepEqual(alternatives[0].properties.data.anyOf.find(part => part.type === 'array'), { type: 'array', items: {} });
  assert.deepEqual(alternatives[0].properties.value, {
    type: 'array', prefixItems: [{ type: 'string' }, { anyOf: [{ type: 'number' }] }], minItems: 1, maxItems: 2,
  });
  assert.deepEqual(alternatives[1].properties.values.additionalProperties, { type: 'array', items: { type: 'number' } });
  assert.deepEqual(schemas['test.call'].result.allOf[0].properties.success, { const: true });
  assert.equal(schemas['test.call'].result.allOf[1].properties.empty.additionalProperties, false);
});

test('unsupported types and broken declarations fail instead of silently accepting arbitrary JSON', () => {
  for (const type of ['any', 'unknown', 'bigint', '() => void', '`prefix${number}`', '[string, ...number[]]', '{ [key: number]: string }']) {
    assert.throws(() => generate(`interface HostOperations { 'bad.call': { arguments: null; result: ${type} } }`), /Unsupported|not JSON/);
  }
  assert.throws(() => generate("type Json = string | number; interface HostOperations { 'bad.call': { arguments: null; result: Json } }"), /Unsupported Json alias/);
  assert.throws(() => generate("interface HostOperations { 'bad.call': { arguments: null; result: MissingType } }"), /MissingType/);
});

test('shared schema definitions preserve every operation and constraint', () => {
  const original = operationSchemas();
  const shared = shareSchemas(original);
  const expand = value => {
    if (Array.isArray(value)) return value.map(expand);
    if (!value || typeof value !== 'object') return value;
    if (value.$ref) return expand(shared.$defs[value.$ref.slice('#/$defs/'.length)]);
    return Object.fromEntries(Object.entries(value).map(([key, member]) => [key, expand(member)]));
  };
  assert.deepEqual(expand(shared.operations), original);
  assert.ok(JSON.stringify(shared).length < JSON.stringify(original).length * 0.85);
  for (const [key, definition] of Object.entries(shared.$defs)) {
    assert.notDeepEqual(definition, { $ref: `#/$defs/${key}` });
  }
});
