import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkedSources } from '../scripts/mod_typecheck_inventory.mjs';

test('new shipped JavaScript and TypeScript files fail when no check owns them', () => {
  for (const extension of ['js', 'cjs', 'mjs', 'jsx', 'ts', 'tsx', 'mts', 'cts']) {
    assert.throws(() => checkedSources([`plugins/bundled/new/source.${extension}`], new Map(), new Map()), /shipped_source_not_typechecked/);
  }
});
