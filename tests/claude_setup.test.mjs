import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const bin = process.env.OMD_TEST_BIN_DIR;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

test('Claude setup creates a bounded isolated host store and respects an existing stronger contract', { skip: !bin, timeout: 60000 }, async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'omd-claude-setup-')));
  const prefix = join(root, 'prefix');
  const store = join(root, 'store');
  const repository = join(root, 'repository');
  const node = await realpath(process.execPath);
  const manager = resolve(bin, 'omd-mod');
  const contract = resolve(bin, 'omd-contract');
  const command = (program, args) => {
    const child = spawnSync(program, args, { encoding: 'utf8', timeout: 15000 });
    assert.ifError(child.error);
    assert.equal(child.status, 0, child.stderr);
    return JSON.parse(child.stdout);
  };
  try {
    await mkdir(prefix);
    await mkdir(repository);
    command(manager, ['init', store, node]);
    await mkdir(join(store, 'sources'));
    const packages = {};
    for (const id of ['omd_claude_cli', 'omd_workflow']) {
      const destination = join(store, 'sources', id);
      await cp(resolve('mods/first-party', id), destination, { recursive: true });
      const manifest = JSON.parse(await readFile(join(destination, 'mod.json'), 'utf8'));
      const current = command(manager, ['inspect', destination]);
      packages[id] = { sha256: current.sha256 };
      command(manager, ['trust', store, destination, current.sha256, manifest.capabilities.join(',')]);
      command(manager, ['enable', store, destination]);
    }
    const fake = join(root, 'claude');
    await writeFile(fake, '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "2.1.281 (Claude Code)"; else echo \'{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty","subscriptionType":"pro"}\'; fi\n', { mode: 0o700 });
    const capture = join(root, 'launch.json');
    const binary = join(root, 'codex');
    await writeFile(binary, `#!${node}\nimport {writeFileSync} from 'node:fs';\nwriteFileSync(${JSON.stringify(capture)},JSON.stringify({mode:process.env.OMD_MODE,store:process.env.OMD_MOD_STORE,legacy:process.env.OMD_CONTROLLED_MANIFEST,args:process.argv.slice(2)}));\n`, { mode: 0o700 });
    const record = { profile: 'full', prefix, store, packages, author: { node }, manager: { installed_path: manager },
      binary: { installed_path: binary }, tools: { 'omd-contract': { installed_path: contract, sha256: sha(await readFile(contract)) } } };
    const recordPath = join(prefix, 'install.json');
    await writeFile(recordPath, JSON.stringify(record));
    const before = await readFile(join(store, 'mods.json'), 'utf8');
    const setup = () => spawnSync(node, [join(store, 'sources/omd_claude_cli/setup.mjs'), recordPath, repository, '', fake, '2', 'Keep the exact requested task'],
      { encoding: 'utf8', timeout: 25000, env: { PATH: `${dirname(node)}:/usr/bin:/bin`, HOME: root, USER: 'fixture', OMD_CONTROLLED_MANIFEST: '/ignored-legacy' } });
    const result = setup();
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    const launch = JSON.parse(await readFile(capture, 'utf8'));
    assert.equal(launch.mode, 'omd');
    assert.equal(launch.legacy, undefined);
    assert.notEqual(launch.store, store);
    assert.equal(await readFile(join(store, 'mods.json'), 'utf8'), before);
    const host = JSON.parse(await readFile(join(launch.store, 'host.json'), 'utf8'));
    assert.equal(host.routes.length, 1);
    assert.deepEqual(host.routes[0].roles, ['lead']);
    assert.equal(host.services[0].arguments.at(-1), '2');
    assert.equal(host.limits.requests, 2);
    const taskMods = JSON.parse(await readFile(join(launch.store, 'mods.json'), 'utf8'));
    const workflow = taskMods.mods.find(item => item.path.endsWith('/omd_workflow'));
    assert.equal(workflow.settings.initial_task.objective, 'Keep the exact requested task');
    assert.equal(command(contract, ['status', launch.store, repository]).contract.key, 'solo_evidence@1');
    command(contract, ['select', store, repository, 'reviewed_omd@1']);
    const denied = setup();
    assert.equal(denied.status, 1);
    assert.match(denied.stderr, /resolve_existing_contract_before_solo_task/);
    assert.equal(command(contract, ['status', store, repository]).contract.key, 'reviewed_omd@1');
    assert.equal((await readdir(join(prefix, 'tasks'))).length, 2);
  } finally { await rm(root, { recursive: true, force: true }); }
});
