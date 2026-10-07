import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

test('author packaging preserves custom entrypoints, assets and lifecycle scripts and inspects the output', () => {
  const root = mkdtempSync(join(tmpdir(), 'omd-author-package-'));
  try {
    const api = JSON.parse(readFileSync(new URL('../mods/package.json', import.meta.url))).version;
    const manifest = { schema: 1, id: 'fixture', version: '1.0.0', api, state_version: 1, capabilities: [], entrypoint: 'src/main.ts', assets: ['assets/data.json'], lifecycle: { install: 'scripts/install.ts' } };
    for (const directory of ['src', 'assets', 'scripts']) mkdirSync(join(root, directory));
    writeFileSync(join(root, 'mod.json'), JSON.stringify(manifest));
    writeFileSync(join(root, 'src/main.ts'), 'export default () => {};');
    writeFileSync(join(root, 'assets/data.json'), '{"value":1}');
    writeFileSync(join(root, 'scripts/install.ts'), 'export default () => {};');
    const engine = join(root, 'inspect.mjs');
    writeFileSync(engine, `#!${process.execPath}\nimport { readFileSync, appendFileSync } from 'node:fs';\nimport { join } from 'node:path';\nimport { createHash } from 'node:crypto';\nconst directory = process.argv[3];\nconst manifest = JSON.parse(readFileSync(join(directory, 'mod.json')));\nconst hash = createHash('sha256');\nfor (const path of ['mod.json', manifest.entrypoint, ...manifest.assets, ...Object.values(manifest.lifecycle)]) hash.update(readFileSync(join(directory, path)));\nappendFileSync(${JSON.stringify(join(root, 'inspections'))}, directory + '\\n');\nconsole.log(JSON.stringify({ manifest, sha256: hash.digest('hex') }));\n`);
    chmodSync(engine, 0o700);
    const result = spawnSync(process.execPath, [new URL('../mods/author/cli.mjs', import.meta.url).pathname, 'package', root], { encoding: 'utf8', env: { ...process.env, OMD_MOD_BIN: process.env.OMD_MOD_BIN ?? engine } });
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    for (const path of [manifest.entrypoint, ...manifest.assets, ...Object.values(manifest.lifecycle)]) assert.equal(readFileSync(join(report.package, path), 'utf8'), readFileSync(join(root, path), 'utf8'));
    if (!process.env.OMD_MOD_BIN) assert.ok(readFileSync(join(root, 'inspections'), 'utf8').trim().split('\n').includes(report.package));
    assert.equal(JSON.parse(readFileSync(join(report.package, 'package-report.json'))).sha256, report.sha256);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
