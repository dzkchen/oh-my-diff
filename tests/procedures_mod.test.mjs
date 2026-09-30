import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const runner = readFileSync(new URL('../runtime/omd/src/mods/runner.mjs', import.meta.url), 'utf8');
const component = new URL('../plugins/optional/plugins/omd-procedures/mod/', import.meta.url);
const source = readFileSync(new URL('index.ts', component), 'utf8');
const manifest = JSON.parse(readFileSync(new URL('mod.json', component), 'utf8'));
const surface = { events: {}, replacements: [], middleware: [], state: 'store', contracts: 'contracts' };
const digest = text => createHash('sha256').update(text).digest('hex');
let task = null;
const market = 'omd-procedures/.agents/plugins/marketplace.json';
const completed = {
  status: 'completed', objective: 'Release version 2.4.0 of the parser', acceptance_criteria: ['CHANGELOG.md lists 2.4.0', 'pnpm test passes'],
  acceptance: { reference: 'a', sha256: 'a'.repeat(64) }, failed_hypotheses: ['Tagging before the changelog broke the release check'],
  completed_acceptance: { candidate_sha256: 'c'.repeat(64), evidence: { reference: 'e', sha256: 'e'.repeat(64) } }, contract: { active: { id: 'reviewed_omd' } },
};
const draft = { name: 'release', description: 'Release: bump a parser version', inputs: [{ name: 'version', description: 'Version to release', example: '2.4.0' }],
  checkpoints: ['Update CHANGELOG.md', 'Run the release check'], worker_guidance: '', recovery: ['If the check fails, fix the changelog first'] };

function workspace(files = {}) {
  const store = {};
  const directories = new Set(Object.keys(files).map(path => path.slice(0, path.lastIndexOf('/'))));
  const host = ({ operation, arguments: args }) => {
    if (operation === 'mods.service') {
      if (!task) throw new Error('begin_task_first');
      return task;
    }
    if (operation === 'store.get') return store[args.key] ?? null;
    if (operation === 'store.put') {
      assert.equal(args.expected_revision, store[args.key]?.revision ?? null);
      store[args.key] = { value: args.value, revision: (store[args.key]?.revision ?? 0) + 1 };
      return { revision: store[args.key].revision };
    }
    if (operation === 'store.list') return { keys: Object.keys(store).filter(key => key.startsWith(args.prefix)).map(key => ({ key })), cursor: null };
    if (operation === 'exec.run') {
      assert.deepEqual([args.program, args.argv[0], args.write], ['mkdir', '-p', true]);
      args.argv.slice(1).forEach(path => directories.add(path));
      return { exit_code: 0, stdout: '', stderr: '' };
    }
    if (operation === 'workspace.read') return { files: Object.fromEntries(args.paths.map(path => [path, path in files ? { text: files[path], sha256: digest(files[path]) } : null])) };
    assert.equal(operation, 'workspace.transaction');
    for (const [path, hash] of Object.entries(args.expected)) assert.equal(path in files ? digest(files[path]) : null, hash);
    for (const path of Object.keys(args.writes)) assert.ok(directories.has(path.slice(0, path.lastIndexOf('/'))), `missing directory for ${path}`);
    Object.assign(files, args.writes);
    return { files: Object.fromEntries(Object.keys(args.writes).map(path => [path, digest(files[path])])) };
  };
  const invoke = (event, name, payload) => {
    const receipts = [];
    for (;;) {
      const request = { source, filename: 'index.ts', api: manifest.api, capabilities: manifest.capabilities, state: null, settings: {}, event, name, payload, receipts, surface, hook_budget_ms: 5000 };
      const output = JSON.parse(spawnSync(process.execPath, ['--no-warnings', '--experimental-vm-modules', '--input-type=module', '--eval', runner],
        { input: JSON.stringify(request), encoding: 'utf8', timeout: 10000 }).stdout);
      assert.equal(output.error, undefined, output.error);
      if (!output.host_call) return event === 'command' ? output.value.display : output.value;
      try { receipts.push({ call: output.host_call, value: host(output.host_call) }); } catch (error) { receipts.push({ call: output.host_call, error: error.message }); }
    }
  };
  return { files, draft: payload => invoke('tool', 'draft', payload), promote: name => invoke('command', 'promote', name), list: () => invoke('command', 'list', '') };
}

test('procedure drafts come only from a completed workflow task and template declared inputs', () => {
  const repo = workspace();
  task = null;
  assert.equal(repo.draft(draft).error, 'completed_workflow_task_required');
  task = { ...completed, status: 'active' };
  assert.equal(repo.draft(draft).error, 'completed_workflow_task_required');
  task = completed;
  assert.deepEqual(repo.draft({ ...draft, inputs: [{ ...draft.inputs[0], example: '9.9.9' }] }), { error: 'input_example_not_in_task', input: 'version' });
  task = { ...completed, contract: { active: { id: 'solo_evidence' } } };
  assert.equal(repo.draft({ ...draft, worker_guidance: 'Delegate the changelog' }).error, 'solo_contract_disallows_workers');
  task = completed;
  const drafted = repo.draft(draft).draft;
  assert.equal(drafted.objective, 'Release version {{version}} of the parser');
  assert.deepEqual(drafted.acceptance_criteria, ['CHANGELOG.md lists {{version}}', 'pnpm test passes']);
  assert.deepEqual(drafted.failed_hypotheses, completed.failed_hypotheses);
  assert.equal(repo.files[market], undefined);
});

test('promotion writes pinned skill plugins, never reuses a version and refuses foreign names', () => {
  const repo = workspace({ [market]: JSON.stringify({ name: 'team', plugins: [{ name: 'docs', source: { source: 'local', path: './vendor/docs' } }] }) });
  const skill = 'omd-procedures/release/skills/release/SKILL.md';
  const plugin = 'omd-procedures/release/.codex-plugin/plugin.json';
  task = completed;
  assert.match(repo.promote('release'), /No valid draft/);
  repo.draft(draft);
  assert.match(repo.promote('release'), /Promoted release 1\.0\.0[\s\S]*codex plugin add release@team/);
  assert.deepEqual(JSON.parse(repo.files[market]).plugins.map(entry => entry.name), ['docs', 'release']);
  assert.equal(JSON.parse(repo.files[plugin]).version, '1.0.0');
  assert.match(repo.files[skill], /^---\nname: release\ndescription: "Release: bump a parser version"\n---/);
  assert.match(repo.files[skill], /\[procedure release@1\.0\.0\] Release version \{\{version\}\} of the parser/);
  assert.match(repo.files[skill], /Failed in the source task: Tagging before the changelog/);
  assert.match(repo.files[skill], /None\. Complete the task without child agents\./);
  assert.match(repo.promote('release'), /Promoted release 1\.1\.0/);
  assert.equal(repo.list(), 'release 1.1.0: ok\nDrafts: release');
  repo.files[skill] += 'edited';
  delete repo.files[plugin];
  assert.match(repo.list(), /^release 1\.1\.0: release\/\.codex-plugin\/plugin\.json changed or missing; release\/skills\/release\/SKILL\.md changed or missing\. Re-promote/);
  assert.match(repo.promote('release'), /Promoted release 1\.2\.0/);
  assert.match(repo.list(), /^release 1\.2\.0: ok/);
  repo.draft({ ...draft, name: 'docs' });
  assert.match(repo.promote('docs'), /already listed .* with another source/);
  repo.files['omd-procedures/theirs/.codex-plugin/plugin.json'] = JSON.stringify({ name: 'theirs', version: '3.0.0' });
  repo.draft({ ...draft, name: 'theirs' });
  assert.match(repo.promote('theirs'), /did not promote/);
  repo.files[market] = '{';
  assert.match(repo.promote('release'), /not a valid marketplace/);
  assert.match(repo.promote('omd-release'), /Usage/);
});
