import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkedSources } from '../scripts/mod_typecheck_inventory.mjs';

test('new shipped JavaScript and TypeScript files fail when no check owns them', () => {
  for (const extension of ['js', 'cjs', 'mjs', 'jsx', 'ts', 'tsx', 'mts', 'cts']) {
    assert.throws(() => checkedSources([`plugins/bundled/new/source.${extension}`], new Map(), new Map()), /shipped_source_not_typechecked/);
  }
});

test('timed render hooks accept measured and missing durations', () => {
  const directory = mkdtempSync(join(tmpdir(), 'omd-mod-types-'));
  try {
    const fixture = join(directory, 'render-duration.mts');
    const api = fileURLToPath(new URL('../mods/api.d.ts', import.meta.url));
    writeFileSync(fixture, `
import type { RenderToolCall } from ${JSON.stringify(api)};
type TimedKind = 'patch' | 'web_search' | 'image';
type Durations = { [Kind in TimedKind]: Extract<RenderToolCall, { kind: Kind }>['duration_ms'][] };
export const durations: Durations = {
  patch: [null, 0, 73],
  web_search: [null, 0, 73],
  image: [null, 0, 73],
};
export function formatDuration(call: Extract<RenderToolCall, { kind: TimedKind }>): string {
  return call.duration_ms === null ? '' : call.duration_ms.toFixed(0);
}
`);
    const compiler = fileURLToPath(new URL('../mods/node_modules/typescript7/bin/tsc', import.meta.url));
    const result = spawnSync(process.execPath, [compiler, '--noEmit', '--strict', '--skipLibCheck',
      '--target', 'ES2022', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', fixture], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stdout + result.stderr);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
